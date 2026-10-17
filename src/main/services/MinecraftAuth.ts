import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * 正版（微软）登录：OAuth 2.0 **设备码流程**（第 4 项）。
 *
 * <h2>为什么是设备码而不是"启动器内嵌浏览器登录"</h2>
 * 设备码流程专门为"没有浏览器 / 输入受限"的设备设计，对桌面启动器有一个决定性优点：
 * **玩家在系统浏览器里输密码，启动器全程只看到一串短码**。
 * 内嵌浏览器（`BrowserWindow` 打开微软登录页）会让我们**经手玩家的微软密码**——
 * 那是绝对不该发生的事（而且微软也会因此判定为不安全的应用）。
 *
 * <h2>完整链条（五步，缺一步都拿不到能进游戏的凭据）</h2>
 * ```
 * ① POST login.microsoftonline.com/consumers/oauth2/v2.0/devicecode   → user_code + device_code
 * ② 轮询 .../token（grant_type=urn:ietf:params:oauth:grant-type:device_code）
 * ③ POST user.auth.xboxlive.com/user/authenticate        → Xbox Live Token
 * ④ POST xsts.auth.xboxlive.com/xsts/authorize           → XSTS Token + UHS
 * ⑤ POST api.minecraftservices.com/authentication/login_with_xbox → Minecraft accessToken
 *    GET  api.minecraftservices.com/minecraft/profile     → uuid + name（**权威身份**）
 * ```
 * ③④⑤ 常被写成一步，但它们各自会**独立失败**，且失败原因对玩家完全不同：
 * - ③ 失败：账号本身有问题
 * - ④ 失败：**没有 Xbox 档案 / 未成年账号 / 地区不支持**（`XErr` 2148916233 等）
 * - ⑤ 失败：**没买 Minecraft**（404）
 * 所以每一步都要单独报错，把"你没买游戏"和"网络超时"分开——
 * 否则玩家会拿着"登录失败"这四个字来问，而我们也答不上来。
 *
 * <h2>client_id 必须自己注册</h2>
 * 微软要求每个应用有 client_id。启动器内置本项目已获批的 client_id：
 * 拿别人的 client_id 去用是冒用（别人随时可以吊销，而且违反微软条款）。
 * 所以这里从配置/环境变量读，没配就明确告诉玩家"还没配置正版登录"，
 * 而不是让他对着一个永远转圈的按钮等。
 */

export interface DeviceCodeSession {
  deviceCode: string
  userCode: string
  /** 玩家要打开的地址（微软给的 verification_uri） */
  verificationUri: string
  /** 轮询间隔（秒，微软指定，必须遵守——太快会被限流） */
  interval: number
  /** 过期时间（毫秒时间戳） */
  expiresAt: number
  message?: string
}

export interface MinecraftProfile {
  uuid: string
  name: string
}

export interface StoredMinecraftAuth {
  clientId: string
  accessToken: string
  refreshToken?: string
  profile: MinecraftProfile
  savedAt: number
}

export type PremiumState =
  | { state: 'none' }
  | { state: 'pending'; session: DeviceCodeSession }
  | { state: 'ok'; profile: MinecraftProfile }
  | { state: 'error'; error: string }

/**
 * **可以交给界面/renderer 的状态**：与 `PremiumState` 的唯一区别是
 * `pending` 里**不含 `deviceCode`**。
 *
 * 为什么必须分成两个类型：`device_code` 是轮询凭据 —— 谁拿到它，
 * 谁就能替这个玩家把 token 领走。它没有任何理由离开主进程，
 * 而"顺手把整个 state 发给界面"是最容易发生的一类泄露。
 * 用类型把它挡在边界上，比靠记性可靠。
 */
export type PremiumPublicState =
  | { state: 'none' }
  | { state: 'pending'; session: Omit<DeviceCodeSession, 'deviceCode'> }
  | { state: 'ok'; profile: MinecraftProfile }
  | { state: 'error'; error: string }

