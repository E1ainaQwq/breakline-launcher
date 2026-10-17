import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { DeviceIdentity, type DeviceResult } from './DeviceIdentity'
import type { AcTask } from '../../shared/AcMonitor'
import { DEFAULT_YGGDRASIL_API, type YggdrasilSession } from './YggdrasilAuth'

/**
 * 玩家系统 API 客户端（第 2 项：**不允许离线账号**）。
 *
 * <h2>它和 YggdrasilAuth 的分工（别混）</h2>
 * - `YggdrasilAuth`：拿 LittleSkin 账号密码换 Minecraft 的 `accessToken/uuid`，
 *   解决的是**皮肤与游戏内身份**。
 * - 本模块：向**我们自己的玩家系统**登记/登录，解决的是**准入**——
 *   没有这里的会话，`launch:start` 直接拒绝。
 *
 * 两件事必须分开：Yggdrasil 是第三方皮肤站的会话（玩家可以没有密码缓存），
 * 而"允许不允许进我们的服务器"只能由我们自己的系统说了算。
 * 之前启动器没有这一层，于是 `--accessToken 0` 的离线占位照样能进服——这就是"离线兜底"。
 *
 * <h2>凭据纪律</h2>
 * 1. 只落盘**会话 token 与公开资料**（角色名/邮箱/UUID），不落盘任何密码（密码从不经过本模块）。
 * 2. token 不进日志。排障日志里只出现角色名与状态。
 * 3. 邮箱验证码只用于一次 `player:login`，用完即弃，不缓存。
 *
 * <h2>服务端依赖（server/player-api.py）</h2>
 * ```
 * POST /api/register {name,email,site}   查皮肤站身份 → 发验证码
 * POST /api/verify   {email,code}        验证码 → 建号（已注册则直接发会话）→ bind_token
 * POST /api/login    {token,hwid}        bind_token → 正式会话
 * GET  /api/me?session=<token>           会话有效性 + 封禁状态
 * ```
 */

export interface PlayerInfo {
  uuid: string
  name: string
  site: string
  email: string
  status: string
  ban_until: number | null
}

export interface StoredSession {
  token: string
  player: PlayerInfo
  savedAt: number
}

/** 会话状态四态。**刻意不合并**：它们的处置完全不同。 */
export type PlayerSessionState =
  | { state: 'none' }
  | { state: 'ok'; player: PlayerInfo }
  | { state: 'banned'; player: PlayerInfo; reason: string }
  /** 连不上玩家系统。**不能当作"已授权"**——闸门在调用方，那里会拒绝启动。 */
  | { state: 'unreachable'; error: string }

export interface PlayerApiResult {
  ok: boolean
  /** 服务端原始错误码（如 rate_limited_ip）。界面据此给不同文案。 */
  error?: string
  /** 可直接展示给玩家的中文说明，由 errText 生成。 */
  message?: string
  /** 服务端建议的重试秒数（429 才有）。 */
  retryAfter?: number
  player?: PlayerInfo
}

/**
 * 账号状态：界面据此决定"让他输密码"还是"走邮箱验证码"。
 *
 * 三态必须能分开（2026-09-18 密码登录）：
 *   · 没登记过          → 首次绑定：邮箱 + 验证码 + **设置密码**
 *   · 登记过但没密码    → 也要走一次邮箱验证码，顺带把密码设上（老账号的迁移路径）
 *   · 登记过且有密码    → 主路径：只输密码
 */
export interface AccountStatus {
  ok: boolean
  exists: boolean
  hasPassword: boolean
  /** 打码后的邮箱（`el***@gmail.com`）：让本人确认绑的是哪个，又不至于泄露凭据。 */
  emailMasked?: string
  message?: string
  error?: string
}

