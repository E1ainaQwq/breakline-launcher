import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * LittleSkin（Yggdrasil）登录。
 *
 * <h2>为什么这个模块必须存在</h2>
 * `authlib-injector` 只是把游戏的认证链**改道**到皮肤站，它不负责登录。
 * 真正的登录是启动器的责任：拿账号密码向皮肤站的 Yggdrasil 端点换一组
 * `accessToken / clientToken / selectedProfile(uuid, name)`，再把**真实值**填进
 * `--accessToken / --uuid / --username`。少了这一步，游戏启动后是"未登录"状态，
 * 皮肤不生效（而运维明确要求**保留 LittleSkin 登录**）。
 *
 * <h2>端点（Yggdrasil 规范，与官方认证服务器同构）</h2>
 *  - 认证：  POST {api}/authserver/authenticate
 *  - 刷新：  POST {api}/authserver/refresh
 *  - 校验：  POST {api}/authserver/validate
 *  - 登出：  POST {api}/authserver/invalidate
 *  - 元数据：GET  {api}/  （含 skinDomains 与签名公钥）
 *
 * <h2>安全纪律</h2>
 * 1. **密码不落盘、不进日志**：只在内存里活到换取 token 为止。
 * 2. token 落盘（`auth.json`，权限按当前用户），但**不写进日志**。
 * 3. 不把 `clientToken` 当作可泄露的东西到处传：它由本机生成一次并复用。
 */

export interface YggdrasilSession {
  api: string
  username: string
  uuid: string
  accessToken: string
  clientToken: string
  /** 上次登录/刷新时间（毫秒），用于判断是否需要刷新。 */
  refreshedAt: number
}

export interface AuthResult {
  ok: boolean
  session?: YggdrasilSession
  error?: string
}

/** 皮肤站 API 根地址。留成常量便于换成别的皮肤站或自建 Yggdrasil。 */
export const DEFAULT_YGGDRASIL_API = 'https://littleskin.cn/api/yggdrasil'

function uuidUndashed(uuid: string): string {
  return uuid.replace(/-/g, '')
}

export class YggdrasilAuth {
  constructor(private readonly storePath: string) {}

  /** 读缓存（没有或损坏都返回 null，绝不抛）。 */
  load(): YggdrasilSession | null {
    try {
      if (!existsSync(this.storePath)) return null
      const s = JSON.parse(readFileSync(this.storePath, 'utf8')) as YggdrasilSession
      if (!s?.accessToken || !s?.clientToken) return null
      return s
    } catch {
      return null
    }
  }

  private save(session: YggdrasilSession): void {
    const dir = dirname(this.storePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.storePath, JSON.stringify(session, null, 2), 'utf8')
  }

  /**
   * 账号密码登录。
   *
   * 注意：**只能由玩家主动触发**（UI 里点"登录"），不做任何自动重试——
   * 密码错误的自动重试会把账号打到风控上。
   */
  async login(username: string, password: string, api = DEFAULT_YGGDRASIL_API): Promise<AuthResult> {
    const clientToken = this.load()?.clientToken ?? cryptoRandomToken()
    try {
      const res = await fetch(`${api}/authserver/authenticate`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          clientToken,
          agent: { name: 'Minecraft', version: 1 },
          requestUser: false
        })
      })
      const body = (await res.json()) as {
        accessToken?: string
        clientToken?: string
        selectedProfile?: { id: string; name: string }
        availableProfiles?: { id: string; name: string }[]
        errorMessage?: string
      }
      if (!res.ok) {
        return { ok: false, error: body.errorMessage ?? `登录失败（HTTP ${res.status}）` }
      }
      if (!body.accessToken) return { ok: false, error: body.errorMessage ?? 'LittleSkin 返回的登录信息不完整，请稍后重试' }
      if (!body.selectedProfile) {
        if (Array.isArray(body.availableProfiles) && body.availableProfiles.length === 0) {
          return { ok: false, error: '账号下没有可用角色，请先前往 LittleSkin 创建角色后重试' }
        }
        return { ok: false, error: '尚未选择游戏角色，请使用 LittleSkin 角色名代替邮箱登录' }
      }
      const session: YggdrasilSession = {
        api,
        username: body.selectedProfile.name,
        uuid: uuidUndashed(body.selectedProfile.id),
        accessToken: body.accessToken,
        clientToken: body.clientToken ?? clientToken,
        refreshedAt: Date.now()
      }
      this.save(session)
      return { ok: true, session }
    } catch (e) {
      return { ok: false, error: `无法连接皮肤站：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * 刷新 token。
   *
   * 为什么需要：Yggdrasil 的 accessToken 会过期，而玩家不会每次都重新输密码。
   * 启动前若发现缓存较旧就先刷新；刷新失败（比如改了密码）则回报"需要重新登录"，
   * **不要静默用旧 token**——那样表现是"进了游戏但皮肤没生效"，很难查。
   */
  async refresh(session: YggdrasilSession): Promise<AuthResult> {
    try {
      const res = await fetch(`${session.api}/authserver/refresh`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: session.accessToken,
          clientToken: session.clientToken,
          requestUser: false
        })
      })
      const body = (await res.json()) as {
        accessToken?: string
        clientToken?: string
        selectedProfile?: { id: string; name: string }
        errorMessage?: string
      }
      if (!res.ok || !body.accessToken) {
        return { ok: false, error: body.errorMessage ?? '登录已过期，需要重新登录' }
      }
      const next: YggdrasilSession = {
        ...session,
        accessToken: body.accessToken,
        clientToken: body.clientToken ?? session.clientToken,
        username: body.selectedProfile?.name ?? session.username,
        uuid: body.selectedProfile ? uuidUndashed(body.selectedProfile.id) : session.uuid,
        refreshedAt: Date.now()
      }
      this.save(next)
      return { ok: true, session: next }
    } catch (e) {
      return { ok: false, error: `刷新失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 退出登录：删掉本地 token 缓存。删不掉也不影响使用（下次登录覆盖）。 */
  logout(): void {
    try {
      if (existsSync(this.storePath)) rmSync(this.storePath)
    } catch {
      // 静默：这是一个"尽力而为"的清理动作
    }
  }

  /**
   * 拿到"可用的会话"：优先缓存，必要时刷新。
   * 返回 null 表示**需要玩家重新登录**（不是错误，是正常状态）。
   */
  async ensureFresh(maxAgeMs = 12 * 60 * 60 * 1000): Promise<YggdrasilSession | null> {
    const cached = this.load()
    if (!cached) return null
    if (Date.now() - cached.refreshedAt < maxAgeMs) return cached
    const r = await this.refresh(cached)
    return r.ok && r.session ? r.session : null
  }
}

/** 生成 clientToken。用 crypto 而不是 Math.random——它会被服务端当作会话标识。 */
function cryptoRandomToken(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