/** 把内部状态收敛成可外发的形状（**去掉 deviceCode**）。 */
export function toPublicState(s: PremiumState): PremiumPublicState {
  if (s.state !== 'pending') return s
  const { deviceCode: _drop, ...rest } = s.session
  return { state: 'pending', session: rest }
}

/** 公开的客户端 ID 配置入口（Azure 应用注册里的"应用程序(客户端) ID"）。 */
export const DEFAULT_CLIENT_ID = '319f82ca-6a54-46ac-a703-59e26cc350b3'

/**
 * 离线模式服务器会用的 UUID（**实测本项目就是这种**）。
 *
 * 算法就是原版 `UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))`
 * —— version 3（MD5）变体。这里自己算，是为了能在**启动器里就说清楚**
 * "你进游戏后实际是什么 UUID"，而不是让运维事后去日志里翻。
 *
 * ⚠️ 大小写敏感：原版按角色名**原样**拼。微软档案给的名字大小写就是游戏里的名字，
 * 所以直接用即可；但**不要**自己 toLowerCase —— 那会算出另一个 UUID。
 *
 * 用 Node 内置 crypto 的 md5 实现 v3 名称 UUID（与 Java 的 nameUUIDFromBytes 等价）。
 */
export function offlineUuid(name: string): string {
  const h = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  // 按 RFC 4122 version 3：把版本与变体位覆盖掉
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  return h.toString('hex')
}

const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

/** XSTS 错误码 → 人话。这些码是玩家最常遇到、也最容易被误报成"我们的锅"的几种。 */
export function xstsErrorText(xerr: number | string | undefined): string {
  switch (String(xerr)) {
    case '2148916233':
      return '这个微软账号还没有 Xbox 档案：请先去 xbox.com 创建一次档案，再回来登录'
    case '2148916235':
      return '这个微软账号所在地区不支持 Xbox Live'
    case '2148916236':
    case '2148916237':
      return '这个微软账号需要先完成成人验证（未成年账号受家庭安全限制）'
    case '2148916238':
      return '这是未成年账号，需要由家庭组里的成年人先把它加入家庭'
    case '2148916227':
      return '这个微软账号已被 Microsoft 封禁'
    default:
      return `Xbox 认证失败（XErr=${xerr ?? '未知'}）`
  }
}

export class MinecraftAuth {
  private pending: DeviceCodeSession | null = null
  private stored: StoredMinecraftAuth | null = null
  private lastError = ''
  private generation = 0
  private polling: Promise<PremiumState> | null = null
  private controller = new AbortController()

  constructor(
    private readonly storePath: string,
    /** 允许测试注入（默认官方端点）。 */
    private readonly endpoints = {
      deviceCode: DEVICE_CODE_URL,
      token: TOKEN_URL,
      xbl: XBL_URL,
      xsts: XSTS_URL,
      mcLogin: MC_LOGIN_URL,
      mcProfile: MC_PROFILE_URL
    },
    private readonly cipher?: { encrypt(value: string): string; decrypt(value: string): string }
  ) {
    this.stored = this.load()
  }

  private load(): StoredMinecraftAuth | null {
    try {
      if (!existsSync(this.storePath)) return null
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      const s = (raw?.encrypted ? JSON.parse(this.cipher!.decrypt(raw.encrypted)) : raw) as StoredMinecraftAuth
      if (!s?.accessToken || !s?.profile?.uuid) return null
      return s
    } catch {
      return null
    }
  }