export interface SendCodeResult extends PlayerApiResult {
  ttl?: number
  /** 服务端是否真的把邮件交给了 SMTP。false 表示"没发信"，界面要如实说。 */
  accepted?: boolean
  /**
   * 这个角色**已经登记过**（`same_email`）时由服务端告知。
   *
   * 有它才能把文案说对："正在登录" vs "正在登记"。2026-09-17 之前服务端对
   * 已注册角色直接 409，老玩家连码都拿不到 ⇒ 只有新玩家能登录。
   */
  registered?: string
  /**
   * 服务端返回的**机器可判**子原因。
   *
   * ⚠️ 为什么不能只看 `error`：`email_in_use` 这个码在服务端同时用于**两个方向相反**的场景——
   *   · `email_mismatch`：角色已绑了邮箱 A，你拿邮箱 B 来登（该用 A）
   *   · （另一分支）邮箱已被别的角色占了（该换邮箱）
   * 只看 `error` 就会把"你该用原邮箱"说成"这个邮箱已被占用" ——
   * 2026-09-17 运维本人第一次就照它查错了方向。所以服务端现在额外回 `code`。
   */
  code?: string
  /** `email_mismatch` 时服务端回的**已绑邮箱（打码）**，供界面直接告诉玩家该用哪个。 */
  boundEmail?: string
  /** 仅 dry-run（服务端未配 SMTP）时出现，便于联调。 */
  dryRunCode?: string
}

/** 生产地址：只暴露 Cloudflare HTTPS API；源站 IP 不进入客户端默认配置。 */
export const DEFAULT_PLAYER_API = 'https://api.breakline-ops.lol'

/** 默认身份来源：目前只有 LittleSkin 的"按角色名查人"是公开可用的（见 player-api.py 注释）。 */
export const DEFAULT_SITE = 'littleskin'

/**
 * 解析玩家系统地址。`--player-api <url>` 优先，其次 `DELTA_PLAYER_API`，最后生产地址。
 *
 * 有覆盖能力的理由只有一个：**验收脚本要能在本机起 mock 把整条链跑完**，
 * 而不是每次验证都去打生产服务器。玩家侧看不到这个开关，也不需要它。
 */
export function resolveApiBase(argv: string[] = process.argv): string {
  const i = argv.indexOf('--player-api')
  const fromArgv = i >= 0 ? argv[i + 1] : undefined
  const v = (fromArgv && !fromArgv.startsWith('--') ? fromArgv : undefined) ?? process.env['DELTA_PLAYER_API']
  if (!v) return DEFAULT_PLAYER_API
  if (!/^https?:\/\//.test(v)) {
    console.log(`[launcher] 忽略非法的玩家系统地址：${v}`)
    return DEFAULT_PLAYER_API
  }
  return v.replace(/\/+$/, '')
}

/** 单次请求超时。注册要等皮肤站回话，给宽一点；其余接口都很快。 */
const TIMEOUT_REGISTER_MS = 15000
const TIMEOUT_DEFAULT_MS = 8000

