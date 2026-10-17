import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import type { LaunchPreparation, LaunchCheck } from '../shared/LaunchPreparation'
import type { AnnouncementResult } from '../shared/Announcements'
import GameImportNotice from './components/GameImportNotice'
import DownloadDock from './components/DownloadDock'
import AcMonitorCard from './components/AcMonitorCard'
import RiceScene from './components/RiceScene'
import type { AcMonitorSnapshot } from '../shared/AcMonitor'
import type { DownloadSpeed, DownloadActivity } from '../shared/DownloadActivity'
// 只导入**类型**（`import type` 编译期就被抹掉）：渲染层不依赖主进程代码，
// 但"账号状态长什么样"这件事只该有一份定义 —— 各写一份迟早会漂移。

/**
 * Delta 启动器 · UI
 *
 * 版式严格照运维给的例图：
 *   自绘标题栏（左 logo / 中标语 / 右 语言·用户·窗口按钮）
 *   + 左侧图标导航 + 中间（Hero / 状态条 / 进度 / 配置行 / 启动按钮）+ 右侧（赛季·公告·更新·活动）
 *
 * 两条纪律：
 * 1. **只放真数据。** 例图里的"128/200 在线、36 ms"是设计稿的示意值，我们没有就不写，
 *    要么放真值（服务器状态是实打实 ping 出来的），要么写"待接入"。
 * 2. **不放路径设置。** 运维明确：这个启动器只启动我们的客户端，不给玩家改路径的口子。
 *    设置页只做只读展示，方便排障时一眼看到"它到底在用哪个实例"。
 *
 * 图片素材仍是留空位（`.img-placeholder`），把文件丢进 src/renderer/assets/ 再替换即可。
 */

interface ConsentState {
  accepted: boolean
  launcherCaptureAllowed?: boolean
  termsVersion: string
  acceptedAt: string | null
}

type LaunchState = { state: string; pid?: number; code?: number }
type ServerStatus = {
  online: boolean
  ping?: number
  players?: { online: number; max: number }
  motd?: string
  error?: string
}
type PackResult = {
  ok: boolean
  expected: number
  actual: number
  /** 清单里的反作弊客户端模组是否**当前在位**（状态栏那条"Anti-Cheat 已加载"靠它，不写死） */
  antiCheat?: boolean
  antiCheatFile?: string | null
  missing: string[]
  extra: string[]
  changed: string[]
  error?: string
  /** 目录三态（2026-09-18）：ok 正常 / empty 目录在但没 mods / missing 不存在 / unreadable 读不到 */
  dirState?: DirState
  dir?: GameDirInfo
}

/** 目录三态。三种的界面文案**必须不同**（运维要求：不要笼统的"读不到目录"）。 */
type DirState = 'ok' | 'empty' | 'missing' | 'unreadable'

/**
 * 生效游戏目录的信息（与主进程 `GamePaths` 对齐，三处声明之一 —— 另两处在
 * `preload/index.ts` 与组件参数类型里，改 IPC 形状时三处都要改，否则 TS2339/TS2353）。
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

/** 「浏览…」选目录的结果（主进程 `config:pick` / `config:reset-path` 的返回）。 */
type PickedGameDir = {
  ok: boolean
  canceled?: boolean
  picked?: string
  form?: string
  gameRoot?: string
  version?: string
  versionChanged?: boolean
  modsDir?: string
  modsState?: DirState
  notes?: string[]
  effective?: { gameRoot: string; version: string; source: string; sourceLabel: string } | null
  settingsFile?: string
}

/** 「一键修复」的逐项结论（主进程 `config:repair`）。 */
type RepairResult = {
  ok: boolean
  steps: { key: string; title: string; ok: boolean; changed: boolean; message: string; detail?: string }[]
  effective?: { gameRoot: string; version: string; source: string; sourceLabel: string } | null
  remaining: string[]
}

/**
 * 玩家系统会话（**准入**）。四态必须分开显示：
 * `unreachable` 与 `none` 对玩家的下一步动作完全不同——
 * 一个是"去登录"，一个是"检查网络"，混在一起会让人在错误的路上折腾。
 */
type PlayerSession = {
  state: 'ok' | 'none' | 'banned' | 'unreachable'
  name?: string
  email?: string
  site?: string
  reason?: string
  error?: string
}

/** 启动闸门的只读预演结果（与真正启动走同一段判定）。 */
type Preflight = {
  checks?: LaunchCheck[]
  ok: boolean
  code?: string
  message?: string
  player?: string
  pack?: { ok: boolean; expected: number; actual: number; error?: string; dirState?: DirState; dir?: GameDirInfo }
  /** 无论哪条分支早退都会带上：生效目录 + 三态（界面「浏览…」与文案的数据源） */
  dir?: GameDirInfo
  dirState?: DirState
}

/** 整合包更新（第 3 项）。 */
type UpdateCheck = {
  ok: boolean
  error?: string
  packVersion?: string
  gameVersion?: string
  missing?: number
  changed?: number
  extra?: string[]
  upToDate?: boolean
  bytesTotal?: number
  /** 清单里有条目但没有下载地址 ⇒ 服务端还没配好下载源 */
  noDownloadBase?: boolean
}
type UpdateProgress = {
  phase: 'idle' | 'checking' | 'downloading' | 'applying' | 'done' | 'error'
  percent: number
  doneFiles: number
  totalFiles: number
  bytesDone: number
  bytesTotal: number
  current?: string
  message?: string
}

type PopupProgress = {
  percent: number
  label: string
  detail?: string
  current?: string
  remaining?: string
}

/** 正版（微软）登录状态。`pending.session` **不含 deviceCode**（见 preload 注释）。 */
type McState =
  | { state: 'none' }
  | {
      state: 'pending'
      session: { userCode: string; verificationUri: string; interval: number; expiresAt?: number; message?: string }
    }
  | { state: 'ok'; profile: { uuid: string; name: string } }
  | { state: 'error'; error: string }

declare global {
  interface Window {
    delta: {
      anticheat: { status: () => Promise<AcMonitorSnapshot> }
      consent: {
        get: () => Promise<ConsentState>
        accept: (accepted: boolean) => Promise<ConsentState>
      }
      news: { get: () => Promise<AnnouncementResult> }
      launch: {
        onPreparation: (cb: (value: LaunchPreparation) => void) => () => void
        start: () => Promise<{ ok: boolean; pid?: number; error?: string }>
        state: () => Promise<LaunchState>
        /** 只读预演：不启动任何东西，只回答"现在点启动会发生什么"。 */
        preflight: () => Promise<Preflight>
        onState: (cb: (s: LaunchState) => void) => () => void
        onLog: (cb: (l: { line: string }) => void) => () => void
      }
      /** 反作弊启动浮层：启动流程开始就显示，避免校验卡住时玩家看不到状态。 */
      anim: {
        show: () => Promise<{ ok: boolean; bounds: { x: number; y: number; width: number; height: number } }>
      }
      window: { minimize: () => void; maximize: () => void; close: () => void }
      auth: {
        login: (
          username: string,
          password: string
        ) => Promise<{ ok: boolean; username?: string; uuid?: string; error?: string }>
        status: () => Promise<{ loggedIn: boolean; username?: string }>
        logout: () => Promise<{ ok: boolean }>
        /** 玩家头像（data URL）。主进程抓取 + 缓存；拿不到返回 null。 */
        avatar: (name: string) => Promise<string | null>
      }
      /** 正版（微软）登录。 */
      mc: {
        state: () => Promise<McState>
        start: () => Promise<{ ok: boolean; error?: string }>
        poll: () => Promise<McState>
        logout: () => Promise<{ ok: boolean }>
        openBrowser: () => Promise<{ ok: boolean }>
      }
      /** 玩家系统（**准入**）：与上面的 LittleSkin 登录是两件事，见 AccountPanel 注释。 */
      player: {
        status: () => Promise<PlayerSession>
        sendCode: (
          name: string,
          email: string,
          site?: string
        ) => Promise<{
          ok: boolean
          error?: string
          message?: string
          retryAfter?: number
          ttl?: number
          accepted?: boolean
          /** `same_email` = 这个角色已登记过（本次是登录，不是注册）。 */
          registered?: string
          dryRunCode?: string
        }>
        login: (
          email: string,
          code: string,
          /**
           * 可选：**首次绑定邮箱时顺手设置密码**（运维 2026-09-18 要求）。
           * 传了就存密码，之后登录走 `loginPassword`，不用再收验证码。
           */
          password?: string
        ) => Promise<{
          ok: boolean
          error?: string
          message?: string
          player?: { uuid: string; name: string; site: string; email: string }
        }>
        /** 这个角色该怎么登：有密码 ⇒ 只要密码；否则走邮箱验证码（并设密码）。**只读**，不发邮件。 */
        accountStatus: (name: string, site?: string) => Promise<{
          ok: boolean
          exists: boolean
          hasPassword: boolean
          /** 打码后的邮箱（`el***@gmail.com`）。 */
          emailMasked?: string
          message?: string
          error?: string
        }>
        /** 纯密码登录（账号绑过邮箱且设过密码时的主路径）。 */
        loginLittleSkin: (account: string, password: string) => Promise<{
          ok: boolean; error?: string; message?: string
          player?: { uuid: string; name: string; site: string; email: string }
        }>
        loginPassword: (
          name: string,
          password: string,
          site?: string
        ) => Promise<{
          ok: boolean
          error?: string
          message?: string
          retryAfter?: number
          player?: { uuid: string; name: string; site: string; email: string }
        }>
        logout: () => Promise<{ ok: boolean }>
        info: () => Promise<{ name: string; email: string; site: string } | null>
      }
      pack: { verify: () => Promise<PackResult> }
      update: {
        onDownloadSpeed: (cb: (speed: DownloadSpeed) => void) => () => void
        check: () => Promise<UpdateCheck>
        apply: () => Promise<{
          ok: boolean
          error?: string
          applied?: number
          rolledBack?: boolean
          backupDir?: string
          resourcesRemoved?: number
        }>
        onProgress: (cb: (p: UpdateProgress) => void) => () => void
        onDownloadActivity: (cb: (p: DownloadActivity) => void) => () => void
        /** 启动器**自身**更新（与整合包更新是两件事）。 */
        selfCheck: () => Promise<{
          currentVersion: string
          packaged: boolean
          available: boolean
          version?: string
          notes?: string
          error?: string
        }>
        selfApply: () => Promise<{ ok: boolean; error?: string }>
        onSelfProgress: (cb: (p: { percent: number; message: string }) => void) => () => void
      }
      config: {
        get: () => Promise<{
          gameRoot: string
          java: string
          version: string
          factory: { gameRoot: string; version: string }
          settingsFile: string
          /** 生效目录的来源与三态（2026-09-18） */
          resolved?: {
            source: string
            sourceLabel: string
            note: string
            modsDir: string
            modsState: DirState
            modsJars: number
            rejected: { raw: string; expanded: string; source: string }[]
            notices: { code: string; text: string; detail?: string }[]
          } | null
        } | null>
        /**
         * 「浏览…」：**只能**由主进程的原生目录选择器产生路径（renderer 传不了路径字符串）。
         * 选完立刻落盘到用户配置并回读生效值，界面据此重跑预检。
         */
        pick: (importOnly?: boolean) => Promise<PickedGameDir>
        /** 恢复默认（清掉玩家选择）。没有这个出口，选错一次就困住了。 */
        resetPath: () => Promise<{ ok: boolean; settingsFile?: string; effective?: { gameRoot: string; version: string; source: string } | null }>
        /** 「一键修复」：能修的修掉（目录/结构/整合包），修不了的逐条列出来。 */
        repair: () => Promise<RepairResult>
        target: () => Promise<string>
    /** 游戏运行参数（片 1 后半）：读回生效值 / 写入并返回**回读值**。 */
    /** 片 2：本机可用的 Java 列表。 */
    javaProvision: () => Promise<{ ok: boolean; javaPath?: string; mirror?: string; error?: string }>
    onJavaProgress: (
      cb: (p: { phase: string; percent: number; message: string }) => void
    ) => () => void
    javaList: () => Promise<
      Array<{ path: string; version: string; major: number; arch: string; from: string; usable: boolean }>
    >
    runtimeGet: () => Promise<{
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
      autoMemoryMb?: number
      availableMb?: number
      modCount?: number
    }>
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
    }) => Promise<{
      java?: string
      lowMemoryMode?: boolean
      memoryMb?: number
      gcMode?: 'template' | 'tuned'
      width?: number
      height?: number
      fullscreen?: boolean
          memoryCleanupEnabled?: boolean
          memoryCleanupNoticeSeen?: boolean
          gameImportNoticeSeen?: boolean
      autoMemoryMb?: number
      availableMb?: number
      modCount?: number
    }>
      }
      server: { status: () => Promise<ServerStatus> }
    }
  }
}