  private save(s: StoredMinecraftAuth | null): void {
    this.stored = s
    try {
      if (s === null) {
        if (existsSync(this.storePath)) rmSync(this.storePath)
        return
      }
      const dir = dirname(this.storePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data = JSON.stringify(s)
      writeFileSync(this.storePath, this.cipher ? JSON.stringify({ encrypted: this.cipher.encrypt(data) }) : data, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 落盘失败不该让登录失败：本次会话里内存中的凭据仍然可用
    }
  }

  state(): PremiumState {
    if (this.pending) return { state: 'pending', session: this.pending }
    if (this.lastError) return { state: 'error', error: this.lastError }
    if (this.stored) return { state: 'ok', profile: this.stored.profile }
    return { state: 'none' }
  }

  /** 给启动参数用的凭据（`--accessToken/--uuid/--username` 填真值）。 */
  credentials(): { accessToken: string; uuid: string; username: string } | null {
    if (!this.stored) return null
    return {
      accessToken: this.stored.accessToken,
      uuid: this.stored.profile.uuid.replace(/-/g, ''),
      username: this.stored.profile.name
    }
  }

  logout(): void {
    this.generation++
    this.controller.abort()
    this.controller = new AbortController()
    this.polling = null
    this.save(null)
    this.pending = null
    this.lastError = ''
  }

  /**
   * 第一步：申请设备码。返回给界面的只有 `userCode` 与要打开的网址，
   * **`deviceCode` 不外传**（它是轮询凭据，泄露等于让别人替我们领 token）。
   */
  async start(clientId: string): Promise<{ ok: true; session: DeviceCodeSession } | { ok: false; error: string }> {
    if (!clientId) {
      return { ok: false, error: '还没有配置正版登录（缺微软 client_id）：请让管理员在 config/launch.json 里填上' }
    }
    this.lastError = ''
    this.generation++
    const generation = this.generation
    this.controller.abort()
    this.controller = new AbortController()
    this.pending = null
    this.polling = null
    this.save(null)
    try {
      const res = await fetch(this.endpoints.deviceCode, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope: 'XboxLive.signin offline_access' })
      })
      const body = (await res.json()) as {
        device_code?: string
        user_code?: string
        verification_uri?: string
        expires_in?: number
        interval?: number
        message?: string
        error?: string
        error_description?: string
      }
      if (!res.ok || !body.device_code || !body.user_code) {
        const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`
        return { ok: false, error: `申请登录码失败：${detail}` }
      }
      const session: DeviceCodeSession = {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri ?? 'https://microsoft.com/link',
        interval: Math.max(3, body.interval ?? 5),
        expiresAt: Date.now() + (body.expires_in ?? 900) * 1000,
        message: body.message
      }
      const verification = new URL(session.verificationUri)
      if (verification.protocol !== 'https:' || !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'].includes(verification.hostname)) throw new Error('微软登录地址无效')
      if (generation !== this.generation) return { ok: false, error: '登录已取消' }
      this.pending = session
      return { ok: true, session }
    } catch (e) {
      return { ok: false, error: `连不上微软登录服务：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * 二～五步：轮询 + 换 Xbox → XSTS → Minecraft → 档案。
   *
   * 轮询纪律：**严格按微软给的 interval**（默认 5 秒）。太快会被判定为滥用并拒绝，
   * 症状是"一直显示等待授权"但玩家其实早就点过同意了。
   * `authorization_pending` 是**正常**状态，不是错误。
   */
  async poll(clientId: string, maxWaitMs = 300000): Promise<PremiumState> {
    if (this.polling) return this.polling
    const generation = this.generation
    const polling = this.pollOnce(clientId, maxWaitMs, generation)
    this.polling = polling
    try { return await polling } finally { if (this.polling === polling) this.polling = null }
  }

  private async pollOnce(clientId: string, maxWaitMs: number, generation: number): Promise<PremiumState> {
    const s = this.pending
    if (!s) return this.state()
    const deadline = Math.min(s.expiresAt, Date.now() + maxWaitMs)
    for (;;) {
      if (Date.now() > deadline) {
        this.pending = null
        this.lastError = '登录码已过期，请重新获取'
        return this.state()
      }
        await new Promise((r) => setTimeout(r, s.interval * 1000))
        if (generation !== this.generation) return { state: 'none' }
        if (Date.now() > deadline) {
          this.pending = null
          this.lastError = '登录码已过期，请重新获取'
          return this.state()
        }
      try {
        const res = await fetch(this.endpoints.token, {
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: s.deviceCode
          })
        })
        const body = (await res.json()) as {
          access_token?: string
          refresh_token?: string
          error?: string
          error_description?: string
        }
        if (body.error === 'authorization_pending') continue // 正常：玩家还没点同意
        if (body.error === 'slow_down') {
          s.interval += 5 // 微软要求退避
          continue
        }
        if (body.error === 'expired_token' || body.error === 'code_expired') {
          this.pending = null
          this.lastError = '登录码已过期，请重新获取'
          return this.state()
        }
        if (!res.ok || !body.access_token) {
          this.pending = null
          this.lastError = `微软登录失败：${body.error_description ?? body.error ?? `HTTP ${res.status}`}`
          return this.state()
        }
        if (generation !== this.generation) return { state: 'none' }
        // 拿到微软 token → 走完 ③④⑤
        const chain = await this.exchange(body.access_token)
        if (generation !== this.generation) return { state: 'none' }
        if (!chain.ok) {
          this.pending = null
          this.lastError = chain.error
          return this.state()
        }
        this.pending = null
        this.save({
          clientId,
          accessToken: chain.accessToken,
          refreshToken: body.refresh_token,
          profile: chain.profile,
          savedAt: Date.now()
        })
        this.lastError = ''
        return this.state()
      } catch (e) {
        if (generation !== this.generation) return { state: 'none' }
        this.pending = null
        this.lastError = `换取凭据时出错：${e instanceof Error ? e.message : String(e)}`
        return this.state()
      }
    }
  }