/** 错误码 → 中文。**面向玩家**，所以要写"他该怎么办"，不是复述错误码。 */
export function errText(err: string | undefined): string {
  switch (err) {
    case 'bad_name':
      return '角色名格式不对（3–16 位，只能字母、数字、下划线）'
    case 'bad_email':
      return '邮箱格式不对'
    case 'identity_not_found':
      return '在 LittleSkin 上找不到这个角色名——请填你 LittleSkin 的角色名（不是邮箱）'
    case 'identity_check_failed':
      return '连不上 LittleSkin 查身份，请稍后重试'
    case 'already_registered':
      return '这个角色已经登记过了，直接获取验证码登录即可'
    case 'email_in_use':
      return '这个邮箱已经绑过别的角色了'
    case 'rate_limited_ip':
      return '操作太频繁，请过一会儿再试（同一网络每小时最多 8 次）'
    case 'too_soon':
      return '验证码刚发过，请等 60 秒再点'
    case 'code_expired':
      return '验证码已过期，请重新获取'
    case 'bad_code':
      return '验证码不对'
    case 'too_many_tries':
      return '错误次数太多，请重新获取验证码'
    // ---- 密码登录（2026-09-18）----
    // 服务端对这些码都会给 message（更具体），这里只是**兜底**：
    // 万一某个码漏了文案，玩家至少看到的是"该做什么"，而不是一个英文错误码。
    case 'bad_password':
      return '密码不对'
    case 'password_not_set':
      return '这个角色还没设置密码：请用邮箱验证码登录一次并设置密码'
    case 'weak_password':
      return '密码太短：至少 6 位'
    case 'too_many_attempts':
      return '密码错误次数过多，请稍后再试（或改用邮箱验证码重置密码）'
    case 'bad_request':
      return '请把角色名和密码都填上'
    case 'invalid_token':
    case 'invalid_session':
      return '登录状态已失效，请重新登录'
    case 'banned':
      return '这个账号已被封禁'
    case 'premium_requires_uuid':
      return '暂时只支持 LittleSkin 登记（正版登录尚未开放）'
    default:
      return err ? `操作失败（${err}）` : '操作失败，请重试'
  }
}

/** 会话持久化：与 auth.json 同目录，权限同样按当前用户。 */
export class SessionStore {
  constructor(private readonly path: string) {}

  load(): StoredSession | null {
    try {
      if (!existsSync(this.path)) return null
      const s = JSON.parse(readFileSync(this.path, 'utf8')) as StoredSession
      if (!s?.token || !s?.player?.name) return null
      return s
    } catch {
      return null
    }
  }

  save(session: StoredSession): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.path, JSON.stringify(session, null, 2), 'utf8')
  }

  clear(): void {
    try {
      if (existsSync(this.path)) rmSync(this.path)
    } catch {
      /* 尽力而为 */
    }
  }
}

export class PlayerApi {
  private session: StoredSession | null
  private identity: DeviceResult | null = null
  private deviceTask: AcTask = { id: 'device', label: '设备标识', state: 'waiting', detail: '等待启动前读取与服务器验证' }
  private environmentTask: AcTask = { id: 'environment', label: '启动环境', state: 'waiting', detail: '等待启动前检查' }

  constructor(
    private readonly store: SessionStore,
    /** 便于测试与换服：可由 `DELTA_PLAYER_API` 覆盖。 */
    public readonly base: string = DEFAULT_PLAYER_API,
    private readonly launcherVersion = '',
    private readonly deviceIdentity = new DeviceIdentity()
  ) {
    this.session = store.load()
  }

  /** 本机缓存的会话（不校验）。界面先拿它渲染，再调 status() 复核。 */
  cached(): StoredSession | null {
    return this.session
  }

  /**
   * 生成机器码信号：**只作弱信号**（同机多号风控），不作为封禁唯一依据。
   * 所以这里用"用户 + 主机名 + 平台"的哈希就够，不采集任何硬件序列号。
   */
  hwid(): string {
    const raw = `${process.env['USERNAME'] ?? ''}|${process.env['COMPUTERNAME'] ?? ''}|${process.platform}|${process.arch}`
    return createHash('sha256').update(raw).digest('hex').slice(0, 32)
  }

  deviceTasks(): AcTask[] { return [{ ...this.deviceTask }, { ...this.environmentTask }] }