/* ------------------------------------------------------------------ Hero 场景图轮换 */

/**
 * 每次启动随机取一张地图场景图。
 *
 * 用法：把 `hero-1.png` … `hero-5.png` 丢进 `src/renderer/assets/`，重新构建即可——
 * 文件名匹配 `hero-*.{png,jpg,jpeg,webp}`，**不需要改代码**。
 *
 * 用 Vite 的 glob 而不是运行时读目录：文件不存在时它就是个空数组，
 * 界面回落成占位块（不报错、不白屏）。这是"素材还没到位也能先跑"的关键。
 *
 * ⚠️ **2026-09-18 修掉一个静默 bug**：以前这里是先把 `import.meta.glob` 赋给一个变量
 * （`const HERO_GLOB = ...glob`）再**间接调用**它。而 Vite 的 glob 是**构建期静态替换**，
 * 只认字面量形式 `import.meta.glob(...)` —— 间接调用不会被替换，运行时拿到的是 `undefined`，
 * 于是 `HEROES` 永远是空数组、**随机轮换从来没生效过**。
 * 之所以一直没人发现：以前一张 hero 图都没有，"空数组 ⇒ 占位块"与"没放图 ⇒ 占位块"
 * 表现完全一样 —— 又一个"看起来在跑，其实什么都没发生"。
 * 现在改成**直接调用**，并在 tsconfig 里补 `vite/client` 类型（否则 TS 不认识 `import.meta.glob`）。
 */
/**
 * Vite glob 在 `import: 'default'` 下的取值类型是 `unknown`（它推不出模块的默认导出类型），
 * 所以这里统一收口成 string —— 别在每个调用点写 `as string`，那会把"类型推不出来"这件事
 * 分散到三处，而其中一处迟早会漏。
 */
const firstUrl = (modules: Record<string, unknown>): string =>
  String(Object.values(modules)[0] ?? '')


/**
 * 右侧「赛季卡」的底图。与 Hero 同一套约定：把 `season.{png,jpg,jpeg,webp}` 丢进 assets 即可，
 * 没放就回落成占位块（不报错、不白屏）。
 *
 * ⚠️ 这一条**以前根本没接线**：`assets/README.md` 写着"丢进去重新构建就生效"，
 * 但代码里是写死的 `<ImgPlaceholder label="season.png">` —— 文件放进去也不会显示。
 * 2026-09-18 补接线时把 README 那句话也一并改了。
 */
const SEASON: string = firstUrl(
  import.meta.glob('./assets/season.{png,jpg,jpeg,webp}', {
    eager: true,
    query: '?url',
    import: 'default'
  })
)

/* ------------------------------------------------------------------ 图标（内联 SVG，不引依赖） */