  /** Validate official ownership before launch; refresh expired tokens through Microsoft only. */
  async ensureFresh(): Promise<ReturnType<MinecraftAuth['credentials']>> {
    const stored = this.stored
    if (!stored) return null
    const generation = this.generation
    try {
      const current = await fetch(this.endpoints.mcProfile, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        headers: { Authorization: `Bearer ${stored.accessToken}` }
      })
      if (current.ok) {
        const profile = await current.json() as { id?: string; name?: string }
        if (generation !== this.generation) return null
        if (profile.id?.replace(/-/g, '').toLowerCase() !== stored.profile.uuid.replace(/-/g, '').toLowerCase()
            || !profile.name || !/^[A-Za-z0-9_]{3,16}$/.test(profile.name)) throw new Error('正版身份与缓存不一致')
        this.save({ ...stored, profile: { uuid: profile.id!, name: profile.name } })
        this.lastError = ''
        return this.credentials()
      }
      if (current.status !== 401 || !stored.refreshToken) throw new Error('正版登录已失效，请重新登录微软账号')
      const refreshed = await fetch(this.endpoints.token, {
        method: 'POST', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: stored.clientId, grant_type: 'refresh_token', refresh_token: stored.refreshToken, scope: 'XboxLive.signin offline_access' })
      })
      const body = await refreshed.json() as { access_token?: string; refresh_token?: string }
      if (!refreshed.ok || !body.access_token) throw new Error('微软授权已失效，请重新登录')
      const chain = await this.exchange(body.access_token)
      if (generation !== this.generation) return null
      if (!chain.ok) throw new Error(chain.error)
      if (chain.profile.uuid.toLowerCase() !== stored.profile.uuid.replace(/-/g, '').toLowerCase()) throw new Error('刷新后的正版账号不一致')
      this.save({ clientId: stored.clientId, accessToken: chain.accessToken, refreshToken: body.refresh_token ?? stored.refreshToken, profile: chain.profile, savedAt: Date.now() })
      this.lastError = ''
      return this.credentials()
    } catch (error) {
      if (generation === this.generation) this.lastError = error instanceof Error ? error.message : '微软登录验证失败'
      return null
    }
  }

  /** ③④⑤：Xbox Live → XSTS → Minecraft。每一步单独报错，见文件头注释。 */
  private async exchange(
    msAccessToken: string
  ): Promise<{ ok: true; accessToken: string; profile: MinecraftProfile } | { ok: false; error: string }> {
    // ③ Xbox Live
    let xblToken = ''
    let uhs = ''
    try {
      const res = await fetch(this.endpoints.xbl, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          // Microsoft OAuth v2 tokens require the d= prefix (official Xbox protocol).
          Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
          RelyingParty: 'http://auth.xboxlive.com',
          TokenType: 'JWT'
        })
      })
      const body = (await res.json()) as {
        Token?: string
        DisplayClaims?: { xui?: { uhs?: string }[] }
        Message?: string
      }
      if (!res.ok || !body.Token) {
        return { ok: false, error: `Xbox Live 认证失败：${body.Message ?? `HTTP ${res.status}`}` }
      }
      xblToken = body.Token
      uhs = body.DisplayClaims?.xui?.[0]?.uhs ?? ''
    } catch (e) {
      return { ok: false, error: `连不上 Xbox Live：${e instanceof Error ? e.message : String(e)}` }
    }

    // ④ XSTS
    let xstsToken = ''
    try {
      const res = await fetch(this.endpoints.xsts, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
          RelyingParty: 'rp://api.minecraftservices.com/',
          TokenType: 'JWT'
        })
      })
      const body = (await res.json()) as {
        Token?: string
        DisplayClaims?: { xui?: { uhs?: string }[] }
        XErr?: number
        Message?: string
      }
      if (!res.ok || !body.Token) {
        // 这里最常见，且原因对玩家完全可操作 —— 必须翻译成人话
        return { ok: false, error: xstsErrorText(body.XErr) + (body.Message ? `（${body.Message}）` : '') }
      }
      xstsToken = body.Token
      uhs = body.DisplayClaims?.xui?.[0]?.uhs ?? uhs
    } catch (e) {
      return { ok: false, error: `连不上 Xbox 安全令牌服务：${e instanceof Error ? e.message : String(e)}` }
    }

    // ⑤ Minecraft（拿 accessToken）
    let mcToken = ''
    try {
      const res = await fetch(this.endpoints.mcLogin, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` })
      })
      const body = (await res.json()) as { access_token?: string; error?: string; errorMessage?: string }
      if (!res.ok || !body.access_token) {
        return {
          ok: false,
          error: `Minecraft 登录失败：${body.errorMessage ?? body.error ?? `HTTP ${res.status}`}`
        }
      }
      mcToken = body.access_token
    } catch (e) {
      return { ok: false, error: `连不上 Minecraft 认证服务：${e instanceof Error ? e.message : String(e)}` }
    }

    // ⑤b 档案（**权威身份**：uuid + 当前名字，以这里为准，不信本地缓存）
    try {
      const res = await fetch(this.endpoints.mcProfile, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        headers: { Authorization: `Bearer ${mcToken}` }
      })
      if (res.status === 404) {
        // 404 = 这个微软账号**没有 Minecraft**。这是最容易被误报成"登录坏了"的一种。
        return { ok: false, error: '这个微软账号没有 Minecraft：请确认买过游戏且用的是同一个账号' }
      }
      const body = (await res.json()) as { id?: string; name?: string }
      if (!res.ok || !body.id || !/^[0-9a-f]{32}$/i.test(body.id.replace(/-/g, '')) || !body.name || !/^[A-Za-z0-9_]{3,16}$/.test(body.name)) {
        return { ok: false, error: `读取 Minecraft 档案失败（HTTP ${res.status}）` }
      }
      return {
        ok: true,
        accessToken: mcToken,
        profile: { uuid: body.id.replace(/-/g, ''), name: body.name }
      }
    } catch (e) {
      return { ok: false, error: `读取 Minecraft 档案出错：${e instanceof Error ? e.message : String(e)}` }
    }
  }
}