  /** Same authenticated server guard is repeated immediately before token issuance. */
  async checkDevice(): Promise<{ ok: boolean; error?: string }> {
    const identity = this.identity = await this.deviceIdentity.collect()
    this.environmentTask = { id: 'environment', label: '启动环境', state: identity.environment === 'physical' ? 'ok' : 'error', detail: identity.environment === 'physical' ? '未识别到虚拟机来宾标识' : identity.detail }
    if (identity.environment !== 'physical' || !identity.device) {
      this.deviceTask = { id: 'device', label: '设备标识', state: 'error', detail: identity.detail }
      return { ok: false, error: identity.detail }
    }
    if (!this.session?.token) return { ok: false, error: '请先登录启动器账号' }
    this.deviceTask = { id: 'device', label: '设备标识', state: 'working', detail: '正在核实设备封禁状态' }
    const response = await this.post('/api/device/check', { session: this.session.token, device: identity.device, environment: identity.environment }, TIMEOUT_DEFAULT_MS)
    const body = (response.body ?? {}) as { ok?: boolean; deviceVerified?: boolean; error?: string; message?: string }
    if (!response.ok || body.ok !== true || body.deviceVerified !== true) {
      const error = body.message ?? (body.error === 'device_banned' ? '该设备已被永久封禁关联，更换账号不能解除' : '设备验证暂不可用，请稍后重试')
      this.deviceTask = { id: 'device', label: '设备标识', state: 'error', detail: error }
      return { ok: false, error }
    }
    this.deviceTask = { id: 'device', label: '设备标识', state: 'ok', detail: `已读取 ${identity.device.signals.length} 项稳定标识；服务器确认未受设备限制` }
    return { ok: true }
  }