type IconProps = { className?: string }
const S = (p: { children: React.ReactNode; className?: string }): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={p.className ?? 'h-5 w-5'}
  >
    {p.children}
  </svg>
)
const IconHome = (p: IconProps): React.JSX.Element => (
  <S className={p.className}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </S>
)
const IconNews = (p: IconProps): React.JSX.Element => (
  <S className={p.className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h6M7 13h10M7 17h7" />
  </S>
)
const IconGear = (p: IconProps): React.JSX.Element => (
  <S className={p.className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
  </S>
)
const IconServer = (p: IconProps): React.JSX.Element => (
  <S className={p.className}>
    <rect x="3" y="4" width="18" height="7" rx="1.5" />
    <rect x="3" y="13" width="18" height="7" rx="1.5" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </S>
)
const IconUsers = (p: IconProps): React.JSX.Element => (
  <S className={p.className}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M16 6.5a3 3 0 0 1 0 5.8M18 20c0-2 -.7-3.6-2-4.7" />
  </S>
)
const IconPing = (p: IconProps): React.JSX.Element => (
  <S className={p.className}>
    <path d="M3 17h3l3-8 3 12 3-14 2 10h4" />
  </S>
)
const IconCube = (p: IconProps): React.JSX.Element => (
  <S className={p.className}>
    <path d="M12 2.8 21 7.5v9L12 21.2 3 16.5v-9z" />
    <path d="M3 7.5l9 4.7 9-4.7M12 21.2v-9" />
  </S>
)
const IconGlobe = (p: IconProps): React.JSX.Element => (
  <S className={p.className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z" />
  </S>
)
const IconPlay = (p: IconProps): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={p.className ?? 'h-6 w-6'}>
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
)
/* ------------------------------------------------------------------ 小部件 */

function Stat({
  icon,
  label,
  value,
  sub,
  accent
}: {
  icon: React.JSX.Element
  label: string
  value: string
  sub?: string
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/5 text-delta-muted">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-delta-muted">{label}</div>
        <div className={`truncate text-sm font-semibold ${accent ? 'text-delta-ok' : 'text-delta-text'}`}>
          {value}
        </div>
        {sub && <div className="truncate text-[11px] text-delta-muted">{sub}</div>}
      </div>
    </div>
  )
}

/**
 * 只读信息格（**不是选择器**）。
 *
 * 2026-09-18 运维指出：「这些下拉菜单没办法有实际配置选择作用」—— 说得对，
 * 原来那四个是 `FakeSelect`（连名字都写着假的）：画着一个下拉箭头，
 * 点了没反应、也没有第二个选项，属于**假装能配置**。
 *
 * 现在的口径：**只显示真实生效的值，并且明确标出"固定"**。
 * 真能改的东西（打开游戏目录、重新校验、启动器更新）都在「设置」页，不在这里装样子。
 */


/* ------------------------------------------------------------------ 标题栏（含右上角用户） */

/** 未登录/无头像时的**灰色 Steve 剪影**（本地 SVG，不请求网络，也不像 debug 占位）。 */
function HeadSilhouette({ size }: { size: number }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className="shrink-0 rounded-full border border-white/10 bg-[#2a2f36]"
      aria-hidden
    >
      {/* 头 + 肩，纯几何，不涉及任何官方素材 */}
      <rect x="4.5" y="3" width="7" height="6.5" rx="1" fill="#4a5158" />
      <rect x="2.5" y="10.5" width="11" height="5" rx="1.5" fill="#3c4249" />
      <rect x="6" y="5.5" width="1.2" height="1.4" fill="#22262b" />
      <rect x="8.8" y="5.5" width="1.2" height="1.4" fill="#22262b" />
    </svg>
  )
}

/** 头像：有图显示图；没图按登录状态回落（未登录 = 灰剪影，登录了但取不到 = 首字母）。 */
function Avatar({
  name,
  src,
  size = 32
}: {
  name: string
  src: string | null
  size?: number
}): React.JSX.Element {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-full border border-white/10 bg-black/30 object-cover"
      />
    )
  }
  if (!name || name === '?') return <HeadSilhouette size={size} />
  return (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#2a2f36] text-sm font-bold text-white/70"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/**
 * 右上角账号区 = **玩家系统**（准入）。
 *
 * ⚠️ 这里**不再有离线模式**（第 2 项）：没有有效会话就没有启动游戏的资格。
 * 流程按服务端 `player-api.py` 的真实接口设计，两步：
 *   ① 角色名 + 邮箱 → `/api/register`（服务端去 LittleSkin 查这个角色**真实存在**，然后发验证码）
 *   ② 邮箱 + 验证码 → `/api/verify`（老玩家直接发会话）→ `/api/login` 换正式会话
 *
 * 为什么不在这里放 LittleSkin 密码：密码换的是 `accessToken`（**皮肤**），
 * 与"允不允许进服"是两件事；把两件事塞进一个面板，只会让人以为"输了密码就算登录了"。
 * 皮肤登录另有入口，见界面上的说明。
 */
/** 登录方式（身份来源）。见 `AccountPanel` 与 `server/player-api.py` 的 `SITES`。 */
export type LoginSite = 'littleskin' | 'premium'

const SITE_LABEL: Record<LoginSite, string> = {
  littleskin: 'LittleSkin',
  premium: '正版登录'
}

function AccountPanel({ player, site, setSite, onChanged, onFeedback }: {
  player: PlayerSession
  site: LoginSite
  setSite: (s: LoginSite) => void
  onChanged: () => void
  onFeedback: (line: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  useEffect(() => { const openLogin = (): void => setOpen(true); window.addEventListener('breakline-open-login', openLogin); return () => window.removeEventListener('breakline-open-login', openLogin) }, [])
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [microsoft, setMicrosoft] = useState<McState>({ state: 'none' })
  const attempt = useRef(0)
  const box = useRef<HTMLDivElement>(null)
  const loggedIn = player.state === 'ok'
  useEffect(() => {
    let cancelled = false
    setAvatar(null)
    if (loggedIn && player.name) void window.delta.auth.avatar(player.name).then((src) => {
      if (!cancelled) setAvatar(src)
    })
    return () => { cancelled = true }
  }, [loggedIn, player.name])
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (box.current && !box.current.contains(event.target as Node)) {
        setOpen(false); setPassword('')
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const login = async (): Promise<void> => {
    if (busy) return
    if (!account.trim() || !password) { setError('请输入 LittleSkin 账号和密码'); return }
    setBusy(true); setError('')
    try {
      const result = await window.delta.player.loginLittleSkin(account.trim(), password)
      setPassword('')
      if (!result.ok) { setError(result.message ?? 'LittleSkin 登录失败'); return }
      setSite('littleskin')
      onFeedback('[launcher] LittleSkin 身份验证通过')
      onChanged(); setOpen(false)
    } catch {
      setPassword(''); setError('登录服务暂不可用，请稍后重试')
    } finally { setBusy(false) }
  }
  async function loginMicrosoft(): Promise<void> {
    if (busy) return
    const current = ++attempt.current
    setBusy(true); setError(''); setMicrosoft({ state: 'none' })
    try {
      const started = await window.delta.mc.start()
      if (!started.ok) throw new Error(started.error ?? '无法获取微软登录码')
      const state = await window.delta.mc.state()
      if (current !== attempt.current) return
      setMicrosoft(state)
      const result = await window.delta.mc.poll()
      if (current !== attempt.current) return
      setMicrosoft(result)
      if (result.state !== 'ok') throw new Error(result.state === 'error' ? result.error : '微软登录已取消')
      setSite('premium'); onChanged(); setOpen(false)
      onFeedback('[launcher] 微软正版身份验证通过')
    } catch (failure) {
      if (current === attempt.current) {
        const message = failure instanceof Error ? failure.message : '微软登录失败，请重试'
        setError(message)
        onFeedback(`[launcher] 微软登录未完成：${message}`)
      }
    } finally { if (current === attempt.current) setBusy(false) }
  }
  async function cancelMicrosoft(): Promise<void> {
    attempt.current++; await window.delta.mc.logout(); setMicrosoft({ state: 'none' }); setBusy(false); setError('')
  }
  return <div ref={box} className="relative">
    <button onClick={() => { setOpen(!open); setPassword(''); setError('') }}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
      <Avatar name={loggedIn ? (player.name ?? '?') : '?'} src={avatar} size={32} />
      <span className="text-left leading-none">
        <span className="block text-xs font-semibold">{loggedIn ? player.name : '未登录'}</span>
        <span className="mt-1 flex items-center gap-1 text-[10px] text-delta-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${loggedIn ? 'bg-delta-ok' : 'bg-white/25'}`} />
          {loggedIn ? '在线' : site === 'premium' ? '微软正版' : 'LittleSkin'}
        </span>
      </span>
    </button>
    <AnimatePresence>{open && <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }} className="panel-raised dialog-surface absolute right-0 top-12 z-30 w-[22rem] p-4 shadow-2xl">
      {loggedIn ? <>
        <div className="flex items-center gap-3"><Avatar name={player.name ?? '?'} src={avatar} size={48} />
          <div><div className="text-sm font-semibold">{player.name}</div>
            <div className="mt-1 text-[11px] text-delta-muted">{site === 'premium' ? '微软正版已登录' : 'LittleSkin 已登录'}</div></div></div>
        <button className="mt-4 w-full rounded-lg border border-white/10 py-2 text-xs hover:bg-white/5"
          onClick={async () => { await window.delta.player.logout(); await window.delta.auth.logout(); await window.delta.mc.logout(); setPassword(''); onChanged(); setOpen(false) }}>
          退出登录</button>
      </> : <>
        <div className="mb-4 flex gap-2" role="group" aria-label="登录方式">
          {(['littleskin', 'premium'] as const).map(method => <button key={method} disabled={busy}
            onClick={() => { setSite(method); setError(''); setPassword('') }}
            className={`flex-1 rounded-lg border py-2 text-xs ${site === method ? 'border-delta-accent text-delta-accent' : 'border-white/10'}`}>
            {method === 'premium' ? '微软正版' : 'LittleSkin'}</button>)}
        </div>
        {site === 'premium' ? <div>
          <div className="text-sm font-semibold">用微软账号登录</div>
          <p className="mt-2 text-[11px] leading-relaxed text-delta-muted">密码只在微软页面里输入。需要拥有 Minecraft Java 版的账号。</p>
          {microsoft.state === 'pending' && <div className="mt-4 rounded-lg border border-white/10 p-3 text-center">
            <div className="text-[11px] text-delta-muted">在微软网页输入登录码</div>
            <div className="mt-2 select-text font-mono text-2xl tracking-widest">{microsoft.session.userCode}</div>
            <button className="mt-3 text-xs text-delta-accent" onClick={() => void window.delta.mc.openBrowser()}>打开微软登录网页</button>
          </div>}
          {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
          {busy ? <button onClick={() => void cancelMicrosoft()} className="mt-4 w-full rounded-lg border border-white/10 py-2.5 text-sm">取消登录</button>
            : <button onClick={() => void loginMicrosoft()} className="mt-4 w-full rounded-lg bg-delta-accent py-2.5 text-sm font-semibold text-black">获取微软登录码</button>}
        </div> : <form onSubmit={(event) => { event.preventDefault(); void login() }}>
        <div className="text-sm font-semibold">登录 LittleSkin</div>
        <p className="mt-1 text-[11px] leading-relaxed text-delta-muted">使用 LittleSkin 账号登录，原有角色资产将自动保留。</p>
        <label className="mt-4 block text-xs">LittleSkin 账号或邮箱
          <input autoComplete="username" value={account} disabled={busy} onChange={(event) => setAccount(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/10 px-3 py-2 outline-none focus:border-delta-accent" /></label>
        <label className="mt-3 block text-xs">LittleSkin 密码
          <input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/10 px-3 py-2 outline-none focus:border-delta-accent" /></label>
        {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
        {player.state === 'banned' && <p className="mt-3 text-xs text-red-500">账号已被封禁：{player.reason}</p>}
        <button type="submit" disabled={busy} className="mt-4 w-full rounded-lg bg-delta-accent py-2.5 text-sm font-semibold text-black disabled:opacity-50">
          {busy ? '正在验证…' : '登录'}</button>
        <p className="mt-2 text-[10px] text-delta-muted">密码仅提交给 LittleSkin，不发送到游戏服务器。</p>
      </form>}</>}
    </motion.div>}</AnimatePresence>
  </div>
}

function TitleBar({
  player,
  site,
  setSite,
  onPlayerChanged,
  onFeedback
}: {
  player: PlayerSession
  /** 当前登录方式（身份来源）。状态挂在 App 上：标题栏显示它、账号浮层改它。 */
  site: LoginSite
  setSite: (s: LoginSite) => void
  onPlayerChanged: () => void
  onFeedback: (line: string) => void
}): React.JSX.Element {
  const ok = player.state === 'ok'
  return (
    <header className="drag-region relative z-[80] flex h-16 shrink-0 items-center gap-4 border-b border-white/5 bg-delta-bg-2 px-4">
      <div className="origin-wordmark" role="img" aria-label="断界行动 起源">
        <span className="origin-wordmark-title" data-text="断界行动" aria-hidden="true">断界行动</span>
        <span className="origin-wordmark-edition" aria-hidden="true">起源</span>
      </div>

      {/* 中：一行状态（不写标语，写实情） */}
      <div className="flex flex-1 items-center justify-center gap-2">
        <span className={ok ? 'h-1.5 w-1.5 rounded-full bg-delta-ok' : 'h-1.5 w-1.5 rounded-full bg-white/25'} />
        <span className="text-xs text-delta-muted">
          {ok ? '已登录' : '登录后启动游戏'}
        </span>
      </div>

      {/* 右：登录方式 · 账号 · 窗口按钮 */}
      <div className="no-drag flex items-center gap-3">
        {/*
          这里原来是例图里的"简体中文"——一个**没有任何功能的假下拉框**
          （点它什么都不会发生）。2026-09-17 按运维要求换成**登录方式**：
          它不再是装饰，而是真的反映当前选的身份来源。

          为什么这里只读、切换放在账号浮层里：两处都能改的话，早晚会出现
          "上面显示正版、实际按 LittleSkin 发请求"这种对不上的状态。
          点击它 = 刷新一次状态（纯只读动作），切换请点右边的账号区。
        */}
        <button
          onClick={onPlayerChanged}
          title="当前登录方式（在右侧账号区里切换）"
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-delta-muted hover:bg-white/5"
        >
          <IconGlobe className="h-4 w-4" />
          {SITE_LABEL[site]}
        </button>

        <AccountPanel
          player={player}
          site={site}
          setSite={setSite}
          onChanged={onPlayerChanged}
          onFeedback={onFeedback}
        />

        <div className="ml-1 flex items-center gap-1 border-l border-white/10 pl-2">
          <button
            onClick={() => window.delta.window.minimize()}
            className="flex h-8 w-8 items-center justify-center rounded text-delta-muted hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            onClick={() => window.delta.window.maximize()}
            className="flex h-8 w-8 items-center justify-center rounded text-delta-muted hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="5" width="14" height="14" rx="1" />
            </svg>
          </button>
          <button
            onClick={() => window.delta.window.close()}
            className="flex h-8 w-8 items-center justify-center rounded text-delta-muted hover:bg-red-500 hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ 左侧导航 */

const NAV = [
  { key: 'home', label: '首页', en: 'Home', icon: IconHome },
  { key: 'news', label: '新闻资讯', en: 'News', icon: IconNews },
  { key: 'settings', label: '设置', en: 'Settings', icon: IconGear }
] as const
type PageKey = (typeof NAV)[number]['key']

function Sidebar({
  page,
  setPage
}: {
  page: PageKey
  setPage: (p: PageKey) => void
}): React.JSX.Element {
  return (
    <aside className="flex w-[168px] shrink-0 flex-col border-r border-white/5 bg-delta-bg-2/60">
      <nav className="flex flex-col gap-1 p-2">
        {NAV.map((n) => {
          const Icon = n.icon
          const active = page === n.key
          return (
            <button
              key={n.key}
              onClick={() => setPage(n.key)}
              className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                active ? 'bg-white/[0.07] text-white' : 'text-delta-muted hover:bg-white/[0.04]'
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r bg-delta-accent" />
              )}
              <Icon className={`h-[18px] w-[18px] ${active ? 'text-delta-accent' : ''}`} />
              <span className="leading-none">
                <span className="block text-[13px] font-medium">{n.label}</span>
                <span className="mt-1 block text-[9px] tracking-widest opacity-60">{n.en}</span>
              </span>
            </button>
          )
        })}
      </nav>
      <div className="mt-auto p-4">
        <div className="text-[9px] tracking-[0.16em] text-delta-muted/70">BREAKLINE LAUNCHER</div>

      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ 首页 */

function Home({
  launchState,
  phase,
  onLaunch,
  log,
  onMore,
  target,
  preflight,
  playerOk,
  onDirChanged,
  memoryCleanupEnabled,
  onMemoryCleanupToggle
}: {
  launchState: LaunchState
  phase: string
  onLaunch: () => void
  log: string[]
  onMore: () => void
  target: string
  /** 启动闸门的预演结论（与真正启动同一段判定）。null = 还没算出来。 */
  preflight: Preflight | null
  playerOk: boolean
  /** 目录变更（玩家点了「浏览…」）后让 App 层立刻重跑预检 —— 不许要求重启启动器。 */
  onDirChanged: () => Promise<void>
  memoryCleanupEnabled: boolean
  onMemoryCleanupToggle: (enabled: boolean) => void
}): React.JSX.Element {
  const [preparation, setPreparation] = useState<LaunchPreparation | null>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [launcherUpdateAvailable, setLauncherUpdateAvailable] = useState(false)
  const [selfUpdating, setSelfUpdating] = useState(false)
  const running = selfUpdating || preparation?.running === true || launchState.state === 'running' || launchState.state === 'starting'
  const needsInstall = preflight?.code === 'env_problem' || preflight?.dirState === 'missing' || preflight?.dirState === 'empty'
  useEffect(() => window.delta.launch.onPreparation(setPreparation), [])
  useEffect(() => {
    let alive = true
    const check = (): void => { void window.delta.update.check().then(result => { if (alive && result.ok) setUpdateAvailable(result.upToDate === false) }).catch(() => {}) }
    if (!running) { check(); void window.delta.update.selfCheck().then(result => { if (alive) setLauncherUpdateAvailable(result.available) }).catch(() => {}) }
    const timer = setInterval(() => { if (!running) check() }, 90_000)
    const off = window.delta.update.onProgress(value => { if (value.phase === 'done') { setUpdateAvailable(false); void onDirChanged() } })
    return () => { alive = false; clearInterval(timer); off() }
  }, [running])
  /** 被闸门挡住：**按钮不装死**，点得动、点了能看到原因（见下面 onLaunch 的注释）。 */
  const blocked = preflight !== null && !preflight.ok
  /** 挡住的原因是"身份/连通性"：这类问题的下一步是去登录，不是去改目录。 */
  const sessionBlocked =
    preflight?.code === 'no_session' ||
    preflight?.code === 'session_invalid' ||
    preflight?.code === 'api_unreachable'
  /**
   * 横幅里要不要给"目录"这一块（含「浏览…」）。
   * 判据：**挡住启动的原因与目录有关**。`unreadable` 例外——那是权限/磁盘故障，
   * 无论身份如何都值得当场给入口（它也可能是"选错了目录"造成的）。
   */
  const dirHelpful =
    preflight?.dirState === 'unreadable' ||
    (!sessionBlocked &&
      (preflight?.code === 'env_problem' ||
        preflight?.code === 'pack_mismatch' ||
        preflight?.code === 'no_profile' ||
        preflight?.dirState === 'missing' ||
        preflight?.dirState === 'empty'))
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [pack, setPack] = useState<PackResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [picked, setPicked] = useState<PickedGameDir | null>(null)
  const [picking, setPicking] = useState(false)
  const [repair, setRepair] = useState<RepairResult | null>(null)
  const [repairing, setRepairing] = useState(false)

  useEffect(() => {
    void window.delta.server.status().then(setStatus)
    void window.delta.pack.verify().then(setPack)
  }, [])

  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      setPack(await window.delta.pack.verify())
    } finally {
      setChecking(false)
    }
  }

  /**
   * 「浏览…」：选完**立刻**重跑"整合包校验 + 预检"，并把结果显示在同一屏。
   * 这是运维 2026-09-18 的要求（"选完立刻重跑一次预检，不要要求玩家重启"）——
   * 也顺手解决了一个老毛病：玩家改完路径只看到"没变化"，只能靠重启碰运气。
   */
  const pickDir = async (): Promise<void> => {
    setPicking(true)
    try {
      const res = await window.delta.config.pick(true)
      setPicked(res)
      if (!res.canceled) {
        await recheck()
        await onDirChanged()
      }
    } finally {
      setPicking(false)
    }
  }

  /** 「一键修复」：修完立刻重跑校验 + 预检，结果就地显示（不要求重启启动器）。 */
  const repairDir = async (): Promise<void> => {
    setRepairing(true)
    setRepair(null)
    setPicked(null)
    try {
      const res = await window.delta.config.repair()
      setRepair(res)
      await recheck()
      await onDirChanged()
    } finally {
      setRepairing(false)
    }
  }

  const online = status?.online === true
  const total = pack ? pack.expected : 0
  const good = pack ? pack.expected - pack.missing.length - pack.changed.length : 0
  const pct = total > 0 ? Math.round((good / total) * 100) : 0

  return (
    <div className="flex h-full gap-3 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        <div className="xl:hidden"><AcMonitorCard /></div>
        <RiceScene />
        {/* 状态条：四个格子，数字全部来自真实查询 */}
        <div className="panel flex items-center gap-4 p-3.5">
          <Stat
            icon={<IconServer className="h-[18px] w-[18px]" />}
            label="服务器状态"
            value={online ? '在线' : status ? '离线' : '查询中…'}
            sub={online ? 'ONLINE' : status?.error ? '无法连接' : undefined}
            accent={online}
          />
          <span className="h-8 w-px bg-white/10" />
          <Stat
            icon={<IconUsers className="h-[18px] w-[18px]" />}
            label="当前在线玩家"
            value={status?.players ? `${status.players.online} / ${status.players.max}` : '—'}
          />
          <span className="h-8 w-px bg-white/10" />
          <Stat
            icon={<IconPing className="h-[18px] w-[18px]" />}
            label="延迟（Ping）"
            value={status?.ping != null ? `${status.ping} ms` : '—'}
          />
          <span className="h-8 w-px bg-white/10" />
          <Stat
            icon={<IconCube className="h-[18px] w-[18px]" />}
            label="版本与模组环境"
            value="1.20.1 · Forge + TaCZ"
            sub={pack ? `整合包 ${pack.expected} 个模组` : undefined}
          />
        </div>

        {(blocked || preparation) && <div className="panel px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{preparation?.running ? '正在自动准备游戏' : sessionBlocked ? '先登录，再一键进入游戏' : blocked ? '点击下方主按钮，自动完成准备' : '游戏已准备好'}</span>
            <button onClick={() => void pickDir()} disabled={running || picking || repairing} className="ml-auto text-xs text-delta-accent">导入已有游戏包</button>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(preparation?.running ? preparation.checks : preflight?.checks ?? []).map(check => <div key={check.key} className="rounded-lg bg-black/5 px-3 py-2">
              <div className="text-xs font-medium"><span className={check.status === 'ready' ? 'text-delta-ok' : 'text-delta-accent'}>{check.status === 'ready' ? '✓ ' : check.status === 'working' ? '◌ ' : '○ '}</span>{check.title}<span className="ml-2 text-[10px] text-delta-muted">{check.status === 'ready' ? '已通过' : check.status === 'working' ? '处理中' : check.key === 'account' ? '需要登录' : '自动准备'}</span></div>
              <div className="mt-1 break-words text-[11px] text-delta-muted">{check.message}</div>
            </div>)}
          </div>
          {preflight?.message && !preparation?.running && <p className="mt-2 text-xs text-delta-muted">{preflight.message}</p>}
          {dirHelpful && <p className="mt-2 truncate text-[10px] text-delta-muted" title={preflight?.dir?.gameRoot}>游戏位置：{preflight?.dir?.gameRoot}</p>}
        </div>}

        {/* 完整性校验（对应例图的下载进度条） */}
        <div className="panel p-3.5">
          <div className="flex items-center gap-3">
            <IconCube className="h-4 w-4 text-delta-accent" />
            <span className="text-xs text-delta-text">
              {checking ? '正在检查模组文件…' : total === 0 ? '尚未完成客户端校验' : pack?.ok ? '模组文件校验通过' : '客户端完整性校验'}
            </span>
            <span className="ml-auto text-xs text-delta-muted">
              {pack && total > 0 ? `${good} / ${total} 个文件` : '待校验'}
            </span>
            <button
              onClick={() => void recheck()}
              disabled={checking}
              className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-delta-muted hover:bg-white/5 disabled:opacity-40"
            >
              重新校验
            </button>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <motion.div
              className={`h-full ${pack?.ok ? 'glow-ok bg-delta-ok' : 'bg-delta-accent'}`}
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
          {pack && !pack.ok && (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-delta-muted">
                {total > 0 && <span>缺失 {pack.missing.length} · 多出 {pack.extra.length} · 被改动 {pack.changed.length}</span>}
                <span>点击下方主按钮即可自动补齐，无需手动找文件。</span>
              </div>
              <details className="mt-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2" >
                <summary className="cursor-pointer text-[11px] text-delta-muted">查看详情</summary>
                <div className="mt-2 break-all text-[10px] text-delta-muted">
                  mods：{pack.dir?.modsDir ?? '—'}
                  {pack.dir?.sourceLabel ? `（${pack.dir.sourceLabel}）` : ''}
                </div>
                {pack.dirState && (
                  <div className="mt-0.5 text-[11px] text-delta-text/85">
                    {DIR_STATE_TEXT[pack.dirState]}
                    {pack.dir ? `（现有 ${pack.dir.modsJars} 个 jar）` : ''}
                  </div>
                )}
                <DirNotices notices={pack.dir?.notices} rejected={pack.dir?.rejected} compact />
                <RepairResultBox r={repair} running={repairing} />
              </details>
            </>
          )}
          {picked && (
            <details className="mt-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2">
              <summary className="cursor-pointer text-[11px] text-delta-muted">查看处理结果</summary>
              <PickResultBox r={picked} />
            </details>
          )}
        </div>

        <details className="panel p-3 text-xs text-delta-muted"><summary className="cursor-pointer">高级选项：单独检查更新</summary><div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2"><UpdateCard onDone={() => { void recheck(); void onDirChanged() }} /><SelfUpdateCard /></div></details>

        <div className="launch-actions sticky bottom-0 z-10 flex shrink-0 items-center justify-end gap-4 py-3.5">
          <button disabled={running || picking || repairing} onClick={() => void pickDir()} className="mr-auto text-xs text-delta-muted hover:text-delta-accent">导入已有游戏包</button>
          <label className="flex cursor-pointer select-none items-center gap-2 text-[11px] text-delta-muted">
            <input
              type="checkbox"
              checked={memoryCleanupEnabled}
              disabled={running}
              onChange={(event) => onMemoryCleanupToggle(event.currentTarget.checked)}
              className="h-4 w-4 accent-delta-accent"
            />
            <span>内存优化模式</span>
          </label>
          <motion.button
            whileHover={{ scale: running ? 1 : 1.02 }}
            whileTap={{ scale: running ? 1 : 0.98 }}
            onClick={() => {
              if (launcherUpdateAvailable) {
                setSelfUpdating(true)
                void window.delta.update.selfApply().then(result => { if (!result.ok) setRepair({ ok: false, steps: [], remaining: [result.error ?? '更新暂未完成，点击继续下载即可续传'] }) }).catch(error => setRepair({ ok: false, steps: [], remaining: [String(error)] })).finally(() => setSelfUpdating(false))
              } else if (updateAvailable && !needsInstall && playerOk) void repairDir()
              else onLaunch()
            }}
            disabled={running}
            className={`launch-glow flex h-[52px] shrink-0 items-center gap-3 rounded-lg px-7 ${
              running
                ? 'bg-white/10 text-delta-muted'
                : blocked
                  ? // 被挡时**仍然可点**：点一下会把闸门的原因写进下面的日志，
                    // 比一个灰按钮更有用（灰按钮会让玩家只会来问"为什么点不动"）。
                    'border border-white/15 bg-white/10 text-delta-text'
                  : 'bg-gradient-to-r from-delta-accent to-delta-accent-2 text-black'
            }`}
          >
            <IconPlay className="h-5 w-5" />
            <span className="text-[15px] font-black">{running ? selfUpdating ? '正在更新启动器…' : preparation?.running ? '正在自动准备…' : phase : launcherUpdateAvailable ? '更新启动器' : !playerOk ? '登录并开始' : needsInstall ? '安装并启动' : updateAvailable ? '更新客户端' : '启动游戏'}</span>
          </motion.button>
        </div>

        {/* 日志框：只在「正在启动」或「真的出问题」时出现。
            2026-09-18 运维要求：修好之后的例行成功日志
            （`[launcher] 整合包校验通过：79/79 个文件与清单一致 √`）不该常驻玩家界面 ——
            那是控制台口吻。日志本身仍然留在内存里（排障要用），只是默认不渲染。 */}
        {(() => {
          const problems = log.filter((l) => /失败|错误|异常|无法|error|Error|请/.test(l))
          if (!running && log.length === 0) return null
          const shown = log.slice(-30)
          return (
            <details open={launchState.state === 'exited' || problems.length > 0} className="panel p-3 text-[11px] text-delta-muted">
              <summary className="cursor-pointer">查看启动日志</summary>
              <div className="mt-2 max-h-32 overflow-y-auto font-mono leading-relaxed select-text">
                {shown.map((l, i) => (
                  <div key={i} className="break-all">{l}</div>
                ))}
              </div>
            </details>
          )
        })()}

      </div>

      <RightRail target={target} onMore={onMore} />
    </div>
  )
}

/* ------------------------------------------------------------------ 右侧栏 */

/** 公告/更新/活动：**内容是真的**（反作弊与整合包的事实），没有的写"待接入"。
 *  正文默认收起——1280×720 下右侧最容易变成"字墙"，点标题才展开。 */
function useAnnouncements(): AnnouncementResult {
  const [result, setResult] = useState<AnnouncementResult>({ items: [], cached: false })
  useEffect(() => {
    let active = true
    const refresh = (): void => { void window.delta.news.get().then(value => { if (active) setResult(value) }).catch(() => {}) }
    refresh(); const timer = setInterval(refresh, 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  return result
}
function RightRail({
  target,
  onMore
}: {
  target: string
  onMore: () => void
}): React.JSX.Element {
  const news = useAnnouncements()
  const [open, setOpen] = useState(0)
  const [showAddr, setShowAddr] = useState(false)
  const Head = ({ cn, en }: { cn: string; en: string }): React.JSX.Element => (
    <div className="flex items-center gap-2">
      <span className="h-3.5 w-[3px] rounded bg-delta-accent" />
      <span className="text-xs font-semibold">{cn}</span>
      <span className="eyebrow ml-1">{en}</span>
      <button
        onClick={onMore}
        className="ml-auto flex items-center gap-0.5 text-[10px] text-delta-muted hover:text-delta-accent"
      >
        查看更多
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
    </div>
  )
  return (
    <div className="hidden w-[248px] shrink-0 flex-col gap-3 overflow-y-auto pl-1 xl:flex">
      <AcMonitorCard image={SEASON} />

      <div className="panel p-3.5">
        <Head cn="公告" en="Announcements" />
        {!news.items.length && <p className="mt-3 text-xs text-delta-muted">{news.error ?? '正在获取服务器更新公告…'}</p>}
        <div className="mt-3 flex flex-col gap-1">
          {news.items.slice(0, 3).map((a, i) => (
            <div key={a.title} className="rounded-lg hover:bg-white/[0.03]">
              <button
                onClick={() => setOpen(i === open ? -1 : i)}
                className="flex w-full items-start gap-2 px-1 py-1.5 text-left"
              >
                <span
                  className={`mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                    a.tone === 'accent'
                      ? 'bg-delta-accent/15 text-delta-accent'
                      : 'bg-white/10 text-delta-muted'
                  }`}
                >
                  {a.tag}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] leading-snug text-delta-text/90">
                    {a.title}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-delta-muted">{a.date}</span>
                </span>
                <svg
                  viewBox="0 0 24 24"
                  className={`mt-1 h-3 w-3 shrink-0 text-delta-muted transition-transform ${
                    i === open ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              <AnimatePresence initial={false}>
                {i === open && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <p className="px-2 pb-2 text-[11px] leading-relaxed text-delta-muted">
                      {a.body}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>

      <div className="panel p-3.5 text-[11px] leading-relaxed text-delta-muted">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold text-delta-text">进入服务器</div>
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-delta-muted">
            CN-01 · 主城
          </span>
        </div>
        {/* IP 不常年裸在首页：要看再点出来（服务器详情的雏形） */}
        <button
          onClick={() => setShowAddr((v) => !v)}
          className="mt-2 font-mono text-[11px] text-delta-muted hover:text-delta-accent"
        >
          {showAddr ? target || '未配置' : '显示服务器地址'}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 模组管理 */

/**
 * 整合包更新卡片（第 3 项）。
 *
 * 两条纪律：
 * 1. **检查无副作用**：`update:check` 只读，界面可以放心在进页面时自动跑一次。
 *    只有点"立即更新"才会写磁盘。
 * 2. **百分比按字节算**：按文件数算的话，下到一个 200 MB 的大 jar 时进度条会一动不动，
 *    玩家会以为卡死并强退——而那正好会把更新打断在一次替换中间。
 */
function UpdateCard({ onDone }: { onDone?: () => void }): React.JSX.Element {
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState<UpdateProgress | null>(null)
  const [note, setNote] = useState('')
  const [statusOpen, setStatusOpen] = useState(false)

  const doCheck = async (clearNote = true): Promise<void> => {
    setBusy(true)
    if (clearNote) setNote('')
    try {
      const result = await window.delta.update.check()
      setCheck(result)
      if (result.ok && !result.upToDate) setStatusOpen(true)
    } catch (error) {
      setCheck({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void doCheck()
    const off = window.delta.update.onProgress(setProg)
    return off
  }, [])

  const doApply = async (): Promise<void> => {
    if (busy || !check?.ok || check.upToDate) return
    setBusy(true)
    setNote('')
    setStatusOpen(true)
    try {
      const r = await window.delta.update.apply()
      if (r.ok) {
        setNote(`已更新 ${r.applied} 个模组，已删除 ${r.resourcesRemoved ?? 0} 个过期官方资源文件${r.backupDir ? '（旧模组已备份）' : ''}`)
        onDone?.()
        await doCheck(false)
      } else {
        setNote(
          `更新失败：${r.error ?? ''}${r.rolledBack === true ? '（已回滚，模组保持原样）' : r.rolledBack === false ? '（⚠️ 回滚未完成，请把这条发给管理员）' : '（尚未替换游戏模组，可重试）'}`
        )
      }
    } catch (error) {
      setNote(`更新未完成：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
      setProg(null)
    }
  }

  const todo = (check?.missing ?? 0) + (check?.changed ?? 0)
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`
  const downloading = prog?.phase === 'downloading' || prog?.phase === 'applying'

  return (
    <div className="panel p-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">客户端更新</div>
          <div className="mt-1 text-[11px] text-delta-muted">自动检查版本与文件</div>
        </div>
        <button
          onClick={() => void (!check?.ok || check.upToDate ? doCheck() : doApply())}
          disabled={busy || downloading}
          className={`ml-auto shrink-0 rounded-lg px-4 py-2 text-xs font-bold disabled:opacity-50 ${
            check?.upToDate
              ? 'border border-white/15 text-delta-text hover:bg-white/5'
              : 'bg-delta-accent text-black'
          }`}
        >
          {busy || downloading ? (downloading ? '更新中…' : '检查中…') : check?.upToDate ? '重新检查' : todo > 0 ? `立即更新（${todo}）` : '检查更新'}
        </button>
      </div>

      {check && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {!check.ok ? (
            <span className="text-red-400">检查失败：{check.error}</span>
          ) : check.upToDate ? (
            <span className="text-delta-ok">✓ 已是最新（整合包 {check.packVersion ?? '—'}）</span>
          ) : (
            <>
              <span className="text-delta-accent">需要更新</span>
              <span className="text-delta-muted">缺失 {check.missing}</span>
              <span className="text-delta-muted">被改动 {check.changed}</span>
              <span className="text-delta-muted">共 {mb(check.bytesTotal ?? 0)}</span>
            </>
          )}
          {(check.extra?.length ?? 0) > 0 && (
            <span className="text-delta-accent">
              额外文件 {check.extra?.length} 项
            </span>
          )}
        </div>
      )}

      {(downloading || note) && (
        <button
          type="button"
          onClick={() => setStatusOpen(true)}
          className="mt-3 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-delta-text hover:bg-white/5"
        >
          查看更新状态
        </button>
      )}

      <UpdateStatusModal
        open={statusOpen}
        title="整合包更新"
        eyebrow="CLIENT UPDATE"
        busy={busy}
        progress={
          prog
            ? {
                percent: prog.percent,
                label: prog.phase === 'applying' ? '正在替换文件…' : prog.phase === 'downloading' ? `下载中 ${prog.percent}%` : '正在准备…',
                detail: `${prog.doneFiles}/${prog.totalFiles} 个 · ${mb(prog.bytesDone)} / ${mb(prog.bytesTotal)}`,
                current: prog.current,
                remaining: `剩余 ${Math.max(0, prog.totalFiles - prog.doneFiles)} 个文件`
              }
            : null
        }
        note={note}
        warning={check?.ok && check.noDownloadBase && todo > 0 ? '服务端还没配置下载源，清单已下发但文件无法下载。请联系管理员配置整合包下载地址。' : undefined}
        summary={
          check?.ok && !check.upToDate
            ? `缺失 ${check.missing ?? 0} · 被改动 ${check.changed ?? 0} · 共 ${mb(check.bytesTotal ?? 0)}`
            : check?.upToDate
              ? `整合包 ${check.packVersion ?? '—'} 已是最新`
              : undefined
        }
        actionLabel={check?.ok && !check.upToDate ? `立即更新（${todo}）` : undefined}
        onAction={() => void doApply()}
        onClose={() => setStatusOpen(false)}
      />
    </div>
  )
}

function UpdateStatusModal({
  open,
  title,
  eyebrow,
  busy,
  progress,
  note,
  warning,
  summary,
  actionLabel,
  onAction,
  onClose
}: {
  open: boolean
  title: string
  eyebrow: string
  busy: boolean
  progress: PopupProgress | null
  note?: string
  warning?: string
  summary?: string
  actionLabel?: string
  onAction?: () => void
  onClose: () => void
}): React.JSX.Element {
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null)
  useEffect(() => { setNoticeHost(document.getElementById('update-notices')) }, [])
  if (!noticeHost) return <></>
  return createPortal(
    <AnimatePresence>
      {open && !busy && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="update-notice panel-raised pointer-events-auto w-full shrink-0 p-3.5 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0">
                <div className="eyebrow">{eyebrow}</div>
                <h2 className="mt-1 text-lg font-semibold tracking-tight">{title}</h2>
              </div>
              {!busy && (
                <button
                  type="button"
                  onClick={onClose}
                  className="ml-auto rounded-lg border border-white/15 px-2.5 py-1.5 text-[11px] text-delta-muted hover:bg-white/10 hover:text-delta-text"
                >
                  关闭
                </button>
              )}
            </div>

            {busy ? (
              <div className="mt-4">
                <div className="flex items-center gap-2 text-xs font-medium text-delta-text">
                  <motion.span
                    aria-label="处理中"
                    className="h-3.5 w-3.5 rounded-full border-2 border-delta-accent/25 border-t-delta-accent"
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 0.85, ease: 'linear' }}
                  />
                  <span>{progress?.label ?? '正在检查更新…'}</span>
                  {progress && <span className="ml-auto text-delta-accent">{Math.round(progress.percent)}%</span>}
                </div>
                {progress && (
                  <>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
                      <motion.div
                        className="h-full rounded-full bg-delta-accent"
                        animate={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                    <div className="mt-2 space-y-0.5 text-[11px] text-delta-muted">
                      {progress.current && <div className="truncate">当前：{progress.current}</div>}
                      {progress.remaining && <div>{progress.remaining}</div>}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                {summary && <div className="glass-control mt-4 text-xs text-delta-muted">{summary}</div>}
                {warning && <div className="mt-3 rounded-xl border border-delta-accent/40 bg-delta-accent/10 p-3 text-xs leading-relaxed text-delta-accent">{warning}</div>}
                {note && <div className="mt-3 rounded-xl border border-white/10 bg-white/25 p-3 text-xs leading-relaxed text-delta-text">{note}</div>}
              </>
            )}

            {!busy && actionLabel && onAction && (
              <button
                type="button"
                onClick={onAction}
                className="mt-4 w-full rounded-xl bg-delta-accent px-4 py-2.5 text-xs font-bold text-black hover:bg-delta-accent-2"
              >
                {actionLabel}
              </button>
            )}
          </motion.div>
      )}
    </AnimatePresence>, noticeHost
  )
}

/* ------------------------------------------------------------------ 新闻资讯 */

function News(): React.JSX.Element {
  const news = useAnnouncements()
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4">
        <div className="eyebrow">BREAKLINE NEWS</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">新闻资讯</h1>
        <p className="mt-1 text-xs text-delta-muted">只显示会影响你进入游戏的更新。</p>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="panel p-4">
          <div className="text-sm font-semibold">公告 · Announcements</div>
          <div className="mt-3 flex flex-col gap-3">
            {news.items.map((a) => (
              <div key={a.title} className="flex gap-2">
                <span
                  className={`mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                    a.tone === 'accent'
                      ? 'bg-delta-accent/15 text-delta-accent'
                      : 'bg-white/10 text-delta-muted'
                  }`}
                >
                  {a.tag}
                </span>
                <div>
                  <div className="text-[13px] text-delta-text/90">{a.title}</div>
                  <div className="mt-0.5 text-[10px] text-delta-muted">{a.date}</div><p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-delta-muted">{a.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel p-4">
          <div className="text-sm font-semibold">版本更新 · Patch Notes</div>
          {news.items.filter(item => item.version).map(item => ({ v: item.version!, date: item.date, items: item.body.split('\n').filter(Boolean) })).map((p) => (
            <div key={p.v} className="mt-3">
              <div className="flex items-center gap-2">
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold">{p.v}</span>
                <span className="text-[10px] text-delta-muted">{p.date}</span>
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {p.items.map((it) => (
                  <li key={it} className="flex gap-1.5 text-[12px] text-delta-muted">
                    <span className="text-delta-accent">•</span>
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 设置（无路径设置） */

/**
 * 启动器自身更新卡片（第 3 项的另一半）。
 *
 * 与"整合包更新"刻意**分开放**：玩家看到的应该是两件不同的事——
 * 一个是"我的模组装错了/缺了"（整合包），一个是"启动器本身出新版了"（程序）。
 * 合成一个按钮会出现"点了更新，结果更新的是另一件东西"。
 */
function SelfUpdateCard(): React.JSX.Element {
  const [info, setInfo] = useState<{
    currentVersion: string
    packaged: boolean
    available: boolean
    version?: string
    notes?: string
    error?: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [statusOpen, setStatusOpen] = useState(false)

  /**
   * 启动器**自身**更新的进度（免安装版自替换那条路）。
   *
   * ⚠️ 这一条是补上的（2026-09-18 运维问「更新中没有状态读条吗」）：
   * 主进程一直在发进度（`onSelfProgress`），但界面**从来没订阅过** ——
   * 于是下载 79 MB 的全程界面上只有一句"正在下载并安装"，看起来像卡死。
   * 免安装版尤其需要它：下载完启动器会**自己退出**去替换文件，
   * 那几秒界面什么都不显示，玩家很容易以为崩了又去双击图标
   * （那会让替换助手多等一轮，甚至让替换失败）。
   */
  const [selfProg, setSelfProg] = useState<{ percent: number; message: string } | null>(null)
  useEffect(() => {
    const off = window.delta.update.onSelfProgress(setSelfProg)
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])

  const check = async (): Promise<void> => {
    setBusy(true)
    setNote('')
    try {
      const result = await window.delta.update.selfCheck()
      setInfo(result)
      if (result.available) setStatusOpen(true)
    } catch (error) {
      setNote(`检查未完成：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void check()
  }, [])

  const apply = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote('')
    setStatusOpen(true)
    try {
      const result = await window.delta.update.selfApply()
      setNote(result.ok ? '安装后自动重启' : `更新未完成：${result.error}`)
    } catch (error) {
      setNote(`更新未完成：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel p-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">启动器更新</div>
          <div className="mt-1 text-[11px] text-delta-muted">
            当前版本 {info?.currentVersion ?? '—'}
            {info && !info.packaged && ' · 本地预览'}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 gap-2">
          <button
            onClick={() => void check()}
            disabled={busy || info?.packaged === false}
            className="rounded-lg border border-white/15 px-3 py-2 text-xs text-delta-text hover:bg-white/5 disabled:opacity-40"
          >
            {busy ? '检查中…' : '检查启动器更新'}
          </button>
          {info?.available && (
            <button
              onClick={() => void apply()}
              disabled={busy}
              className="rounded-lg bg-delta-accent px-3 py-2 text-xs font-bold text-black disabled:opacity-50"
            >
              更新到 {info.version}
            </button>
          )}
        </div>
      </div>
      {info?.packaged !== false && (info?.available || selfProg || note || info?.error) ? (
        <button
          type="button"
          onClick={() => setStatusOpen(true)}
          className="mt-3 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-delta-text hover:bg-white/5"
        >
          查看启动器更新状态
        </button>
      ) : info && !info.error ? (
        <div className="mt-2 text-[11px] text-delta-ok">✓ 已是最新版本</div>
      ) : null}

      <UpdateStatusModal
        open={statusOpen}
        title="启动器更新"
        eyebrow="LAUNCHER UPDATE"
        busy={busy}
        progress={
          selfProg
            ? {
                percent: selfProg.percent,
                label: selfProg.percent >= 100 ? '正在重启启动器…' : /校验|准备替换/.test(selfProg.message) ? selfProg.message : `下载中 ${selfProg.percent}%`,
                current: selfProg.message
              }
            : null
        }
        note={note}
        summary={info?.available ? `发现新版本 ${info.version}${info.notes ? ` · ${info.notes}` : ''}` : info && !info.error ? '当前已经是最新版本' : info?.error}
        actionLabel={info?.available ? `更新到 ${info.version}` : undefined}
        onAction={() => void apply()}
        onClose={() => setStatusOpen(false)}
      />
    </div>
  )
}

/**
 * 游戏运行参数（片 1 后半，2026-09-18）：内存 / 分辨率 / 全屏。
 *
 * 与别的卡片最根本的区别：**这三项真的会进游戏命令行**（启动日志里能看到最终命令行）。
 * 所以保存后必须显示**回读值**（主进程写完再读一次文件返回）——
 * "界面显示 8G、实际按 4G 跑"是这类设置最经典的坑，回读是唯一能当场发现它的办法。
 */
function RuntimeSettingsCard(): React.JSX.Element {
  const [cur, setCur] = useState<{
    java?: string
    lowMemoryMode?: boolean
      memoryMb?: number
    gcMode?: 'template' | 'tuned'
    width?: number
    height?: number
    fullscreen?: boolean
    autoMemoryMb?: number
    availableMb?: number
    modCount?: number
  } | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  /** 片 2：本机可用的 Java（只列**真的能跑**的）。 */
  const [javas, setJavas] = useState<
    Array<{ path: string; version: string; major: number; arch: string; from: string; usable: boolean }>
  >([])
  const [javaErr, setJavaErr] = useState('')
  /** 片 3：下载 Java 的进度与结果提示。 */
  const [javaMsg, setJavaMsg] = useState('')
  const [javaProg, setJavaProg] = useState<{ phase: string; percent: number; message: string } | null>(null)
  const [javaStatusOpen, setJavaStatusOpen] = useState(false)
  useEffect(() => {
    void window.delta.config.runtimeGet().then(setCur)
    void window.delta.config.javaList().then(setJavas)
  }, [])
  useEffect(() => {
    const off = window.delta.config.onJavaProgress(setJavaProg)
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])
  const save = async (patch: {
    java?: string
    lowMemoryMode?: boolean
      memoryMb?: number
    gcMode?: 'template' | 'tuned'
    width?: number
    height?: number
    fullscreen?: boolean
  }): Promise<void> => {
    setBusy(true)
    setNote('')
    try {
      setCur(await window.delta.config.runtimeSet(patch))
      setNote('已保存，下次启动生效')
      setJavaErr('')
    } catch (e) {
      // ⚠️ 这里**必须显示错误**：主进程对 java 路径做了校验，选到不能跑的会抛。
      // 静默失败会让玩家以为"选好了"，然后启动时才发现起不来（片 2 的验收条件）。
      setJavaErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const MEM = [2048, 3072, 4096, 6144, 8192, 12288, 16384]
  const RES: Array<[number, number]> = [
    [1280, 720],
    [1600, 900],
    [1920, 1080],
    [2560, 1440]
  ]
  const sel = 'mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-delta-text'
  return (
    <details className="panel mt-3 max-w-4xl p-3.5" open>
      <summary className="flex cursor-pointer items-center gap-3">
        <div className="text-sm font-semibold">游戏运行参数</div>
        <span className="ml-auto text-[11px] text-delta-muted">下次启动生效</span>
      </summary>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <details className="glass-control rounded-xl p-3" open>
          <summary className="flex cursor-pointer text-xs font-medium">内存分配<span className="ml-auto text-[11px] font-normal text-delta-muted">{cur?.memoryMb ? `${cur.memoryMb / 1024} GB` : `自动 · ${cur?.autoMemoryMb ? `${(cur.autoMemoryMb / 1024).toFixed(1)} GB` : '计算中'}`}</span></summary>
          <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" checked={cur?.lowMemoryMode === true} disabled={busy} onChange={(e) => void save({ lowMemoryMode: e.target.checked })} />低配模式启动</label>
          <p className="mt-1 text-[11px] text-delta-muted">启动前启用8×8材质、2D枪械与大红、较低画质，游戏内存上限3GB。关闭后下次启动恢复原设置。</p>
          <label className="mt-2 block text-[11px] text-delta-muted">使用内存
          <select
            className={sel}
            disabled={busy}
            value={cur?.memoryMb ? String(cur.memoryMb) : ''}
            onChange={(e) => void save({ memoryMb: Number(e.target.value || 0) })}
          >
            <option value="">自动（可用内存 + 模组数公式）{cur?.autoMemoryMb ? `：约 ${(cur.autoMemoryMb / 1024).toFixed(1)} GB` : ''}</option>
            {MEM.map((m) => (
              <option key={m} value={m}>
                {m / 1024} GB
              </option>
            ))}
          </select>
          </label>
        </details>
        <details className="glass-control rounded-xl p-3" open>
          <summary className="flex cursor-pointer text-xs font-medium">垃圾回收<span className="ml-auto text-[11px] font-normal text-delta-muted">{cur?.gcMode === 'template' ? '模板参数' : '调优 G1GC'}</span></summary>
          <label className="mt-2 block text-[11px] text-delta-muted">Java 垃圾回收参数
            <select className={sel} disabled={busy} value={cur?.gcMode ?? 'tuned'} onChange={(e) => void save({ gcMode: e.target.value as 'template' | 'tuned' })}>
              <option value="tuned">调优 G1GC（按 Java 版本选择安全参数）</option>
              <option value="template">使用整合包模板参数</option>
            </select>
          </label>
        </details>
        <details className="glass-control rounded-xl p-3" open>
          <summary className="flex cursor-pointer text-xs font-medium">显示设置<span className="ml-auto text-[11px] font-normal text-delta-muted">{cur?.fullscreen ? '全屏' : '窗口'}</span></summary>
          <label className="mt-2 block text-[11px] text-delta-muted">分辨率
          <select
            className={sel}
            disabled={busy}
            value={cur?.width && cur?.height ? `${cur.width}x${cur.height}` : ''}
            onChange={(e) => {
              const [w, h] = e.target.value.split('x').map((n) => Number(n))
              void save({ width: w || 0, height: h || 0 })
            }}
          >
            <option value="">模板默认</option>
            {RES.map(([w, h]) => (
              <option key={w} value={`${w}x${h}`}>
                {w}×{h}
              </option>
            ))}
          </select>
          </label>
          <label className="mt-3 flex items-center gap-2 text-xs text-delta-text"><input type="checkbox" disabled={busy} checked={!!cur?.fullscreen} onChange={e => void save({ fullscreen: e.target.checked })} />全屏启动</label>
        </details>
        <details className="glass-control rounded-xl p-3 sm:col-span-2">
          <summary className="flex cursor-pointer text-xs font-medium">Java 运行环境<span className="ml-auto text-[11px] font-normal text-delta-muted">{cur?.java ? '已指定' : '自动选择'}</span></summary>
          <label className="mt-2 block text-[11px] text-delta-muted">Java
          <select
            className={sel}
            disabled={busy}
            value={cur?.java ?? ''}
            onChange={(e) => {
              const p = e.target.value
              // 选"自动"走空串（主进程会删掉这个键，回到自动探测）。
              void save({ java: p })
            }}
          >
            <option value="">自动选择</option>
            {cur?.java && !javas.some(j => j.path === cur.java) && <option value={cur.java}>已保存：{cur.java}</option>}
            {javas.map((j) => (
              <option key={j.path} value={j.path}>
                {j.version} · {j.arch}位 · {j.from}
                {j.usable ? '' : '（版本过老，起不了 1.20.1）'}
              </option>
            ))}
          </select>
          </label>
        </details>
      </div>
      {(note || javaErr) && <div className={`mt-2 text-[11px] ${javaErr ? 'text-delta-accent' : 'text-delta-ok'}`}>{javaErr || note}</div>}
      <details className="mt-3 rounded-xl border border-white/10 bg-white/5 px-2.5 py-2">
        <summary className="cursor-pointer text-[11px] text-delta-muted">安装 Java 运行环境</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={async () => {
              setBusy(true)
              setJavaStatusOpen(true)
              setJavaMsg('正在准备…')
              try {
                const r = await window.delta.config.javaProvision()
                setJavas(await window.delta.config.javaList())
                setJavaMsg(r.ok ? `已安装：${r.javaPath ?? ''}` : `失败：${r.error ?? '未知原因'}`)
              } finally {
                setBusy(false)
              }
            }}
            disabled={busy}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-delta-text hover:bg-white/5 disabled:opacity-40"
          >
            自动下载并安装
          </button>
          {(javaMsg || javaProg) && (
            <button
              type="button"
              onClick={() => setJavaStatusOpen(true)}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-delta-text hover:bg-white/5"
            >
              查看安装状态
            </button>
          )}
        </div>
      </details>
      <UpdateStatusModal
        open={javaStatusOpen}
        title="Java 运行环境"
        eyebrow="JAVA DOWNLOAD"
        busy={busy}
        progress={
          javaProg
            ? { percent: javaProg.percent, label: javaProg.phase === 'done' ? 'Java 安装完成' : '正在下载 Java…', current: javaProg.message }
            : null
        }
        note={javaMsg}
        onClose={() => setJavaStatusOpen(false)}
      />
      <div className="glass-control mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2 text-[11px] text-delta-muted">
        <span>当前：{cur?.memoryMb ? `${cur.memoryMb} MB（手动）` : `自动 ${cur?.autoMemoryMb ?? '—'} MB（${cur?.modCount ?? '—'} 个模组，可用 ${cur?.availableMb ? (cur.availableMb / 1024).toFixed(1) : '—'} GB）`}</span>
        <span>{cur?.width && cur?.height ? `${cur.width}×${cur.height}` : '默认分辨率'}</span>
        <span>{cur?.fullscreen ? '全屏' : '窗口'}</span>
        <button
          onClick={() => void save({ memoryMb: 0, width: 0, height: 0 })}
          disabled={busy}
          className="ml-auto rounded-md border border-white/10 px-2 py-1 text-[10px] text-delta-muted hover:bg-white/5 disabled:opacity-40"
        >
          恢复默认
        </button>
      </div>
    </details>
  )
}
/* ------------------------------------------------------- 游戏目录：状态与选择 */

/**
 * 三种"找不到"的文案必须不同（运维 2026-09-18 明确要求）。
 *
 * | 状态 | 玩家该做什么 |
 * | --- | --- |
 * | `missing` | 什么都不用做：启动器会创建这个目录 |
 * | `empty` | 去「模组管理」下载整合包（目录是好的，只是还没内容） |
 * | `unreadable` | 要动手查：权限/磁盘/杀软拦截（**不是**"没装" ） |
 *
 * 注意：主进程 `GamePaths.describeGameDir()` 会给出**更具体**的整句（含路径），
 * 有 notices 时优先用它；这里的表只做兜底，保证任何情况下都不会只剩一句"读不到"。
 */
const DIR_STATE_TEXT: Record<DirState, string> = {
  ok: '正常（已有模组）',
  empty: '目录已就绪，但里面没有 mods',
  missing: '目录不存在（启动器会创建）',
  unreadable: '读不到（权限或磁盘问题）'
}

/** 目录状态提示块：优先显示主进程给的原句（与判定同源），再补"回落自哪里"。 */
function DirNotices({
  notices,
  rejected,
  compact
}: {
  notices?: { code: string; text: string; detail?: string }[]
  rejected?: { raw: string; expanded: string; source: string }[]
  compact?: boolean
}): React.JSX.Element | null {
  const rows = notices ?? []
  if (rows.length === 0 && (rejected ?? []).length === 0) return null
  const tone = (code: string): string =>
    code === 'ok'
      ? 'text-delta-ok'
      : code === 'mods_missing' || code === 'first_run_created' || code === 'candidate_adopted'
        ? 'text-delta-text/85'
        : 'text-delta-accent'
  return (
    <div className={`mt-3 rounded-xl border border-white/10 bg-white/5 p-3 text-[11px] leading-relaxed ${compact ? '' : ''}`}>
      {rows.map((n, i) => (
        <div key={`${n.code}-${i}`} className="flex gap-1.5">
          <span className="shrink-0 text-delta-muted">·</span>
          <span className={`min-w-0 break-all ${tone(n.code)}`}>
            {n.text}
            {n.detail ? <span className="text-delta-muted">（{n.detail}）</span> : null}
          </span>
        </div>
      ))}
      {(rejected ?? []).map((r, i) => (
        <div key={`rej-${i}`} className="mt-1 flex gap-1.5 text-delta-accent">
          <span className="shrink-0">·</span>
          <span className="min-w-0 break-all">
            {r.source}里写的 {r.expanded} 在本机不存在（原始值 {r.raw}）——已按上面的优先级回落到生效目录
          </span>
        </div>
      ))}
    </div>
  )
}

/** 「浏览…」的结果回执：**把最终采用的那个绝对路径显示出来**，别让玩家猜。 */
function PickResultBox({ r }: { r: PickedGameDir }): React.JSX.Element {
  if (r.canceled) {
    return <div className="mt-3 text-[11px] text-delta-muted">已取消选择，目录未改变。</div>
  }
  if (!r.ok) {
    return (
      <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-[11px] leading-relaxed">
        <div className="font-semibold text-red-300">这个目录不能用，已保持不变</div>
        {(r.notes ?? []).map((n) => (
          <div key={n} className="mt-0.5 break-all text-delta-text/85">
            {n}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="mt-3 rounded-xl border border-delta-ok/40 bg-delta-ok/10 p-3 text-[11px] leading-relaxed">
      <div className="font-semibold text-delta-ok">已采用这个目录（立即生效）</div>
      <div className="mt-1 break-all font-mono text-delta-text/90">游戏根目录：{r.effective?.gameRoot ?? r.gameRoot}</div>
      <div className="break-all font-mono text-delta-text/90">实例目录：{(r.effective?.gameRoot ?? r.gameRoot) + '\\versions\\' + (r.effective?.version ?? r.version)}</div>
      <div className="break-all font-mono text-delta-text/90">mods 目录：{r.modsDir}</div>
      <div className="mt-1 text-delta-muted">
        识别形态：{r.form === 'instance' ? '实例目录（versions\\实例名）' : '游戏根目录（.minecraft）'}
        {r.versionChanged ? ` ｜ 实例名已改为 ${r.effective?.version ?? r.version}` : ''}
        {` ｜ mods 状态：${DIR_STATE_TEXT[(r.modsState ?? 'missing') as DirState]}`}
      </div>
      {(r.notes ?? []).map((n) => (
        <div key={n} className="mt-0.5 break-all text-delta-text/85">
          {n}
        </div>
      ))}
      <div className="mt-1 break-all text-delta-muted">已写入：{r.settingsFile}</div>
    </div>
  )
}

/** 「一键修复」的结果面板：**逐项**显示做了什么、成没成、还差什么。 */
function RepairResultBox({ r, running }: { r: RepairResult | null; running: boolean }): React.JSX.Element | null {
  const [progress, setProgress] = useState('正在确认游戏目录…')
  const [started, setStarted] = useState(0)
  const [lastProgress, setLastProgress] = useState(0)
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!running) return
    const start = Date.now()
    setStarted(start); setLastProgress(start); setNow(start)
    setProgress('正在确认游戏目录…')
    const show = (message: string): void => {
      setProgress(message); setLastProgress(Date.now())
    }
    const offLog = window.delta.launch.onLog(({ line }) => {
      if (/^\[launcher\] (一键修复|客户端资源|红色物品 3D|官方资源)：/.test(line)) {
        show(line.replace(/^\[launcher\] /, ''))
      }
    })
    const offUpdate = window.delta.update.onProgress(p => {
      const bytes = p.bytesTotal > 0 ? ` · ${Math.floor(p.bytesDone / 1048576)}/${Math.ceil(p.bytesTotal / 1048576)} MB` : ''
      show(`模组：${p.message ?? (p.phase === 'downloading' ? '正在下载' : '正在校验')}${bytes}`)
    })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { offLog(); offUpdate(); window.clearInterval(timer) }
  }, [running])
  if (!r && !running) return null
  if (running) {
    return (
      <div className="mt-2 rounded-xl border border-white/10 bg-white/5 p-2.5 text-[11px] text-delta-muted">
        <div className="font-semibold text-delta-text">正在修复，请保持启动器打开</div>
        <div className="mt-1 break-all text-delta-text" role="status">{progress}</div>
        <div className="mt-1 flex items-center gap-2">
          <span>已用时 {Math.max(0, Math.floor((now - started) / 1000))} 秒</span>
          {now - lastProgress >= 45000 && <span className="text-delta-accent">等待网络或磁盘响应</span>}
        </div>
      </div>
    )
  }
  return (
    <div
      className={`mt-3 rounded-xl border p-3 text-[11px] leading-relaxed ${
        r?.ok ? 'border-delta-ok/40 bg-delta-ok/10' : 'border-delta-accent/40 bg-delta-accent/10'
      }`}
    >
      <div className={`font-semibold ${r?.ok ? 'text-delta-ok' : 'text-delta-accent'}`}>
        {r?.ok ? '一键修复完成：全部检查通过' : `一键修复结束：仍有 ${r?.remaining.length ?? 0} 项未完成`}
      </div>
      <div className="mt-1 text-delta-muted">检查通过 {r?.steps.filter(s => s.ok).length ?? 0}/{r?.steps.length ?? 0} 项 · 本次完成修复或安装 {r?.steps.filter(s => s.ok && s.changed).length ?? 0} 项</div>
      <details className="mt-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
        <summary className="cursor-pointer text-[11px] text-delta-muted">查看修复步骤</summary>
        <div className="mt-1.5 flex flex-col gap-1">
          {(r?.steps ?? []).map((s) => (
            <div key={s.key} className="flex gap-1.5">
              <span className={s.ok ? 'shrink-0 text-delta-ok' : 'shrink-0 text-delta-accent'}>{s.ok ? '✓' : '✗'}</span>
              <span className="min-w-0 break-all text-delta-text/85">
                <span className="font-semibold">{s.title} · {s.ok ? s.changed ? '已修复' : '已通过' : '未完成'}</span>
                <span className="block text-delta-muted">{s.message}</span>
                {s.detail ? <span className="block text-delta-muted">{s.detail}</span> : null}
              </span>
            </div>
          ))}
        </div>
      </details>
      {!!r?.remaining.length && <div className="mt-3 border-t border-white/10 pt-2">
        <div className="font-semibold text-delta-accent">尚未完成</div>
        <ul className="mt-1 list-disc pl-4">{r.remaining.map((item, index) => <li key={index} className="break-all">{item}</li>)}</ul>
        <div className="mt-2 text-delta-muted">网络超时：恢复网络后再次修复。文件无法写入：先关闭游戏，确认目录可写后重试。缺少账号登录或仍未完成时，请按上方项目提示处理。已完成的文件会保留并重新校验。</div>
      </div>}
      {r?.effective && (
        <div className="mt-1.5 break-all font-mono text-delta-muted">
          生效目录：{r.effective.gameRoot}（{r.effective.sourceLabel}）
        </div>
      )}
    </div>
  )
}

function Settings({ user }: { user: string | null }): React.JSX.Element {
  const [cfg, setCfg] = useState<{
    gameRoot: string
    java: string
    version: string
    settingsFile: string
    factory: { gameRoot: string; version: string }
    resolved?: {
      source: string
      sourceLabel: string
      note: string
      modsDir: string
      modsState: DirState
      modsJars: number
      rejected: { raw: string; expanded: string; source: string }[]
      notices: { code: string; text: string; detail?: string }[]
    } | null
  } | null>(null)
  const [terms, setTerms] = useState<ConsentState | null>(null)
  const [r, setR] = useState<PackResult | null>(null)
  const [picked, setPicked] = useState<PickedGameDir | null>(null)
  const [repair, setRepair] = useState<RepairResult | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [busy, setBusy] = useState(false)

  const reload = async (): Promise<void> => {
    // 顺序：先读配置（新路径）→ 再跑校验（校验读的就是生效路径）
    setCfg(await window.delta.config.get())
    setR(await window.delta.pack.verify())
  }

  useEffect(() => {
    void reload()
    void window.delta.consent.get().then(setTerms)
  }, [])

  /** 「浏览…」：路径只能由主进程的原生目录选择器产生（renderer 传不了路径串）。 */
  const pickDir = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.delta.config.pick()
      setPicked(res)
      if (!res.canceled) await reload()
    } finally {
      setBusy(false)
    }
  }

  const resetDir = async (): Promise<void> => {
    setBusy(true)
    try {
      setPicked(null)
      await window.delta.config.resetPath()
      await reload()
    } finally {
      setBusy(false)
    }
  }

  /**
   * 「一键修复」：一次点击跑完"发现目录 → 建结构 → 差量补齐整合包 → 复检"。
   * 它是给"我不想搞清楚哪里坏了，先让它自愈"的玩家准备的；修不了的部分
   * （assets/libraries、Java 选择）会逐条列出来，而不是假装成功。
   */
  const repairDir = async (): Promise<void> => {
    setBusy(true)
    setRepairing(true)
    setRepair(null)
    try {
      const res = await window.delta.config.repair()
      setRepair(res)
      await reload()
    } finally {
      setRepairing(false)
      setBusy(false)
    }
  }

  const row = (k: string, v: string): React.JSX.Element => (
    <div className="flex items-start gap-3 border-b border-white/5 py-2 last:border-0">
      <span className="w-28 shrink-0 text-[11px] text-delta-muted">{k}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-delta-text/90">{v}</span>
    </div>
  )

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4">
        <div className="eyebrow">LAUNCHER SETTINGS</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">设置</h1>
        <p className="mt-1 text-xs text-delta-muted">管理客户端目录、Java、账号和诊断信息。</p>
      </div>
      <div className="grid max-w-4xl grid-cols-1 items-start gap-3 xl:grid-cols-2">
        <details className="panel p-3.5">
          <summary className="flex cursor-pointer list-none items-center gap-3">
            <span className="text-sm font-semibold">客户端目录</span>
            <span className={`ml-auto text-[11px] ${cfg?.resolved?.modsState === 'ok' ? 'text-delta-ok' : 'text-delta-muted'}`}>{cfg?.resolved ? DIR_STATE_TEXT[cfg.resolved.modsState] : '读取中…'}</span>
          </summary>
          <div className="mt-3">
            {row('实例', cfg?.version ?? '—')}
            {row('游戏目录', cfg?.gameRoot ?? '—')}
            {row('模组', cfg?.resolved ? `${cfg.resolved.modsJars} 个` : '—')}
            {row('Java', cfg?.java ?? '—')}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => void repairDir()}
              disabled={busy}
              className="rounded-lg bg-gradient-to-r from-delta-accent to-delta-accent-2 px-3 py-1.5 text-[11px] font-bold text-black disabled:opacity-50"
            >
              {repairing ? '修复中…' : '一键修复'}
            </button>
            <button
              onClick={() => void pickDir()}
              disabled={busy}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-delta-text hover:bg-white/5 disabled:opacity-50"
            >
              {busy && !repairing ? '处理中…' : '选择目录'}
            </button>
            <button
              onClick={() => void resetDir()}
              disabled={busy}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-delta-muted hover:bg-white/5 disabled:opacity-50"
            >
              恢复默认
            </button>
          </div>
          {(cfg?.resolved?.notices?.length || cfg?.resolved?.rejected?.length || repair || repairing || picked) ? (
            <details className="mt-3 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2" open={repairing}>
              <summary className="cursor-pointer text-[11px] text-delta-muted">查看目录诊断</summary>
              <div className="mt-2">
                <DirNotices notices={cfg?.resolved?.notices} rejected={cfg?.resolved?.rejected} compact />
                <RepairResultBox r={repair} running={repairing} />
                {picked && <PickResultBox r={picked} />}
              </div>
            </details>
          ) : null}
        </details>

        <details className="panel p-3.5">
          <summary className="flex cursor-pointer list-none items-center gap-3">
            <span className="text-sm font-semibold">账号与条款</span>
            <span className="ml-auto text-[11px] text-delta-muted">{user ?? '未登录'}</span>
          </summary>
          <div className="mt-3">
            {row('登录账号', user ?? '未登录')}
            {row('条款', terms ? `${terms.termsVersion}${terms.accepted ? ' · 已同意' : ' · 未同意'}` : '—')}
            {row('游戏窗口取证', terms?.accepted ? '已授权 · 服务器必需条款' : '未同意，不能启动游戏')}
            <p className="mt-3 text-xs text-delta-muted">举报与例行抽检仅采集本启动器启动的游戏窗口，每小时最多 6 张，保存 30 天。</p>
          </div>
        </details>

        <details className="panel p-3.5">
          <summary className="flex cursor-pointer list-none items-center gap-3">
            <span className="text-sm font-semibold">高级诊断</span>
            <span className="ml-auto text-[11px] text-delta-muted">仅排障时查看</span>
          </summary>
          <div className="mt-3">
            {row('设置文件', cfg?.settingsFile ?? '—')}
            {row('出厂目录', cfg?.factory.gameRoot ?? '—')}
            {row('客户端模组', r ? `${r.actual} / ${r.expected}` : '—')}
          </div>
          <button
            onClick={() => void reload()}
            disabled={busy}
            className="mt-3 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-delta-muted hover:bg-white/5 disabled:opacity-50"
          >
            重新检查
          </button>
        </details>

      </div>

      <RuntimeSettingsCard />
    </div>
  )
}

/* ------------------------------------------------------------------ 条款页 */

function ConsentGate({ onDone }: { onDone: (accepted: boolean) => void }): React.JSX.Element {
  const items = [
    '进程列表（本机正在运行的进程名）',
    '驱动清单（已安装的内核驱动名）',
    '模块清单（游戏进程加载的模块）',
    'JVM 启动参数（是否挂了 java agent 等）',
    '模组清单（mods 目录内文件名与哈希）',
    '游戏窗口截图（举报复核与例行抽检）',
    '设备标识哈希（用于永久封禁后的设备限制）'
  ]
  return (
    <div className="flex h-full items-center justify-center p-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="panel-raised dialog-surface w-full max-w-2xl p-8">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-xl font-bold">MUGEN AC · 客户端条款</div>
            <div className="eyebrow mt-1">Terms of MUGEN AC</div>
          </div>
        </div>
        <p className="mt-4 text-sm text-delta-muted">
          进入本服务器需要安装 MUGEN AC 模组。以下是可能采集的信息，逐条列出：
        </p>
        <ul className="mt-4 grid grid-cols-1 gap-1.5 text-sm md:grid-cols-2">
          {items.map((t) => (
            <li key={t} className="flex gap-2 text-delta-text/90">
              <span className="text-delta-accent">·</span>
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-5 text-xs text-delta-muted">
          反作弊授权是进入服务器的必需条件；不同意则不会启动游戏。条款版本 2026-10-07.3；采集范围变更后重新确认。
        </p>
        <p className="mt-4 text-xs text-delta-muted">同意以下条款即授权游戏窗口取证：只截本启动器启动的游戏，不截桌面或其他窗口；每小时最多 6 张，上传服务器数据库，最多保留 30 天。</p>
        <p className="mt-3 text-xs text-delta-muted">启动前读取系统与主板标识，仅上传独立哈希，用于永久封禁后的设备限制；同一设备换账号仍被限制。虚拟机来宾环境不允许启动，管理员解封后同步解除对应限制。</p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => onDone(true)}
            className="rounded-lg bg-gradient-to-r from-delta-accent to-delta-accent-2 px-6 py-2.5 text-sm font-bold text-black"
          >
            同意并继续
          </button>
          <button
            onClick={() => onDone(false)}
            className="rounded-lg border border-white/10 px-6 py-2.5 text-sm text-delta-muted hover:bg-white/5"
          >
            不同意（退出）
          </button>
        </div>
      </motion.div>
    </div>
  )
}


/* ------------------------------------------------------------------ 应用外壳 */

export default function App(): React.JSX.Element {
  const [consent, setConsent] = useState<ConsentState | null>(null)
  const [showGameImport, setShowGameImport] = useState(false)
  const [page, setPage] = useState<PageKey>('home')
  const [launchState, setLaunchState] = useState<LaunchState>({ state: 'idle' })
  const [launchPending, setLaunchPending] = useState(false)
  const [launchFailure, setLaunchFailure] = useState<string | null>(null)
  const launchPendingRef = useRef(false)
  const [log, setLog] = useState<string[]>([])
  const [player, setPlayer] = useState<PlayerSession>({ state: 'none' })
  /** 登录方式（身份来源）。放在 App 层是因为标题栏显示它、账号浮层改它。 */
  const [site, setSite] = useState<LoginSite>('littleskin')
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [target, setTarget] = useState('')
  const [memoryCleanupEnabled, setMemoryCleanupEnabled] = useState(false)
  const [memoryCleanupNoticeSeen, setMemoryCleanupNoticeSeen] = useState(false)
  const [showMemoryCleanupNotice, setShowMemoryCleanupNotice] = useState(false)

  const refreshPlayer = async (): Promise<void> => {
    // 顺序不能反：status() 会把结论写进主进程的 sessionCheck，preflight 读它。
    const updated = await window.delta.player.status()
    setPlayer(updated)
    if (updated.state === 'ok' && (updated.site === 'premium' || updated.site === 'littleskin')) setSite(updated.site)
    setPreflight(await window.delta.launch.preflight())
  }

  useEffect(() => {
    void window.delta.consent.get().then(setConsent)
    void window.delta.config.target().then(setTarget)
    void window.delta.config.runtimeGet().then(settings => {
      setMemoryCleanupEnabled(settings.memoryCleanupEnabled === true)
      setMemoryCleanupNoticeSeen(settings.memoryCleanupNoticeSeen === true)
    })
    void window.delta.launch.state().then(setLaunchState)
    void refreshPlayer()
    const offState = window.delta.launch.onState((state) => {
      setLaunchState(state)
      if (state.state === 'exited' && state.code !== 0) {
        setLaunchFailure(`游戏进程已退出（代码 ${state.code ?? '未返回'}）。请查看首页底部的启动日志。`)
      }
    })
    const offLog = window.delta.launch.onLog((l) => setLog((prev) => [...prev.slice(-200), l.line]))
    return () => {
      offState()
      offLog()
    }
  }, [])

  const saveMemoryCleanupSettings = async (patch: { memoryCleanupEnabled?: boolean; memoryCleanupNoticeSeen?: boolean
          gameImportNoticeSeen?: boolean }): Promise<void> => {
    try {
      const saved = await window.delta.config.runtimeSet(patch)
      setMemoryCleanupEnabled(saved.memoryCleanupEnabled === true)
      setMemoryCleanupNoticeSeen(saved.memoryCleanupNoticeSeen === true)
    } catch (error) {
      setLog(prev => [...prev, `[launcher] 内存回收设置保存失败：${error instanceof Error ? error.message : String(error)}`])
    }
  }

  const toggleMemoryCleanup = (enabled: boolean): void => {
    if (!enabled) {
      setMemoryCleanupEnabled(false)
      void saveMemoryCleanupSettings({ memoryCleanupEnabled: false })
      return
    }
    if (!memoryCleanupNoticeSeen) {
      setShowMemoryCleanupNotice(true)
      return
    }
    setMemoryCleanupEnabled(true)
    void saveMemoryCleanupSettings({ memoryCleanupEnabled: true })
  }

  const launch = async (): Promise<void> => {
    if (launchPendingRef.current) return
    if (player.state !== 'ok') { window.dispatchEvent(new Event('breakline-open-login')); return }
    launchPendingRef.current = true
    setLaunchPending(true)
    setLog((prev) => [...prev, '[launcher] 正在启动…'])
    // 先显示独立的反作弊启动浮层，再等待校验/令牌/游戏进程。
    // 之前由主进程仅在 r.ok 后打开，任何一条准入失败都会让玩家误以为启动器没有反应。
    void window.delta.anim.show().catch(() => undefined)
    try {
      const r = await window.delta.launch.start()
      if (!r.ok) {
        setLaunchFailure(r.error ?? '启动失败，请查看启动日志')
        setLog((prev) => [...prev, `[launcher] 启动失败：${r.error ?? '未知原因'}`])
        await refreshPlayer()
      }
      setPreflight(await window.delta.launch.preflight())
    } catch (e) {
      setLaunchFailure(e instanceof Error ? e.message : String(e))
      setLog((prev) => [...prev, `[launcher] 启动异常：${e instanceof Error ? e.message : String(e)}`])
    } finally {
      launchPendingRef.current = false
      setLaunchPending(false)
    }
    /**
     * 「反作弊启动中」浮层**不在这里开**：它是屏幕右下角的一块独立窗口，
     * 由主进程在启动成功那一刻自己创建（见 `doLaunch` 里的注释）。
     * 放这里的话，从**托盘菜单**启动就不会有浮层 —— 那种"两条入口不一致"的缺陷
     * 事后几乎不可能被发现（没人会两条路都试一遍）。
     */
  }

  // 启动阶段文案：**从真实日志推进**，不是定时器演的动画。
  // 预检/校验通过 → 注入客户端组件；ModLauncher 起来或开始连接 → 连接服务器。
  const phase = (() => {
    if (launchState.state === 'running') return '游戏运行中'
    if (launchPending && launchState.state !== 'starting') return '正在检查启动条件…'
    if (launchState.state !== 'starting') return '启动游戏'
    const t = log.join('\n')
    if (/Connecting to|ModLauncher running|Setting user/.test(t)) return '正在连接服务器…'
    if (/整合包校验通过|预检通过/.test(t)) return '正在注入客户端组件…'
    return '正在启动…'
  })()

  if (!consent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-delta-muted">加载中…</div>
    )
  }
  if (!consent.accepted) {
    return (
      <ConsentGate
        onDone={async (ok) => {
          const firstInstall = !consent.acceptedAt
          const s = await window.delta.consent.accept(ok)
          if (ok && firstInstall) setShowGameImport(true)
          setConsent(s)
          if (!ok) window.delta.window.close()
        }}
      />
    )
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <TitleBar
          player={player}
          site={site}
          setSite={setSite}
          onPlayerChanged={() => void refreshPlayer()}
          onFeedback={(line) => setLog((prev) => [...prev.slice(-200), line])}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar page={page} setPage={setPage} />
          <main className="min-w-0 flex-1">
            <AnimatePresence mode="wait">
              <motion.div
                key={page}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="h-full"
              >
                {page === 'home' ? (
                  <Home
                    launchState={launchPending && launchState.state === 'idle' ? { state: 'starting' } : launchState}
                    phase={phase}
                    onLaunch={launch}
                    log={log}
                    onMore={() => setPage('news')}
                    target={target}
                    preflight={preflight}
                    playerOk={player.state === 'ok'}
                    memoryCleanupEnabled={memoryCleanupEnabled}
                    onMemoryCleanupToggle={toggleMemoryCleanup}
                    onDirChanged={async () => {
                      // 选完目录**立刻**重跑预检（同一段判定，所以显示与实际启动一致）
                      setPreflight(await window.delta.launch.preflight())
                    }}
                  />
                ) : page === 'news' ? (
                  <News />
                ) : (
                  <Settings user={player.state === 'ok' ? player.name ?? null : null} />
                )}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
      {showGameImport && <GameImportNotice onDismiss={() => { setShowGameImport(false); void window.delta.config.runtimeSet({ gameImportNoticeSeen: true }) }} onImported={async () => { setPreflight(await window.delta.launch.preflight()); setTarget(await window.delta.config.target()) }} onInstall={() => { void window.delta.config.repair().then(async result => { setPreflight(await window.delta.launch.preflight()); if (!result.ok) setLaunchFailure(result.remaining[0] ?? '准备尚未完成，点击主按钮将继续已有进度') }).catch(error => setLaunchFailure(String(error))) }} />}
      <div id="update-notices" aria-label="更新提醒" className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-h-[60vh] w-[248px] flex-col gap-2 overflow-y-auto" />
      <DownloadDock />
      {showMemoryCleanupNotice && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6" role="dialog" aria-modal="true" aria-label="启动前回收内存说明">
          <div className="w-full max-w-md rounded-2xl border border-white/60 bg-slate-50 p-6 text-slate-900 shadow-xl">
            <h2 className="text-base font-semibold">启动前回收内存</h2>
            <p className="mt-3 text-sm leading-6">此功能会在游戏启动前请求管理员权限，尝试修剪系统进程工作集并刷新已修改内存页，以增加可用内存。清理会让部分内容之后从磁盘重新读取。</p>
            <p className="mt-3 text-sm font-semibold text-amber-800">HDD（机械硬盘）开启会产生负优化；开启后启动速度会变慢。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-lg border border-slate-300 px-4 py-2 text-sm" onClick={() => {
                setShowMemoryCleanupNotice(false)
                setMemoryCleanupNoticeSeen(true)
                void saveMemoryCleanupSettings({ memoryCleanupNoticeSeen: true })
              }}>取消</button>
              <button className="rounded-lg bg-delta-accent px-4 py-2 text-sm font-semibold" onClick={() => {
                setShowMemoryCleanupNotice(false)
                setMemoryCleanupEnabled(true)
                setMemoryCleanupNoticeSeen(true)
                void saveMemoryCleanupSettings({ memoryCleanupEnabled: true, memoryCleanupNoticeSeen: true })
              }}>我知道了，开启</button>
            </div>
          </div>
        </div>
      )}
      {launchFailure && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-6" role="dialog" aria-modal="true" aria-label="启动失败">
          <div className="w-full max-w-md rounded-2xl border border-white/60 bg-slate-50 p-6 text-slate-900 shadow-xl">
            <h2 className="text-base font-semibold">游戏未能启动</h2>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm">{launchFailure}</p>
            <button className="mt-5 w-full rounded-lg bg-delta-accent py-2 text-sm font-semibold" onClick={() => { setLaunchFailure(null); setPage('home') }}>返回首页继续处理</button>
          </div>
        </div>
      )}
    </>
  )
}
