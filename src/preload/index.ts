import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DownloadSpeed, DownloadActivity } from '../shared/DownloadActivity'
import type { LaunchPreparation, LaunchCheck } from '../shared/LaunchPreparation'
import type { AnnouncementResult } from '../shared/Announcements'
import type { AcMonitorSnapshot } from '../shared/AcMonitor'

/**
 * 唯一的 renderer ↔ main 通道。
 *
 * 纪律：**只暴露具体方法，绝不暴露 ipcRenderer 本体**。
 * 一旦把 ipcRenderer 交给 renderer，UI 层被注入就等于拿到了整个主进程的 IPC 面。
 */

type LaunchState = { state: string; pid?: number; code?: number }
type LogPayload = { line: string }

/** 更新进度（与主进程 `UpdateProgress` 对齐）。 */
type UpdateProgressPayload = {
  phase: 'idle' | 'checking' | 'downloading' | 'applying' | 'done' | 'error'
  percent: number
  doneFiles: number
  totalFiles: number
  bytesDone: number
  bytesTotal: number
  current?: string
  message?: string
}

/**
 * 生效游戏目录的信息（与主进程 `verifyPack().dir` 对齐）。
 *
 * 为什么界面需要它：2026-09-18 的缺陷里，玩家只能看到"预检未通过（5 项）"与一条
 * **别人机器的路径**。现在界面必须能回答三件事：这个目录是谁给的、
 * 启动器会不会自己建、里面到底有没有整合包（三态 different 文案）。
 */
type GameDirInfo = {
  gameRoot: string
  source: string
  sourceLabel: string
  modsDir: string
  modsJars: number
  created: string[]
  rejected: { raw: string; expanded: string; source: string }[]
  notices: { code: string; text: string; detail?: string }[]
}