  /**
   * 取「启动器来源令牌」（D2 加强版）。
   *
   * 这是"只有用启动器启动才允许进入服务器"这条规则的**源头**：
   * 启动器在拉起游戏前拿到一个签名令牌，作为 JVM 系统属性传给游戏，
   * 模组上报时带上它，服务端用同一密钥本地校验 —— 于是"这份会话是不是我们拉起来的"
   * 第一次变成可验证的事实（在那之前只能验证"有没有客户端在应答"，
   * 而 HMCL 用同一个实例目录照样能过）。
   *
   * ⚠️ 失败时**返回错误而不是空令牌**：绝不伪造一个空令牌（那会让"看起来有机制"
   * 变成实际全放行）。调用方应当把失败**显式说出来**，再由服务端的准入闸门去拦。
   */
  async launcherToken(expectedPlayerName?: string): Promise<{ ok: true; token: string; ttlSeconds: number } | { ok: false; error: string }> {
    const session = this.session
    if (!session?.token) return { ok: false, error: '尚未登录（没有可用会话）' }
    const identity = this.identity ?? await this.deviceIdentity.collect()
    if (identity.environment !== 'physical' || !identity.device) return { ok: false, error: identity.detail }
    try {
      const res = await fetch(`${this.base}/api/launch/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.launcherVersion ? { 'X-Delta-Launcher-Version': this.launcherVersion } : {})
        },
        // expectedPlayerName 不是让客户端任选签名对象；服务端只在它与会话绑定名一致时签发。
        // 这个字段把“玩家系统账号”与“最终传给 Minecraft 的 --username”钉在同一条链上，
        // 避免启动器登录 A、游戏却用缓存的 B，最后被准入端判成 name-mismatch。
        body: JSON.stringify({ session: session.token, expectedPlayerName, device: identity.device, environment: identity.environment }),
        signal: AbortSignal.timeout(15_000)
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string; ttlSeconds?: number; error?: string; message?: string }
      if (!res.ok || !body.ok || !body.token) {
        if (res.status === 401 && body.error === 'invalid_session') {
          if (this.session?.token === session.token) this.logout()
          return { ok: false, error: '玩家系统登录已过期，请重新登录启动器账号后再启动游戏' }
        }
        if (['device_banned', 'account_permanent_ban', 'virtual_machine'].includes(body.error ?? '')) {
          this.deviceTask = { id: 'device', label: '设备标识', state: 'error', detail: body.message ?? '设备或账号已被限制启动，请联系管理员申诉' }
        }
        return { ok: false, error: body.message ?? `服务端拒绝签发（${res.status} ${body.error ?? 'unknown'}）` }
      }
      return { ok: true, token: body.token, ttlSeconds: body.ttlSeconds ?? 300 }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  logout(): void {
    this.session = null
    this.store.clear()
    this.deviceTask = { id: 'device', label: '设备标识', state: 'waiting', detail: '等待登录后重新验证' }
  }

  async uploadScreenshot(ticket: string, bytes: Buffer): Promise<{ requestId: string; sha256: string }> {
    const session = this.session
    if (!session?.token) throw new Error('截图上传需要有效登录会话')
    const res = await fetch(`${this.base}/api/evidence/screenshot`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'image/png', 'X-Delta-Capture-Request': ticket, 'X-Delta-Launcher-Version': this.launcherVersion },
      body: new Uint8Array(bytes), signal: AbortSignal.timeout(15_000)
    })
    const raw = await res.text()
    if (raw.length > 4096) throw new Error('截图保存回执无效')
    const receipt = JSON.parse(raw) as { ok?: boolean; stored?: boolean; requestId?: string; sha256?: string }
    if (!res.ok || !receipt.ok || !receipt.stored || !receipt.requestId || !receipt.sha256) throw new Error(res.status === 429 ? '本小时截图配额已用尽' : `截图未保存（HTTP ${res.status}）`)
    return { requestId: receipt.requestId, sha256: receipt.sha256 }
  }

  /**
   * 会话真实性校验：**必须问服务端**，不能只看本地文件。
   * 本地有 token ≠ 会话有效（可能过期、可能被封、可能服务端重置过库）。
   */
  async status(): Promise<PlayerSessionState> {
    const tok = this.session?.token
    if (!tok) return { state: 'none' }
    const r = await this.get(`/api/me?session=${encodeURIComponent(tok)}`, TIMEOUT_DEFAULT_MS)
    if (!r.body) {
      return { state: 'unreachable', error: r.transportError ?? '连接玩家系统失败' }
    }
    const body = r.body as { ok?: boolean; user?: PlayerInfo; error?: string }
    if (r.status === 401 || body.error === 'invalid_session') {
      // 本地凭据已失效：清掉，避免界面一直显示"已登录"
      this.logout()
      return { state: 'none' }
    }
    if (r.status === 403 || body.user?.status === 'banned') {
      const p = body.user as PlayerInfo
      return { state: 'banned', player: p, reason: '账号处于封禁状态' }
    }
    if (!r.ok || !body.user) {
      return { state: 'unreachable', error: `玩家系统返回异常（HTTP ${r.status}）` }
    }
    // 服务端可能改名：以服务端为准，本地同步一份
    this.session = { token: tok, player: body.user, savedAt: this.session?.savedAt ?? Date.now() }
    this.store.save(this.session)
    return { state: 'ok', player: body.user }
  }

  /**
   * 问服务端"这个角色该怎么登录"：输密码，还是走邮箱验证码。
   *
   * ⚠️ 这个请求**必须是幂等只读的**：界面在角色名输完、切换登录方式时都会问一次，
   * 绝不能顺手发一封邮件（那会让玩家收到莫名其妙的验证码）。
   * 发码仍然只由 {@link sendCode} 触发。
   */
  async accountStatus(name: string, site = DEFAULT_SITE): Promise<AccountStatus> {
    const r = await this.post(
      '/api/account/status',
      { name: name.trim(), site },
      TIMEOUT_DEFAULT_MS
    )
    const body = (r.body ?? {}) as {
      ok?: boolean
      exists?: boolean
      has_password?: boolean
      email_masked?: string
      message?: string
      error?: string
    }
    if (!r.ok || body.ok !== true) {
      const err = body.error ?? r.transportError ?? 'status_failed'
      return {
        ok: false,
        exists: false,
        hasPassword: false,
        error: err,
        message: body.message ?? errText(err)
      }
    }
    return {
      ok: true,
      exists: body.exists === true,
      hasPassword: body.has_password === true,
      emailMasked: body.email_masked
    }
  }

  /**
   * 用密码登录（账号绑过邮箱且设过密码时的**主路径**）。
   *
   * 与 {@link login} 的分工：那个是"验证码 → 一次性 bind_token → 正式会话"；
   * 这个一步到位 —— 密码本身就是长期凭据，不需要过渡令牌。
   * 服务端侧两者记的账完全一样（会话 / 机器码 / 同机多号风控 / 事件留痕）。
   */
  async loginWithPassword(
    identifier: string,
    password: string,
    site = DEFAULT_SITE
  ): Promise<PlayerApiResult> {
    const r = await this.post(
      '/api/login-password',
      // `name` 保留给旧服务端；新服务端优先使用 identifier，可填角色名或绑定邮箱。
      { name: identifier.trim(), identifier: identifier.trim(), site, password, hwid: this.hwid() },
      TIMEOUT_DEFAULT_MS
    )
    const body = (r.body ?? {}) as {
      ok?: boolean
      error?: string
      message?: string
      retry_after?: number
      session?: string
      user?: { uuid: string; name: string; site: string; email?: string }
      risk?: { accounts_on_this_hwid?: number }
    }
    if (!r.ok || body.ok !== true || !body.session || !body.user) {
      const err = body.error ?? r.transportError ?? 'login_failed'
      return {
        ok: false,
        error: err,
        message: body.message ?? errText(err),
        retryAfter: body.retry_after
      }
    }
    const player: PlayerInfo = {
      uuid: body.user.uuid,
      name: body.user.name,
      site: body.user.site,
      email: body.user.email ?? '',
      status: 'active',
      ban_until: null
    }
    this.session = { token: body.session, player, savedAt: Date.now() }
    this.store.save(this.session)
    return { ok: true, player }
  }

  /** 第一步：发起登记 → 皮肤站验证身份 → 服务端发验证码邮件。 */
  async sendCode(name: string, email: string, site = DEFAULT_SITE): Promise<SendCodeResult> {    const r = await this.post(
      '/api/register',
      { name: name.trim(), email: email.trim().toLowerCase(), site },
      TIMEOUT_REGISTER_MS
    )
    const body = (r.body ?? {}) as {
      ok?: boolean
      error?: string
      /** 机器可判的子原因（如 email_mismatch）。**别只看 error**，见 SendCodeResult 的注释。 */
      code?: string
      /** 服务端已写的玩家可读文案（优先用它，而不是本地猜）。 */
      message?: string
      bound_email?: string
      ttl?: number
      accepted?: boolean
      sent?: boolean
      registered?: string
      retry_after?: number
    }
    if (!r.ok || body.ok !== true) {
      const err = body.error ?? r.transportError ?? 'request_failed'
      // 文案优先级：**服务端给的 > 本地对照表**。
      //
      // 为什么：服务端知道具体是哪种情况（比如"角色已绑 27***@qq.com，请用那个邮箱"），
      // 而本地只能照错误码猜。同一晚就踩过——本地把"你该用原邮箱"
      // 说成了"这个邮箱已被占用"，方向正好相反，运维照着查错了方向。
      const message =
        body.message ?? (body.code === 'email_mismatch'
          ? `这个角色已经绑定过邮箱（${body.bound_email ?? '（已打码）'}）：请改用那个邮箱登录`
          : errText(body.code ?? err))
      return { ok: false, error: err, code: body.code, boundEmail: body.bound_email, message, retryAfter: body.retry_after }
    }
    return {
      ok: true,
      ttl: body.ttl,
      registered: body.registered,
      // 兼容旧字段名 sent：语义是"SMTP 收下了"，不是"玩家收到了"
      accepted: body.accepted ?? body.sent ?? true,
      dryRunCode: body.code
    }
  }

  /**
   * 第二步：验证码 + 邮箱 → 建号（老玩家则直接发会话）→ 换正式会话。
   *
   * 为什么两步合成一个方法：中间那个 `bind_token` 是**一次性、5 分钟**的过渡凭据，
   * 把它暴露给 UI 层没有任何用处，只会多一个能泄露的地方。
   *
   * `password`（2026-09-18 起）：传了就**顺手把密码设上** —— 这就是运维要的
   * "首次绑定邮箱时在验证码那一步设置密码"。不传则与以前完全一致
   * （老启动器、以及"只想用验证码登一次"的场景）。
   */
  async login(email: string, code: string, password?: string): Promise<PlayerApiResult> {
    const mail = email.trim().toLowerCase()
    const payload: Record<string, unknown> = { email: mail, code: code.trim() }
    // 只有真的要设密码时才带这个字段：空字符串会让服务端把"没设密码"与"设了个空密码"混起来。
    if (password) payload['password'] = password
    const v = await this.post('/api/verify', payload, TIMEOUT_DEFAULT_MS)
    const vb = (v.body ?? {}) as {
      ok?: boolean
      error?: string
      message?: string
      bind_token?: string
      uuid?: string
      name?: string
    }
    if (!v.ok || vb.ok !== true || !vb.bind_token) {
      const err = vb.error ?? v.transportError ?? 'verify_failed'
      // 同 sendCode：**服务端文案优先**，本地 errText 只作兜底
      return { ok: false, error: err, message: vb.message ?? errText(err) }
    }
    const l = await this.post(
      '/api/login',
      { token: vb.bind_token, hwid: this.hwid() },
      TIMEOUT_DEFAULT_MS
    )
    const lb = (l.body ?? {}) as {
      ok?: boolean
      error?: string
      message?: string
      session?: string
      user?: { uuid: string; name: string; site: string }
      risk?: { accounts_on_this_hwid?: number }
    }
    if (!l.ok || lb.ok !== true || !lb.session || !lb.user) {
      const err = lb.error ?? l.transportError ?? 'login_failed'
      return { ok: false, error: err, message: lb.message ?? errText(err) }
    }
    const player: PlayerInfo = {
      uuid: lb.user.uuid,
      name: lb.user.name,
      site: lb.user.site,
      email: mail,
      status: 'active',
      ban_until: null
    }
    this.session = { token: lb.session, player, savedAt: Date.now() }
    this.store.save(this.session)
    return { ok: true, player }
  }

  // ------------------------------------------------------------------ HTTP

  async loginWithLittleSkin(session: YggdrasilSession): Promise<PlayerApiResult> {
    // Credentials go exclusively to the fixed LittleSkin endpoint, never our API.
    if (session.api.replace(/\/$/, '') !== DEFAULT_YGGDRASIL_API) {
      return { ok: false, error: 'unexpected_identity_provider', message: '请使用 LittleSkin 登录' }
    }
    return this.loginWithVerifiedGameSession('littleskin', session.username, session.uuid, session.accessToken)
  }

  async loginWithMicrosoft(session: { username: string; uuid: string; accessToken: string }, current: () => boolean = () => true, linkSession?: string): Promise<PlayerApiResult> {
    return this.loginWithVerifiedGameSession('premium', session.username, session.uuid, session.accessToken, current, linkSession)
  }

  private async loginWithVerifiedGameSession(site: 'littleskin' | 'premium', username: string, uuid: string, accessToken: string, current: () => boolean = () => true, linkSession?: string): Promise<PlayerApiResult> {
    const label = site === 'premium' ? '微软正版' : 'LittleSkin'
    const endpoint = site === 'premium' ? 'https://sessionserver.mojang.com' : `${DEFAULT_YGGDRASIL_API}/sessionserver`
    const existing = this.session
    const link = linkSession ?? (existing && existing.player.site !== site && existing.player.name.toLowerCase() === username.toLowerCase() ? existing.token : undefined)
    const challenge = await this.post(`/api/auth/${site}/challenge`,
      { name: username, hwid: this.hwid(), ...(link ? { linkSession: link } : {}) }, TIMEOUT_DEFAULT_MS)
    const ch = challenge.body as { ok?: boolean; challenge?: string; serverId?: string; error?: string }
    if (!challenge.ok || !ch?.ok || !ch.challenge || !ch.serverId) {
      if (site === 'premium' && (challenge.status === 404 || ch?.error === 'premium_login_not_enabled')) {
        return { ok: false, error: 'premium_login_not_enabled', message: '微软授权后仍需服务器验证；服务器微软登录尚未开放，请暂用 LittleSkin 登录' }
      }
      return { ok: false, error: ch?.error ?? challenge.transportError ?? 'challenge_failed', message: '服务器登录验证暂不可用，请稍后重试' }
    }
    try {
      const joined = await fetch(`${endpoint}/session/minecraft/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ accessToken, selectedProfile: uuid.replace(/-/g, ''), serverId: ch.serverId })
      })
      if (joined.status !== 204) return { ok: false, error: `${site}_session_invalid`, message: `${label}登录已失效，请重新登录` }
    } catch {
      return { ok: false, error: `${site}_unavailable`, message: `无法连接${label}，请稍后重试` }
    }
    const completed = await this.post(`/api/auth/${site}/complete`, { challenge: ch.challenge }, 20000)
    const result = completed.body as { ok?: boolean; error?: string; session?: string; user?: { uuid: string; name: string; site: string; email?: string } }
    if (!completed.ok || !result?.ok || !result.session || !result.user) {
      const code = result?.error ?? completed.transportError ?? 'identity_failed'
      return { ok: false, error: code, message: code === 'existing_account_requires_link' ? '同名角色已有账号：请先登录原账号，再在账号窗口验证另一种登录方式，首次验证两边后共用原角色和资产' : code === 'premium_login_not_enabled' ? '正版登录候选功能尚未在服务器开放' : `${label}身份验证未通过，请重新登录或联系管理员核对账号绑定` }
    }
    if (result.user.uuid.replace(/-/g, '').toLowerCase() !== uuid.replace(/-/g, '').toLowerCase()
        || result.user.name.toLowerCase() !== username.toLowerCase() || result.user.site !== site) {
      return { ok: false, error: 'authenticated_identity_mismatch', message: '服务器返回的账号身份不一致，请联系管理员' }
    }
    const player: PlayerInfo = { ...result.user, email: result.user.email ?? '', status: 'active', ban_until: null }
    if (!current()) return { ok: false, error: 'login_cancelled', message: '登录已取消' }
    this.session = { token: result.session, player, savedAt: Date.now() }
    this.store.save(this.session)
    return { ok: true, player }
  }

  private async post(
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<{ ok: boolean; status: number; body: unknown; transportError?: string }> {
    return this.request('POST', path, body, timeoutMs)
  }

  private async get(
    path: string,
    timeoutMs: number
  ): Promise<{ ok: boolean; status: number; body: unknown; transportError?: string }> {
    return this.request('GET', path, undefined, timeoutMs)
  }

  /**
   * 所有请求的唯一出口：**必须有超时**。
   *
   * 没有超时的 fetch 在"服务端半死不活"时会挂到玩家以为启动器卡死——
   * 而这个界面上"卡住"和"在启动"是同一个样子，最难排查。
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<{ ok: boolean; status: number; body: unknown; transportError?: string }> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.launcherVersion ? { 'X-Delta-Launcher-Version': this.launcherVersion } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal
      })
      const text = await res.text()
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        // 非 JSON（nginx 502 页面等）：当成传输层错误，别让它伪装成业务错误
        return { ok: false, status: res.status, body: null, transportError: `bad_response_${res.status}` }
      }
      return { ok: res.ok, status: res.status, body: parsed }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        status: 0,
        body: null,
        transportError: /abort/i.test(msg) ? 'timeout' : `network:${msg}`
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