const api = {
  anticheat: { status: () => ipcRenderer.invoke('anticheat:status') as Promise<AcMonitorSnapshot> },
  consent: {
    get: () => ipcRenderer.invoke('consent:get'),
    accept: (accepted: boolean) => ipcRenderer.invoke('consent:accept', accepted)
  },
  news: { get: () => ipcRenderer.invoke('news:get') as Promise<AnnouncementResult> },
  launch: {
    start: () => ipcRenderer.invoke('launch:start'),
    onPreparation: (cb: (value: LaunchPreparation) => void) => {
      const listener = (_event: IpcRendererEvent, value: LaunchPreparation): void => cb(value)
      ipcRenderer.on('launch:preparation', listener)
      return () => ipcRenderer.removeListener('launch:preparation', listener)
    },
    state: () => ipcRenderer.invoke('launch:state'),
    /**
     * 只读预演：**不启动任何东西**，只回答"现在点启动会发生什么"。
     * 首页据此把"为什么点不动"提前显示出来（与真正启动走同一段判定）。
     */
    preflight: () =>
      ipcRenderer.invoke('launch:preflight') as Promise<{
        ok: boolean
        code?: string
        message?: string
        player?: string
        checks?: LaunchCheck[]
        pack?: {
          ok: boolean
          expected: number
          actual: number
          error?: string
          /** 目录三态：ok / empty（目录在但没 mods）/ missing（不存在，启动器会建）/ unreadable */
          dirState?: 'ok' | 'empty' | 'missing' | 'unreadable'
          dir?: GameDirInfo
        }
      }>,
    onState: (cb: (s: LaunchState) => void) => {
      // 参数类型必须与 Electron 的 IpcRendererListener 对齐（用 never 那种写法会被 tsc 拒掉，
      // 第一次 typecheck 就是这么报的：Type 'any' is not assignable to type 'never'）。
      const listener = (_e: IpcRendererEvent, s: LaunchState): void => cb(s)
      ipcRenderer.on('launch:state', listener)
      return () => ipcRenderer.removeListener('launch:state', listener)
    },
    onLog: (cb: (l: LogPayload) => void) => {
      const listener = (_e: IpcRendererEvent, l: LogPayload): void => cb(l)
      ipcRenderer.on('launch:log', listener)
      return () => ipcRenderer.removeListener('launch:log', listener)
    }
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    // 例图标题栏是三个按钮（最小化/最大化/关闭），所以补一个最大化切换
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },
  /**
   * LittleSkin 登录。**密码只走这一条 invoke，不缓存、不落盘**；
   * `auth:status` 只返回"登录与否 + 用户名"，不回传 token（renderer 不需要它）。
   */
  auth: {
    login: (username: string, password: string) =>
      ipcRenderer.invoke('auth:login', username, password) as Promise<{
        ok: boolean
        username?: string
        uuid?: string
        error?: string
      }>,
    status: () =>
      ipcRenderer.invoke('auth:status') as Promise<{ loggedIn: boolean; username?: string }>,
    logout: () => ipcRenderer.invoke('auth:logout') as Promise<{ ok: boolean }>,
    /** 玩家头像（data URL）。主进程抓取 + 缓存；拿不到返回 null，界面回落到首字母。 */
    avatar: (name: string) => ipcRenderer.invoke('auth:avatar', name) as Promise<string | null>
  },
  /**
   * 正版（微软）登录（第 4 项）。设备码流程：启动器只拿到一串短码，
   * **玩家在系统浏览器里输密码**——密码永远不经过我们。
   *
   * ⚠️ `state()` 返回的 `pending.session` **不含 `deviceCode`**（主进程用
   * `toPublicState` 去掉了）。那是轮询凭据，不该出现在 renderer 里。
   */
  mc: {
    state: () =>
      ipcRenderer.invoke('mc:state') as Promise<
        | { state: 'none' }
        | {
            state: 'pending'
            session: {
              userCode: string
              verificationUri: string
              interval: number
              expiresAt: number
              message?: string
            }
          }
        | { state: 'ok'; profile: { uuid: string; name: string } }
        | { state: 'error'; error: string }
      >,
    start: () => ipcRenderer.invoke('mc:start') as Promise<{ ok: boolean; error?: string }>,
    poll: () =>
      ipcRenderer.invoke('mc:poll') as Promise<
        | { state: 'none' }
        | { state: 'pending'; session: { userCode: string; verificationUri: string; interval: number } }
        | { state: 'ok'; profile: { uuid: string; name: string } }
        | { state: 'error'; error: string }
      >,
    logout: () => ipcRenderer.invoke('mc:logout') as Promise<{ ok: boolean }>,
    /** 用**系统浏览器**打开验证页（不内嵌浏览器）。 */
    openBrowser: () => ipcRenderer.invoke('mc:openBrowser') as Promise<{ ok: boolean }>
  },
  /**
   * 玩家系统（**准入**）。
   *
   * 与上面 `auth`（LittleSkin，管皮肤）是两件事：这里的会话决定"允不允许启动游戏"。
   * renderer 只能提交「角色名 / 邮箱 / 验证码」，**拿不到也传不了任意 URL**。
   */
  player: {
    /** 会话状态：ok / none / banned / unreachable（**unreachable 不等于已授权**）。 */
    status: () =>
      ipcRenderer.invoke('player:status') as Promise<{
        state: 'ok' | 'none' | 'banned' | 'unreachable'
        name?: string
        email?: string
        site?: string
        reason?: string
        error?: string
      }>,
    /** 第一步：角色名 + 邮箱（+ 身份来源）→ 服务端核实身份并发验证码。 */
    sendCode: (name: string, email: string, site?: string) =>
      ipcRenderer.invoke('player:sendCode', name, email, site) as Promise<{
        ok: boolean
        error?: string
        message?: string
        retryAfter?: number
        ttl?: number
        accepted?: boolean
        /** 服务端告知"这个角色已登记过"（`same_email`），界面据此说"登录"而不是"注册"。 */
        registered?: string
        dryRunCode?: string
      }>,
    /**
     * 这个角色该怎么登：`hasPassword=true` ⇒ 只要密码；否则走邮箱验证码（并设密码）。
     * **只读**：它不会给玩家发邮件（发码只由 sendCode 触发）。
     */
    accountStatus: (name: string, site?: string) =>
      ipcRenderer.invoke('player:accountStatus', name, site) as Promise<{
        ok: boolean
        exists: boolean
        hasPassword: boolean
        /** 打码后的邮箱（`el***@gmail.com`）。 */
        emailMasked?: string
        message?: string
        error?: string
      }>,
    /** 纯密码登录（账号绑过邮箱且设过密码时的主路径）。 */
    loginPassword: (name: string, password: string, site?: string) =>
      ipcRenderer.invoke('player:loginPassword', name, password, site) as Promise<{
        ok: boolean
        error?: string
        message?: string
        retryAfter?: number
        player?: { uuid: string; name: string; site: string; email: string }
      }>,
    /**
     * 第二步：邮箱 + 验证码 → 建号/登录 → 正式会话。
     * `password` 可选：带上就是**首次绑定邮箱时顺手设置密码**。
     */
    login: (email: string, code: string, password?: string) =>
      ipcRenderer.invoke('player:login', email, code, password) as Promise<{
        ok: boolean
        error?: string
        message?: string
        player?: { uuid: string; name: string; site: string; email: string }
      }>,
    loginLittleSkin: (account: string, password: string) =>
      ipcRenderer.invoke('player:loginLittleSkin', account, password) as Promise<{
        ok: boolean; error?: string; message?: string
        player?: { uuid: string; name: string; site: string; email: string }
      }>,
    logout: () => ipcRenderer.invoke('player:logout') as Promise<{ ok: boolean }>,
    /** 已登记资料（只读展示用；未登录返回 null）。 */
    info: () =>
      ipcRenderer.invoke('player:info') as Promise<{ name: string; email: string; site: string } | null>
  },
  pack: {
    /** 整合包校验（M2）：只读比对，返回差异清单 + 目录三态。 */
    verify: () =>
      ipcRenderer.invoke('pack:verify') as Promise<{
        ok: boolean
        expected: number
        actual: number
        antiCheat?: boolean
        antiCheatFile?: string | null
        missing: string[]
        extra: string[]
        changed: string[]
        error?: string
        dirState?: 'ok' | 'empty' | 'missing' | 'unreadable'
        dir?: GameDirInfo
      }>
  },
  /**
   * 整合包更新（第 3 项）。`check`/`apply` 分开：检查永远无副作用。
   * 进度经 `update:progress` 推送（按字节算百分比，不按文件数）。
   */
  update: {
    onDownloadSpeed: (cb: (speed: DownloadSpeed) => void) => {
      const listener = (_event: IpcRendererEvent, speed: DownloadSpeed): void => cb(speed)
      ipcRenderer.on('download:speed', listener)
      return () => ipcRenderer.removeListener('download:speed', listener)
    },
    check: () =>
      ipcRenderer.invoke('update:check') as Promise<{
        ok: boolean
        error?: string
        packVersion?: string
        gameVersion?: string
        missing?: number
        changed?: number
        extra?: string[]
        upToDate?: boolean
        bytesTotal?: number
        noDownloadBase?: boolean
      }>,
    apply: () =>
      ipcRenderer.invoke('update:apply') as Promise<{
        ok: boolean
        error?: string
        applied?: number
        rolledBack?: boolean
        backupDir?: string
        resourcesRemoved?: number
      }>,
    onProgress: (cb: (p: UpdateProgressPayload) => void) => {
      const listener = (_e: IpcRendererEvent, p: UpdateProgressPayload): void => cb(p)
      ipcRenderer.on('update:progress', listener)
      return () => ipcRenderer.removeListener('update:progress', listener)
    },
    onDownloadActivity: (cb: (p: DownloadActivity) => void) => {
      const listener = (_e: IpcRendererEvent, p: DownloadActivity): void => cb(p)
      ipcRenderer.on('download:activity', listener)
      return () => ipcRenderer.removeListener('download:activity', listener)
    },
    /** 启动器**自身**更新（与整合包更新是两件事，见 SelfUpdateService 注释）。 */
    selfCheck: () =>
      ipcRenderer.invoke('update:self-check') as Promise<{
        currentVersion: string
        packaged: boolean
        available: boolean
        version?: string
        notes?: string
        error?: string
      }>,
    selfApply: () =>
      ipcRenderer.invoke('update:self-apply') as Promise<{ ok: boolean; error?: string }>,
    onSelfProgress: (cb: (p: { percent: number; message: string }) => void) => {
      const listener = (_e: IpcRendererEvent, p: { percent: number; message: string }): void => cb(p)
      ipcRenderer.on('update:self-progress', listener)
      return () => ipcRenderer.removeListener('update:self-progress', listener)
    }
  },
  server: {
    /** 服务器状态（真 ping，主进程做 Server List Ping；15 秒缓存）。 */
    status: () =>
      ipcRenderer.invoke('server:status') as Promise<{
        online: boolean
        ping?: number
        players?: { online: number; max: number }
        motd?: string
        error?: string
      }>
  },
  /**
   * 启动动画素材（"反作弊启动中"面板上面的视频）。
   *
   * ⚠️ 形状刻意**没有参数**：renderer 传不了路径，只能拿到主进程解析好的
   * `file://` URL。`url=null` 表示素材没放 ⇒ 界面回落成动态占位（不报错、不白屏）。
   */
  media: {
    startup: () =>
      ipcRenderer.invoke('media:startup') as Promise<{
        url: string | null
        path: string | null
        /** 找过的候选（顺序即优先级），排障用：`expected[0]` 就是"玩家该把文件放哪" */
        expected: string[]
      }>
  },
  /**
   * 启动动画**浮层**（屏幕右下角的独立窗口）。
   *
   * ⚠️ 界面**不需要**调它：浮层由主进程在启动成功那一刻自己开
   * （见 `doLaunch` 里的注释 —— 界面按钮与托盘菜单必须走同一条路）。
   * 这里留着是为了排障与自检能显式触发一次。
   */
  anim: {
    show: () =>
      ipcRenderer.invoke('anim:show') as Promise<{
        ok: boolean
        bounds: { x: number; y: number; width: number; height: number }
      }>
  },
  config: {
    get: () =>
      ipcRenderer.invoke('config:get') as Promise<{
        gameRoot: string
        java: string
        version: string
        factory: { gameRoot: string; version: string }
        settingsFile: string
        /** 生效目录的来源/三态（2026-09-18 加：界面要能说明"这个目录哪来的"） */
        resolved?: {
          source: string
          sourceLabel: string
          note: string
          modsDir: string
          modsState: 'ok' | 'empty' | 'missing' | 'unreadable'
          modsJars: number
          rejected: { raw: string; expanded: string; source: string }[]
          notices: { code: string; text: string; detail?: string }[]
        } | null
      } | null>,
    /** 启动后自动进入的服务器地址（从 programArgs 读；未配置返回空串）。 */
    target: () => ipcRenderer.invoke('config:target') as Promise<string>    ,
    /**
     * 「浏览…」：**只能**由主进程的原生目录选择器产生路径（renderer 传不了路径字符串）。
     * 选完立刻落盘到用户配置（%APPDATA%\<产品名>\settings.json）并回读生效值。
     */
    pick: (importOnly = false) =>
      ipcRenderer.invoke('config:pick', importOnly) as Promise<{
        ok: boolean
        canceled?: boolean
        picked?: string
        form?: string
        gameRoot?: string
        version?: string
        versionChanged?: boolean
        modsDir?: string
        modsState?: 'ok' | 'empty' | 'missing' | 'unreadable'
        notes?: string[]
        effective?: { gameRoot: string; version: string; source: string; sourceLabel: string } | null
        settingsFile?: string
      }>,
    /** 恢复默认（清掉玩家选择）。没有这个出口，选错一次就困住了。 */
    resetPath: () =>
      ipcRenderer.invoke('config:reset-path') as Promise<{
        ok: boolean
        settingsFile?: string
        effective?: { gameRoot: string; version: string; source: string } | null
      }>,
    /**
     * 「一键修复」：发现目录 → 建结构 → 差量补齐整合包 → 复检。
     * 返回**逐项**结论（不是一句"修复完成"）：能修的修掉，修不了的
     * （assets/libraries/Java 选择）如实列在 remaining 里。
     */
    repair: () =>
      ipcRenderer.invoke('config:repair') as Promise<{
        ok: boolean
        steps: { key: string; title: string; ok: boolean; changed: boolean; message: string; detail?: string }[]
        effective?: { gameRoot: string; version: string; source: string; sourceLabel: string } | null
        remaining: string[]
        pack?: unknown
      }>,
    /** 游戏运行参数（内存 / 分辨率 / 全屏）。set 返回**回读后的生效值**。 */
    /** 片 2：列出本机可用的 Java。 */
    /** 片 3：下载并安装 Java（返回 java.exe 路径或错误）。进度走 onJavaProgress。 */
    javaProvision: () =>
      ipcRenderer.invoke('java:provision') as Promise<{
        ok: boolean
        javaPath?: string
        mirror?: string
        error?: string
      }>,
    onJavaProgress: (cb: (p: { phase: string; percent: number; message: string }) => void) => {
      const listener = (_e: unknown, p: { phase: string; percent: number; message: string }): void => cb(p)
      ipcRenderer.on('java:progress', listener)
      return () => ipcRenderer.removeListener('java:progress', listener)
    },    javaList: () =>
      ipcRenderer.invoke('java:list') as Promise<
        Array<{ path: string; version: string; major: number; arch: string; from: string; usable: boolean }>
      >,
    runtimeGet: () =>
      ipcRenderer.invoke('settings:runtime:get') as Promise<{
        lowMemoryMode?: boolean
      memoryMb?: number
        gcMode?: 'template' | 'tuned'
        memoryCleanupEnabled?: boolean
        memoryCleanupNoticeSeen?: boolean
      gameImportNoticeSeen?: boolean
        width?: number
        height?: number
        fullscreen?: boolean
        autoMemoryMb?: number
        availableMb?: number
        modCount?: number
      }>,
    runtimeSet: (patch: {
      java?: string
      lowMemoryMode?: boolean
      memoryMb?: number
      gcMode?: 'template' | 'tuned'
      memoryCleanupEnabled?: boolean
      memoryCleanupNoticeSeen?: boolean
      gameImportNoticeSeen?: boolean
      width?: number
      height?: number
      fullscreen?: boolean
    }) =>
      ipcRenderer.invoke('settings:runtime:set', patch) as Promise<{
        lowMemoryMode?: boolean
      memoryMb?: number
        gcMode?: 'template' | 'tuned'
      memoryCleanupEnabled?: boolean
      memoryCleanupNoticeSeen?: boolean
      gameImportNoticeSeen?: boolean
        width?: number
        height?: number
        fullscreen?: boolean
        autoMemoryMb?: number
        availableMb?: number
        modCount?: number
      }>
  }
}

contextBridge.exposeInMainWorld('delta', api)

export type DeltaApi = typeof api
