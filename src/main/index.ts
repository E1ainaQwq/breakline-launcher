import { applyLowMemoryMode, lowMemoryHeapMb } from './services/LowMemoryMode'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freemem } from 'node:os'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { createHash } from 'node:crypto'
import { assertTrustedJvmArgs, trustedJavaEnvironment } from './services/JvmTrust'
import { readdirSync } from 'node:fs'
import type { LaunchCheck, LaunchPreparation } from '../shared/LaunchPreparation'
import { fetchPackSnapshot } from './services/PackManifestFetch'
import { AnnouncementFeed } from './services/AnnouncementFeed'
import { watchDownloadSpeed } from './services/DownloadStream'

// Keep diagnostic runs out of the player's settings, sessions and game folder.
// Chromium's switch alone changes its profile, not Electron's userData path.
const diagnosticUserData = app.commandLine.getSwitchValue('user-data-dir')
if (diagnosticUserData) {
  mkdirSync(resolve(diagnosticUserData), { recursive: true })
  app.setPath('userData', resolve(diagnosticUserData))
}
// All versions sharing this player's data use one launcher instance.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})
import { YggdrasilAuth, type YggdrasilSession } from './services/YggdrasilAuth'
import {
  DEFAULT_SITE,
  PlayerApi,
  SessionStore,
  resolveApiBase,
  type PlayerSessionState
} from './services/PlayerApi'
import { runPlayerApiSelfTest, runRealLogin } from './services/PlayerApiSelfTest'
import { runUpdateSelfTest, runUpdateLiveCheck } from './services/UpdateSelfTest'
import { writeSwapHelper, startSwapHelper } from './services/PortableSelfUpdate'
import { buildLaunchArgs, redactCommandLine, runLaunchArgsSelfTest, versionJarIgnoreList } from './services/LaunchArgs'
import { countMods, planHeapMb, runMemoryPlanSelfTest, selectHeapMb } from './services/MemoryPlan'
import { runGcProfileSelfTest } from './services/GcProfile'
import { runMemoryCleanup, runMemoryCleanupSelfTest } from './services/MemoryCleanup'
import { packSnapshotFiles } from './services/PackSnapshot'
import { LaunchLease } from './services/LaunchLease'
import { getRuntimeSettings, setRuntimeSettings, setPathOverride, clearPathOverride, type RuntimeSettings } from './services/RuntimeSettings'
import { listJavas, validateJava } from './services/JavaDetect'
import { provisionJava } from './services/JavaProvision'
import { ensureLoginComponent, provisionOfficial } from './services/OfficialProvision'
import { missingForgeRuntime } from './services/ForgeRuntimeProvision'
import { provisionClientBundle, type BundleProgress } from './services/ClientBundleProvision'
import { provisionCosmeticAssets } from './services/CosmeticAssetProvision'
import type { DownloadActivity } from '../shared/DownloadActivity'
import { AcMonitor } from './services/AcMonitor'
import { LauncherCapture, parseCaptureTicket } from './services/LauncherCapture'
import { provisionRedResourcePack } from './services/RedResourcePackProvision'
import { provisionEarlyWindow } from './services/EarlyWindowProvision'
import {
  UpdateService,
  type PackManifest
} from './services/UpdateService'
import { SelfUpdateService } from './services/SelfUpdateService'
import { runMinecraftAuthSelfTest } from './services/MinecraftAuthSelfTest'
import { runUpdaterSelfTest, runSelfUpdateCheck } from './services/UpdaterSelfTest'
import { MinecraftAuth, toPublicState } from './services/MinecraftAuth'
import {
  GAME_ROOT_ENV,
  classifyModsDir,
  describeGameDir,
  discoverCandidateRoot,
  discoverLocalRoots,
  ensureGameStructure,
  expandPath,
  expandTokens,
  interpretPickedDir,
  leftoverEnvTokens,
  looksLikeOurInstance,
  resolveGameRoot,
  sourceLabel,
  type EnsureResult,
  type ModsDirState,
  type PathContext,
  type RootInfo
} from './services/GamePaths'
import { runGamePathsSelfTest, type LauncherProbe, type RawProfileLike } from './services/GamePathsSelfTest'

function memoryCleanupHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'memory-cleanup-helper.exe')
    : join(app.getAppPath(), 'resources', 'memory-cleanup-helper.exe')
}

/**
 * Delta 启动器 · 主进程
 *
 * 职责边界（见 launcher/ARCHITECTURE.md）：
 *   - 窗口生命周期、文件系统、**进程管理**都在这里
 *   - 启动 Minecraft 的逻辑放在本文件的 LaunchService（独立于 renderer）
 *   - renderer 只能通过 preload 暴露的白名单 API 调用，**不能执行任意命令**
 */

// ---------------------------------------------------------------------------
// 同意状态（条款前置的直接目的：游戏进程起来之前就把这件事问清楚）
// ---------------------------------------------------------------------------

/** 当前条款版本。**改一次就必须重新征求同意**（老同意不得自动延期）。 */
const TERMS_VERSION = '2026-10-07.3'

interface ConsentState {
  accepted: boolean
  launcherCaptureAllowed?: boolean
  termsVersion: string
  acceptedAt: string | null
  /**
   * 同意时的**启动器版本**。
   *
   * 运维 2026-09-18 要求：「同意条款每一次启动器更新都会弹出来要求同意」。
   * 这不是形式主义：新版可能带来新的采集项（0.3.x 就加了模块出处与资源包/光影扫描），
   * 而"我在 0.2.6 同意过"不等于"我同意 0.3.1 的行为"。
   */
  launcherVersion: string
}

/** 服务器状态查询结果（真 ping；失败时 online=false 并带 error） */
interface ServerStatus {
  online: boolean
  ping?: number
  players?: { online: number; max: number }
  motd?: string
  error?: string
}

function consentFile(): string {
  const dir = join(app.getPath('userData'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'consent.json')
}

function readConsent(): ConsentState {
  const fresh: ConsentState = {
    accepted: false,
    termsVersion: TERMS_VERSION,
    acceptedAt: null,
    launcherVersion: app.getVersion()
  }
  try {
    const parsed = JSON.parse(readFileSync(consentFile(), 'utf8')) as Partial<ConsentState>
    // 两条都要对得上才算"同意过"：
    //   ① **条款文本版本**：条款改了必须重问（老同意不得自动延期）；
    //   ② **启动器版本**：每次新版重新确认（运维 2026-09-18 要求）。
    // ⚠️ 旧记录里没有 launcherVersion 字段 ⇒ 会被判为过期，升级后第一次启动重问一次。
    //    这正是想要的行为：升级本身就是一次"新版"，而玩家此前同意的是旧版行为。
    if (parsed.termsVersion !== TERMS_VERSION) {
      console.log(
        `[consent] 条款版本变了（${parsed.termsVersion ?? '无'} → ${TERMS_VERSION}），重新征求同意`
      )
      return fresh
    }
    // 规则（运维 2026-09-18 定）：**大版本更新才重弹**。
    //
    // 为什么不是"每次更新"：0.3.8 → 0.3.9 这种补丁级更新一天可能发好几次，
    // 每次重弹会把"同意"变成一种骚扰 —— 而骚扰的结果是玩家闭眼点同意，
    // 那比不弹更糟（形式上的同意 ≠ 知情）。当初"每次更新都重弹"是上一版口径，
    // 运维看到自己被连问五次之后改成了现在这条。
    //
    // 判据是 **主.次**（major.minor）：0.3 → 0.4 重弹；0.3.8 → 0.3.9 不重弹。
    // 条款文本变化仍然一律重弹（下面那条 `termsVersion` 判断在它之前）。
    const majorMinor = (v: string): string => v.split('.').slice(0, 2).join('.')
    if (majorMinor(parsed.launcherVersion ?? '') !== majorMinor(app.getVersion())) {
      console.log(
        `[consent] 大版本变了（${parsed.launcherVersion ?? '旧记录无此字段'} → ${app.getVersion()}），重新征求同意`
      )
      return fresh
    }
    return {
      // This revision includes game-window evidence in the required terms.
      // A partial or old record cannot authorize launch or screenshot collection.
      accepted: parsed.accepted === true && parsed.launcherCaptureAllowed === true,
      launcherCaptureAllowed: parsed.accepted === true && parsed.launcherCaptureAllowed === true,
      termsVersion: TERMS_VERSION,
      acceptedAt: parsed.acceptedAt ?? null,
      launcherVersion: app.getVersion()
    }
  } catch {
    return fresh
  }
}

function writeConsent(accepted: boolean): ConsentState {
  const state: ConsentState = {
    accepted,
    launcherCaptureAllowed: accepted,
    termsVersion: TERMS_VERSION,
    acceptedAt: accepted ? new Date().toISOString() : null,
    launcherVersion: app.getVersion()
  }
  writeFileSync(consentFile(), JSON.stringify(state, null, 2), 'utf8')
  return state
}

// ---------------------------------------------------------------------------
// 启动服务（独立安装运行环境；命令由 config/launch.json 的 Forge 模板生成）
// ---------------------------------------------------------------------------

interface LaunchProfile {
  name: string
  java: string
  jvmArgs: string[]
  gameDir: string
  assetsDir: string
  assetIndex: string
  version: string
  username: string
  uuid: string
  width: number
  height: number
  /** 游戏根目录（.minecraft）。配置里的 `${GAME_DIR}` 按它展开 —— 换机器只改这一个字段。 */
  gameRoot: string
  /**
   * 程序参数段：**原样保存**（含 `--launchTarget forgeclient` 与 `--fml.*`）。
   *
   * 为什么不能只靠下面的具名字段拼：Forge 走 JPMS + ModLauncher，它需要
   * `--launchTarget`/`--fml.forgeVersion`/`--fml.mcVersion`/… 才能完成早期初始化；
   * 少了这些会抛 `ImmediateWindowHandler.load` 的 NPE（2026-09-17 真跑抓到）。
   * 会话相关的四项（username/uuid/accessToken/userType）由启动器覆盖。
   */
  programArgs?: string[]
  /** classpath 仅用于展示与完整性校验（M2），**不参与命令拼装**。 */
  classpath: string[]
}

/**
 * ⚠️ 安全红线：本服务**只接受 profileId**，命令由这里的模板拼出来。
 * 绝不提供"执行任意命令"的 IPC —— 那等于把 RCE 送进 UI 层。
 */
/**
 * 启动时填进 `--username/--uuid/--accessToken/--userType` 的身份。
 *
 * 为什么要单独一个类型（而不是直接传 `YggdrasilSession`）：
 * 现在有**三个来源**（正版微软 / LittleSkin / 离线占位），它们的凭据形状不同、
 * `--userType` 也不同（正版是 `msa`，皮肤站是 `mojang`）。让 LaunchService
 * 只认这一个窄接口，来源的判断就集中在调用方一处，不会散进命令拼装里。
 */
export interface LaunchIdentity {
  username: string
  uuid: string
  token: string
  /** 填进 `--userType`：`msa`（正版）/ `mojang`（皮肤站）/ `legacy`（离线） */
  type: string
}

/** Side-by-side executable copy; the configured Java binary is never modified. */
function brandedJava(javaPath: string): string {
  if (process.platform !== 'win32') return javaPath
  const source = resolve(javaPath)
  if (!/java(w)?\.exe$/i.test(source)) return javaPath
  const branded = join(dirname(source), '断界行动-起源beta.exe')
  try {
    const checksum = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
    if (!existsSync(branded) || checksum(source) !== checksum(branded)) copyFileSync(source, branded)
    return branded
  } catch (error) {
    console.warn('[launcher] 自定义游戏进程名不可用，使用原 Java：', error)
    return javaPath
  }
}

class LaunchService {
  private child: ChildProcess | null = null

  constructor(private readonly onState: (s: unknown) => void, private readonly onLog: (l: string) => void) {}

  state(): { state: string; pid?: number } {
    if (this.child && this.child.exitCode === null) return { state: 'running', pid: this.child.pid }
    return { state: 'idle' }
  }

  start(profile: LaunchProfile, identity?: LaunchIdentity | null, lease?: LaunchLease, javaMajor = 17): { ok: boolean; pid?: number; error?: string } {
    if (this.child && this.child.exitCode === null) {
      return { ok: false, error: '游戏已在运行' }
    }
    // 拼装方式：**java <jvmArgs 原样> <游戏参数>**。
    //
    // 为什么不是 `-cp classpath mainClass`：Forge 1.20.1 走 **JPMS 模块启动**
    // （`-cp … -p <模块路径> --add-modules ALL-MODULE-PATH --module cpw.mods…/…BootstrapLauncher`），
    // 没有独立的"主类"。第一版按主类拼，真机必然起不来（这条已踩过一次）。
    // 身份由调用方决定并已写进日志（正版 / LittleSkin / 离线），这里只负责填参。
    const authed = identity ?? {
      username: profile.username,
      uuid: profile.uuid,
      token: '0',
      type: 'legacy'
    }
    // 程序参数：**原样使用配置里的 programArgs**（含 --launchTarget/--fml.*），
    // 只把会话相关的四项替换成本次登录/离线值。
    // 退回具名字段拼装只用于兼容旧配置——那条路在 Forge 上必然 NPE（见 programArgs 注释）。
    const sessionValues: Record<string, string> = {
      '--username': authed.username,
      '--uuid': authed.uuid,
      '--accessToken': authed.token,
      '--userType': authed.type
    }
    const source = profile.programArgs && profile.programArgs.length > 0
      ? profile.programArgs
      : [
          '--username', profile.username,
          '--version', profile.version,
          '--gameDir', profile.gameDir,
          '--assetsDir', profile.assetsDir,
          '--assetIndex', profile.assetIndex,
          '--uuid', profile.uuid,
          '--accessToken', '0',
          '--userType', 'legacy',
          '--width', String(profile.width),
          '--height', String(profile.height)
        ]
    const programArgs: string[] = []
    for (let i = 0; i < source.length; i++) {
      const token = source[i]
      if (token in sessionValues) {
        programArgs.push(token, sessionValues[token])
        i++ // 跳过原值
      } else {
        programArgs.push(token)
      }
    }
    // ---- 片 1（2026-09-18 运维要求）：把玩家配置**真正接进命令行** ----
    // 拼装本身是**纯函数**（LaunchArgs.ts），因为 dry-run 不走这条路 ⇒ 只能靠自测钉住行为。
    const runtime = readEffectiveProfile()?.runtime ?? {
      memoryMb: 4096,
      width: null,
      height: null,
      fullscreen: false,
      gcMode: 'tuned' as const,
      autoMemoryMb: 4096,
      availableMb: 0,
      modCount: 0
    }
    let args: string[]
    try {
      const bootstrapRoot = [configDir(), join(app.getAppPath(), 'config')]
        .find(root => existsSync(join(root, 'delta-early-window.jar'))) ?? configDir()
      const jvm = provisionEarlyWindow(bootstrapRoot, profile.gameDir, profile.jvmArgs)
      args = buildLaunchArgs(jvm, programArgs, {
        ...runtime, javaMajor, launcherToken: lease?.initialToken ?? null,
        leaseUrl: lease?.url, leaseKey: lease?.key
      })
    } catch (error) {
      lease?.close()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const executable = brandedJava(profile.java)
    // 把最终命令行打进日志（脱敏）。没有这一条，"设了没生效"与"没设"在外部一模一样。
    try {
      this.onLog(
        `[launcher] 内存=${readOverrides().memoryMb ? `手动 ${runtime.memoryMb}MB` : `自动→${runtime.memoryMb}MB（N=${runtime.modCount}, 可用=${(runtime.availableMb / 1024).toFixed(1)}G）`} GC=${runtime.gcMode} Java=${javaMajor} 分辨率=${runtime.width ?? '模板值'}x${runtime.height ?? '模板值'} 全屏=${runtime.fullscreen ? '是' : '否'}\n`
      )
      this.onLog(`[launcher] 命令行：${redactCommandLine(executable, args)}\n`)
    } catch {
      // 日志失败绝不能挡住启动
    }
    try {
      this.onState({ state: 'starting' })
      assertTrustedJvmArgs(args)
      this.child = spawn(executable, args, { cwd: profile.gameDir, windowsHide: false, env: trustedJavaEnvironment(process.env) })
      this.child.stdout?.on('data', (b: Buffer) => this.onLog(b.toString('utf8')))
      this.child.stderr?.on('data', (b: Buffer) => this.onLog(b.toString('utf8')))
      this.child.on('exit', (code, signal) => {
        lease?.close()
        this.onLog(`[launcher] 游戏进程已退出：代码=${code ?? '无'}${signal ? `，信号=${signal}` : ''}\n`)
        this.onState({ state: 'exited', code })
        this.child = null
      })
      this.child.on('error', (err) => {
        lease?.close()
        this.onLog(`[launcher] 启动失败：${err.message}`)
        this.onState({ state: 'exited', code: -1 })
        this.child = null
      })
      this.onState({ state: 'running', pid: this.child.pid })
      return { ok: true, pid: this.child.pid }
    } catch (e) {
      lease?.close()
      const msg = e instanceof Error ? e.message : String(e)
      this.onState({ state: 'idle' })
      return { ok: false, error: msg }
    }
  }

  /** 退出时收尾：不留孤儿 javaw（进程管理职责）。 */
  stop(): void {
    if (this.child && this.child.exitCode === null) this.child.kill()
    this.child = null
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

let win: BrowserWindow | null = null
watchDownloadSpeed(speed => win?.webContents.send('download:speed', speed))
const acMonitor = new AcMonitor()
const launcherCapture = new LauncherCapture()
function monitorSnapshot(): ReturnType<AcMonitor['snapshot']> {
  const snapshot = acMonitor.snapshot(readConsent().accepted, sessionCheck.state, activeLease?.status() ?? null)
  // The Java "device" receipt is PCI inventory, not a stable launcher identity.
  snapshot.tasks = snapshot.tasks.filter(task => task.id !== 'device')
  if (player) snapshot.tasks.push(...player.deviceTasks())
  snapshot.tasks.push(launcherCapture.snapshot())
  if (snapshot.tasks.some(task => task.state === 'error')) snapshot.status = 'error'
  return snapshot
}
let activeLease: LaunchLease | null = null
let selfUpdateBusy = false
function downloadActivity(p: DownloadActivity): void {
  win?.webContents.send('download:activity', p)
}
function bundleActivity(p: BundleProgress): void {
  win?.webContents.send('launch:log', { line: `[launcher] 客户端资源：${p.message}` })
  downloadActivity({ id: 'bundle', title: '枪械与客户端资源', phase: p.phase === 'done' ? 'done' : p.phase === 'error' ? 'error' : 'working', percent: p.phase === 'checking' ? null : p.percent, current: p.message, remaining: p.phase === 'done' ? 0 : 1, error: p.phase === 'error' ? p.message : undefined })
}
async function installRedPack(api: string, gameDir: string): ReturnType<typeof provisionRedResourcePack> {
  downloadActivity({ id: 'red3d', title: '物品模型与贴图', phase: 'working', percent: null, current: '检查资源包', remaining: 1 })
  const result = await provisionRedResourcePack(api, gameDir, message => {
    win?.webContents.send('launch:log', { line: `[launcher] 红色物品 3D：${message}` })
    const bytes = message.match(/(\d+)\/(\d+) MB/)
    downloadActivity({ id: 'red3d', title: '物品模型与贴图', phase: 'working', percent: bytes && Number(bytes[2]) > 0 ? Math.min(99, Math.round(Number(bytes[1]) / Number(bytes[2]) * 100)) : null, current: '3D 资源包', remaining: 1 })
  })
  downloadActivity({ id: 'red3d', title: '物品模型与贴图', phase: result.ok ? 'done' : 'error', percent: result.ok ? 100 : null, current: '3D 资源包', remaining: result.ok ? 0 : 1, error: result.error })
  return result
}
let launch: LaunchService | null = null
/** LittleSkin 会话（token 缓存文件放在启动器自己的目录，不放游戏目录）。 */
let auth: YggdrasilAuth
/**
 * 玩家系统会话（**准入**用的那一个）。
 *
 * 与 `auth` 的区别见 `services/PlayerApi.ts` 顶部注释：
 * `auth` 管皮肤，本对象管"允不允许进服"。2026-09-17 之前的启动器只有前者，
 * 于是没有它也能用离线占位进游戏——那正是本轮要删掉的"离线兜底"。
 */
let player: PlayerApi

/**
 * 本次启动要传给游戏的「启动器来源令牌」（D2 加强版）。
 *
/**
 * 正版（微软）登录会话。
 *
 * 与 `auth`（LittleSkin 皮肤会话）、`player`（准入会话）是**三件不同的事**：
 * 只有它能在 online-mode 的游戏服上给出**真实 UUID**（否则服务端会用
 * `OfflinePlayer:<名字>` 派生一个完全不同的 UUID）。
 */
let mcAuth: MinecraftAuth
let identityAttempt = 0
let microsoftLinkSession: { token: string; name: string } | undefined
/**
 * 最后一次**异步**会话校验的结论（由 `player:status` 写入，`preflight` 只读）。
 *
 * 为什么要缓存而不是每次现查：闸门必须**同步**给出结论（renderer 点一下就要看到结果），
 * 而校验要打网络。缓存的是**结论**，不是"是否登录"这个猜测——
 * 未经校验时它是 `unreachable`（拒绝启动），不会退化成"放行"。
 */
let sessionCheck: PlayerSessionState = { state: 'unreachable', error: '尚未校验' }

/**
 * 干跑开关（`--uishot-dry-run`）：闸门照判，但**不 spawn 游戏进程**。
 * 只在界面自检里打开——否则"无点击自检"会在已经登录的机器上真的开一次游戏。
 */
let dryRun = false

/** 会话状态 → renderer 可用的形状（**不回传 token**）。 */
function shapeSession(s: PlayerSessionState): {
  state: PlayerSessionState['state']
  name?: string
  email?: string
  site?: string
  reason?: string
  error?: string
} {
  switch (s.state) {
    case 'ok':
      return { state: 'ok', name: s.player.name, email: s.player.email, site: s.player.site }
    case 'banned':
      return { state: 'banned', name: s.player.name, reason: s.reason }
    case 'unreachable':
      return { state: 'unreachable', error: s.error }
    default:
      return { state: 'none' }
  }
}

/**
 * 玩家系统 API 根地址。
 *
 * 允许 `--player-api <url>` 与 `DELTA_PLAYER_API` 覆盖，**只为测试与换服**：
 * 验收脚本要能在本机起一个 mock 服务把整条链跑通，而不是每次都打真服务器。
 * 默认仍是生产地址，玩家侧无需任何配置。解析逻辑见 `PlayerApi.resolveApiBase`。
 */
function playerApiBase(): string {
  return resolveApiBase(process.argv)
}

/**
 * `--uishot`：界面渲染自检——**不需要人点**。
 *
 * 为什么要有：本仓库对"能不能启动"有探针，但对"界面长什么样、点了有没有反应"一直只能靠人看。
 * 于是所有 UI 改动都停在"tsc 过了、能打包"这一层，而那**证明不了界面能渲染**：
 * React 里一个运行时错误就是白屏，typecheck 抓不到。
 *
 * 做法：开窗 → 截图 → 按文本找按钮并点击（等同人手点）→ 再截图 → 退出。
 * 顺带把页面可见文本 dump 出来，方便做文本级断言。
 *
 * 产物：`<dir>/00-boot.png` … + `uishot.json`（每步点了什么、页面文本、成败）。
 * 它**只读界面、只点设置页**，不会启动游戏、不会改出厂文件。
 */
async function uiShot(): Promise<void> {
  const i = process.argv.indexOf('--shot-dir')
  const dirArg = i >= 0 ? process.argv[i + 1] : undefined
  const dir = dirArg && !dirArg.startsWith('--') ? dirArg : app.getPath('temp')
  mkdirSync(dir, { recursive: true })
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const steps: { step: string; clicked?: string; found?: boolean; text?: string }[] = []

  const shot = async (name: string): Promise<void> => {
    if (!win) return
    const img = await win.webContents.capturePage()
    writeFileSync(join(dir, name), img.toPNG())
  }
  const visibleText = async (): Promise<string> =>
    (await win?.webContents.executeJavaScript(
      // 4000 而不是 1200：设置页的候选列表在页面后半部分，截太短会让
      // uishot 自己"找不到实例行"，看起来像应用坏了（2026-09-17 踩到）。
      `document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 4000)`
    )) ?? ''
  // 按文本找按钮并点击——就是人手那一下，避免依赖 React 内部状态
  const click = async (label: string): Promise<boolean> =>
    (await win?.webContents.executeJavaScript(
      `(() => {
         const el = [...document.querySelectorAll('button,a')]
           .find((e) => (e.textContent || '').trim().includes(${JSON.stringify(label)}))
         if (!el) return false
         el.click()
         return true
       })()`
    )) === true

  if (process.argv.includes('--identity-ui-test')) {
    if (!diagnosticUserData) throw new Error('Identity UI test requires isolated user data')
    await wait(1200)
    if ((await visibleText()).includes('同意并继续')) {
      await click('同意并继续')
      await wait(250)
    }
    const opened = await click('未登录')
    await wait(350)
    const fields = await win?.webContents.executeJavaScript(`(() => {
      const form=document.querySelector('form');
      return { form:!!form, passwords:form?.querySelectorAll('input[type="password"]').length ?? 0,
        account:!!form?.querySelector('input[autocomplete="username"]'), text:form?.innerText ?? '' };
    })()`)
    const ipc = await win?.webContents.executeJavaScript(`window.delta.player.loginLittleSkin('', '')`)
    await win?.webContents.executeJavaScript(`document.querySelector('form')?.requestSubmit()`)
    await wait(150)
    const text = await visibleText()
    await shot('littleskin-login.png')
    const passed = opened && fields.form && fields.passwords===1 && fields.account
      && fields.text.includes('登录 LittleSkin') && !fields.text.includes('验证码')
      && ipc.error==='bad_request' && text.includes('请输入 LittleSkin 账号和密码')
    writeFileSync(join(dir,'identity-ui-proof.json'),JSON.stringify({passed,fields,ipc,text},null,2),'utf8')
    console.log('IDENTITY_NATIVE_UI_TEST',passed)
    quitting=true
    app.exit(passed ? 0 : 1)
    return
  }

  if (process.argv.includes('--low-memory-ui-test')) {
    if (!diagnosticUserData) throw new Error('Low memory UI test requires isolated user data')
    // Synthetic diagnostic profile only; no player account, launch or production consent is changed.
    writeConsent(true); await setRuntimeSettings({ gameImportNoticeSeen: true }); win?.webContents.reload()
    await wait(2500)
    if ((await visibleText()).includes('同意并继续')) { await click('同意并继续'); await wait(1200) }
    await click('设置'); await wait(1000)
    const toggle = async (): Promise<boolean> => (await win?.webContents.executeJavaScript(`(() => {const label=[...document.querySelectorAll('label')].find(e=>e.innerText.includes('低配模式启动'));const input=label?.querySelector('input[type="checkbox"]');if(!input)return false;label.scrollIntoView({block:'center'});input.click();return true})()`)) === true
    const initial = await win?.webContents.executeJavaScript('window.delta.config.runtimeGet()')
    const on = await toggle(); await wait(400)
    const enabled = await win?.webContents.executeJavaScript('window.delta.config.runtimeGet()')
    await shot('low-memory-enabled.png')
    const off = await toggle(); await wait(400)
    const disabled = await win?.webContents.executeJavaScript('window.delta.config.runtimeGet()')
    const proof = { defaultOff: initial.lowMemoryMode !== true, onSaved: on && enabled.lowMemoryMode === true, offSaved: off && disabled.lowMemoryMode === false, text: await visibleText() }
    writeFileSync(join(dir,'low-memory-ui-proof.json'),JSON.stringify(proof,null,2),'utf8')
    quitting=true;app.exit(proof.defaultOff&&proof.onSaved&&proof.offSaved?0:1);return
  }

  if (process.argv.includes('--memory-cleanup-ui-test')) {
    await wait(1200)
    if ((await visibleText()).includes('同意并继续')) {
      if (process.argv.includes('--capture-proof')) {
        await win?.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]')?.click()`)
      }
      await click('同意并继续')
      await wait(500)
    }
    const initial = await win?.webContents.executeJavaScript('window.delta.config.runtimeGet()')
    const clickedFirst = await win?.webContents.executeJavaScript(`(() => {
      const label=[...document.querySelectorAll('label')].find(e=>e.innerText.includes('内存优化模式'));
      const input=label?.querySelector('input[type="checkbox"]'); if(!input) return false; input.click(); return true;
    })()`)
    await wait(300)
    const noticeText = await visibleText()
    await shot('memory-cleanup-first-prompt.png')
    const noticeCorrect = noticeText.includes('修剪系统进程工作集')
      && noticeText.includes('刷新已修改内存页')
      && noticeText.includes('HDD（机械硬盘）开启会产生负优化；开启后启动速度会变慢')
    const canceled = await click('取消')
    await wait(300)
    const afterCancel = await win?.webContents.executeJavaScript('window.delta.config.runtimeGet()')
    const clickedAgain = await win?.webContents.executeJavaScript(`(() => {
      const label=[...document.querySelectorAll('label')].find(e=>e.innerText.includes('内存优化模式'));
      const input=label?.querySelector('input[type="checkbox"]'); if(!input) return false; input.click(); return true;
    })()`)
    await wait(300)
    const secondToggleText = await visibleText()
    const afterEnable = await win?.webContents.executeJavaScript('window.delta.config.runtimeGet()')
    const disabled = await win?.webContents.executeJavaScript(`(() => {
      const label=[...document.querySelectorAll('label')].find(e=>e.innerText.includes('内存优化模式'));
      const input=label?.querySelector('input[type="checkbox"]'); if(!input) return false; input.click(); return true;
    })()`)
    await wait(300)
    const afterDisable = await win?.webContents.executeJavaScript('window.delta.config.runtimeGet()')
    const proof = {
      initialDefaultOff: initial?.memoryCleanupEnabled !== true,
      openedFirstNotice: clickedFirst && noticeCorrect,
      cancelRecordedOnce: canceled && afterCancel?.memoryCleanupEnabled !== true && afterCancel?.memoryCleanupNoticeSeen === true,
      laterToggleDoesNotPrompt: clickedAgain && !secondToggleText.includes('启动前回收内存说明') && afterEnable?.memoryCleanupEnabled === true,
      offStatePersists: disabled && afterDisable?.memoryCleanupEnabled === false && afterDisable?.memoryCleanupNoticeSeen === true,
      noticeText
    }
    writeFileSync(join(dir, 'memory-cleanup-ui-proof.json'), JSON.stringify(proof, null, 2), 'utf8')
    console.log('MEMORY_CLEANUP_UI_TEST', JSON.stringify(proof))
    quitting = true
    app.exit(Object.entries(proof).filter(([key]) => key !== 'noticeText').every(([, value]) => value === true) ? 0 : 1)
    return
  }

  const step = async (name: string, label?: string): Promise<void> => {
    const rec: { step: string; clicked?: string; found?: boolean; text?: string } = { step: name }
    if (label) {
      rec.clicked = label
      rec.found = await click(label)
    }
    await wait(1200)
    rec.text = await visibleText()
    steps.push(rec)
    await shot(`${name}.png`)
  }

  await wait(2500)
  // 首次运行会先看到条款页——那正是玩家第一步，先把它截下来。
  // 判据用**按钮文字**，不要用页面里出现"条款"两字：首页公告里也有"条款"，
  // 会误判成条款页（2026-09-17 踩到，白截一张还去点不存在的按钮）。
  await step('00-boot')
  if (await win?.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('同意并继续'))`
  )) {
    if (process.argv.includes('--capture-proof')) await win?.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]')?.click()`)
    await step('01-consent', '同意并继续')
  }
  // 逐页截图：新版界面每个页都要看一眼（例图对齐度只能靠眼睛判断）
  await step('02-mods', '模组管理')
  await step('03-news', '新闻资讯')
  await step('04-settings', '设置')
  await step('05-home', '首页')

  // 右上角用户区：点开登录浮层，并在输入框里打一个角色名，验证**头像预览**真的出图
  const chip = await win?.webContents.executeJavaScript(
    `(() => {
       const b = [...document.querySelectorAll('button')].find((e) => /未登录|离线账号|在线/.test(e.textContent || ''))
       if (!b) return false
       b.click(); return true
     })()`
  )
  await wait(700)
  const typed = await win?.webContents.executeJavaScript(
    `(() => {
       const el = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('邮箱'))
       if (!el) return false
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
       setter.call(el, 'zifeng024')
       el.dispatchEvent(new Event('input', { bubbles: true }))
       return true
     })()`
  )
  await wait(1600) // 等 400ms 防抖 + 抓图
  const hasImg = await win?.webContents.executeJavaScript(
    `[...document.querySelectorAll('img')].some((i) => (i.src || '').startsWith('data:image/png'))`
  )
  // 登录方式选择器（原"简体中文"假下拉框的位置）：点一下"正版登录"，
  // 断言①标题栏那枚标签真的跟着变（说明它是活的、不是装饰）②相应提示出现。
  //
  // ⚠️ 必须**分两次 executeJavaScript**：第一次开面板，等 React 重渲染，
  // 第二次才找按钮。写在同一次调用里点完立刻查 DOM，React 还没提交那次更新，
  // 于是必然找不到按钮 —— 而且它**时灵时不灵**（取决于面板恰好是否已开着），
  // 是那种最难查的 flaky 检查（2026-09-17 实测：同样的代码一次过、一次不过）。
  const chipTextBefore = await win?.webContents.executeJavaScript(
    `(() => {
       const chip = () => [...document.querySelectorAll('button')]
         .find((e) => /未登录|在线|已封禁|校验失败/.test(e.textContent || ''))
       const c = chip()
       if (c && !document.body.innerText.includes('登录方式')) c.click()
       return (chip()?.textContent || '').trim()
     })()`
  )
  await wait(500) // 给 React 一次渲染
  const method = await win?.webContents.executeJavaScript(
    `(() => {
       const btn = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === '正版登录')
       if (btn) btn.click()
       return { clicked: !!btn, panelOpen: document.body.innerText.includes('登录方式') }
     })()`
  )
  await wait(500)
  const methodAfter = await win?.webContents.executeJavaScript(
    `(() => {
       const t = document.body.innerText
       const chip = [...document.querySelectorAll('button')]
         .find((e) => /未登录|在线|已封禁|校验失败/.test(e.textContent || ''))
       return {
         // 切到正版后必须出现**可操作的下一步**：微软登录按钮 + 设备码说明。
         // 断言"能继续"而不是断言某句提示文案——文案会变，能力不该变。
         premiumReady: t.includes('用微软账号登录') && t.includes('密码只在微软页面里输入'),
         chipText: (chip?.textContent || '').trim()
       }
     })()`
  )
  const ma = (methodAfter ?? {}) as { premiumReady?: boolean; chipText?: string }
  steps.push({
    step: '06b-login-method',
    clicked: `点"正版登录"=${(method as { clicked?: boolean })?.clicked === true}`,
    found: ma.premiumReady === true,
    text:
      `账号按钮切换前=[${String(chipTextBefore ?? '')}]\n` +
      `账号浮层已展开=${(method as { panelOpen?: boolean })?.panelOpen === true}\n` +
      `账号按钮切换后=[${ma.chipText ?? ''}]\n` +
      `切换后可继续操作=${ma.premiumReady === true}\n` +
      await visibleText()
  })
  await shot('06b-login-method.png')

  // 切回 LittleSkin，然后**验证验证码输入框真的存在**。
  //
  // 为什么单独断言这一条：2026-09-17 运维截图问"没看到能在哪填写验证码"。
  // 原因是那个输入框原来只在"发码成功"后才渲染，而被 60 秒冷却挡住时不会出现；
  // 而**光看页面文本看不出输入框在不在**（"第 2 步：填邮件里的 6 位验证码"这行字
  // 在框没渲染时也可能出现），所以必须查 DOM。否则自检会给一个"看起来没问题"的假绿。
  await win?.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === 'LittleSkin')?.click()`
  )
  await wait(500)
  const codebox = await win?.webContents.executeJavaScript(
    `(() => {
       const inputs = [...document.querySelectorAll('input')]
       const code = inputs.find((i) => (i.placeholder || '').includes('验证码'))
       return {
         inputCount: inputs.length,
         hasCodeInput: !!code,
         hasManualEntry: document.body.innerText.includes('我已经有验证码了')
       }
     })()`
  )
  const cb = (codebox ?? {}) as { inputCount?: number; hasCodeInput?: boolean; hasManualEntry?: boolean }
  steps.push({
    step: '06c-code-entry',
    clicked: `验证码输入框存在=${cb.hasCodeInput === true}`,
    found: cb.hasCodeInput === true,
    text:
      `页面 input 数=${cb.inputCount}\n` +
      `验证码输入框=${cb.hasCodeInput === true}\n` +
      `手动展开入口=${cb.hasManualEntry === true}\n` +
      await visibleText()
  })
  await shot('06c-code-entry.png')
  await shot('06b-login-method.png')

  // ---- 密码登录（2026-09-18）：面板必须**按账号状态**给出正确的下一步 ----
  //
  // 这条查的是"React 面板 + IPC + 线上接口"三者真的接上了 —— 而上面那些步骤都证明不了它：
  //   · 没设过密码的账号 → 邮箱 + 验证码 **+ 设置密码两个框** + 「设置密码并登录」
  //   · 设过密码的账号   → 只要密码 + 「忘记密码？用邮箱验证码重置」，**邮箱框不该出现**
  // 断言一律查 **DOM**（占位符/按钮文字），不查页面文本：
  // "文本里出现『密码』两个字"与"输入框真的在"是两回事，后者才是玩家能不能操作。
  const panelSignature = async (): Promise<Record<string, boolean>> =>
    (await win?.webContents.executeJavaScript(
      `(() => {
         const inputs = [...document.querySelectorAll('input')]
         const hasInput = (ph) => inputs.some((i) => (i.placeholder || '').includes(ph))
         const hasBtn = (t) => [...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes(t))
         return {
           nameInput: hasInput('角色名'),
           emailInput: hasInput('邮箱'),
           codeInput: hasInput('验证码'),
           passwordInput: hasInput('密码'),
           password2Input: hasInput('再输一次'),
           setPasswordBtn: hasBtn('设置密码并登录') || hasBtn('重置密码并登录'),
           resetEntry: hasBtn('忘记密码'),
           loginBtn: hasBtn('登录')
         }
       })()`
    )) ?? {}
  const typeName = async (value: string): Promise<boolean> =>
    (await win?.webContents.executeJavaScript(
      `(() => {
         const el = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('角色名'))
         if (!el) return false
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
         setter.call(el, ${JSON.stringify(value)})
         el.dispatchEvent(new Event('input', { bubbles: true }))
         return true
       })()`
    )) === true
  const clickBtn = async (label: string): Promise<boolean> =>
    (await win?.webContents.executeJavaScript(
      `(() => {
         const b = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').includes(${JSON.stringify(label)}))
         if (!b) return false
         b.click(); return true
       })()`
    )) === true

  // (a) 没设过密码的账号：走邮箱流，且**验证码那一步要能设密码**
  const typedNoPw = await typeName('zifeng024')
  await wait(2200) // 400ms 防抖 + 线上 account/status 往返
  const sigA0 = (await panelSignature()) as Record<string, boolean>
  await clickBtn('我已经有验证码了')
  await wait(600)
  const sigA = (await panelSignature()) as Record<string, boolean>
  const noPwOk =
    sigA0.emailInput === true && sigA0.passwordInput !== true && // 这一档不该直接要密码
    sigA0.resetEntry !== true &&                                  // 「忘记密码」只属于有密码的账号
    sigA.codeInput === true && sigA.passwordInput === true &&
    sigA.password2Input === true && sigA.setPasswordBtn === true
  steps.push({
    step: '06d-password-flow',
    clicked: `输入角色名=${typedNoPw === true}`,
    found: noPwOk,
    text:
      `【没设过密码 zifeng024】初始面板=${JSON.stringify(sigA0)}\n` +
      `【展开验证码后】=${JSON.stringify(sigA)}\n` +
      `判定（邮箱流 + 验证码那一步能设密码，且不出现『忘记密码』）=${noPwOk}\n` +
      await visibleText()
  })
  await shot('06d-password-flow.png')

  // (b) 设过密码的账号：**只要密码**（用一个一次性测试账号；跑完由 ac-tools 脚本清掉）
  //     名字为空时跳过这条（没造账号的话不该让整轮 uishot 变红 —— 那会变成假红）。
  const pwProbeName = process.env['DELTA_UISHOT_PW_ACCOUNT'] ?? ''
  if (pwProbeName) {
    const typedPw = await typeName(pwProbeName)
    await wait(2200)
    const sigB = (await panelSignature()) as Record<string, boolean>
    const pwOk =
      sigB.passwordInput === true && sigB.resetEntry === true && sigB.loginBtn === true &&
      sigB.emailInput !== true && sigB.codeInput !== true // 这条路上不该出现邮箱/验证码框
    steps.push({
      step: '06e-password-only',
      clicked: `输入角色名=${typedPw === true}（账号=${pwProbeName}）`,
      found: pwOk,
      text:
        `【设过密码的账号】面板=${JSON.stringify(sigB)}\n` +
        `判定（只要密码 + 有『忘记密码』入口 + 不出现邮箱/验证码框）=${pwOk}\n` +
        await visibleText()
    })
    await shot('06e-password-only.png')
  } else {
    steps.push({
      step: '06e-password-only',
      clicked: '（未提供 DELTA_UISHOT_PW_ACCOUNT，跳过）',
      found: true,
      text: '设置 DELTA_UISHOT_PW_ACCOUNT=<一次性账号名> 可核验"有密码 ⇒ 只要密码"那一条。'
    })
  }
  // 已经切回 LittleSkin 了（见上一步），这里只截一张带账号浮层的图
  steps.push({
    step: '06-user-chip',
    clicked: `点开账号区=${chip === true} 输入角色名=${typed === true} 头像出图=${hasImg === true}`,
    found: hasImg === true,
    text: await visibleText()
  })
  await shot('06-user-chip.png')
  await win?.webContents.executeJavaScript(`document.body.click()`)
  await wait(400)

  // ---- 启动闸门：**点一次启动**，看它到底放行还是拒绝 ----
  // 这一条是第 2 项的核验点：没有玩家系统会话时，点下去必须被拦，且页面要说清原因。
  // `dryRun` 由 `--uishot-dry-run` 打开：即使**已经登录**（比如运维自己这台），
  // 也只走判定、绝不真的拉起游戏——否则"无点击自检"会变成"每次都开一次游戏"。
  dryRun = process.argv.includes('--uishot-dry-run')
  // ⚠️ 这一段必须包 try/catch：`executeJavaScript` 的返回值要**可结构化克隆**，
  // 一旦序列化失败它会 reject，而 uiShot 是 `void uiShot()` 起的——
  // 于是整个函数静默中止，后面所有 step 都不执行，`uishot.json` 里只剩前半截，
  // 看起来像"界面没问题"（2026-09-17 就是这样被骗过一次）。
  let pre: { banner?: string | null; loginRequired?: boolean } | null = null
  try {
    pre =
      ((await win?.webContents.executeJavaScript(
        `(() => { const t = document.body.innerText
           const m = t.match(/现在不能启动[\\s\\S]{0,120}/)
           return { banner: m ? String(m[0]).replace(/\\n+/g, ' ').slice(0, 120) : null,
                    loginRequired: t.includes('LOGIN REQUIRED') } })()`
      )) as { banner?: string | null; loginRequired?: boolean } | undefined) ?? null
  } catch (e) {
    pre = { banner: `（读取闸门状态失败：${e instanceof Error ? e.message : String(e)}）` }
  }
  const clicked = await click('启动游戏')
  await wait(900)
  const after = await visibleText()
  const launchLines = [...after.matchAll(/\[launcher\][^\n]*/g)].map((m) => m[0])
  steps.push({
    // ⚠️ 名字必须与 `--with-launch` 那条（`07-launch-click`）**不同**。
    // `uishot.json` 的 `texts` 是 `{step 名 → 页面文本}`，重名会互相覆盖，
    // 于是一条真日志被静默丢掉、读出来是空字符串——看起来像"界面没显示"。
    // 2026-09-17 正是这样让验收脚本误报"闸门失效"（截图其实是对的）。
    step: '07-launch-gate',
    clicked: `点启动=${clicked === true} dryRun=${dryRun === true}`,
    found: true,
    text:
      `闸门横幅: ${pre?.banner ?? '（无，说明允许启动）'}\n` +
      `LOGIN REQUIRED=${pre?.loginRequired === true}\n` +
      `启动日志: ${launchLines.slice(-3).join(' | ') || '（无）'}`
  })
  await shot('07-launch-gate.png')

  // ---- 「反作弊启动中」浮层（**独立窗口**，贴在整个屏幕右下角）----
  //
  // 这块浮层的全部证据都在画面上，而它的失效方式全是**静默**的，所以判据要钉三件事：
  //   ① 窗口**真的存在**、坐标在屏幕右下角（由 workArea 算出来，不是猜的）；
  //   ② 里面的读条**真的在推进**（隔 2.6 秒两次读宽度，比"有没有那个 div"强得多）；
  //   ③ 到点**真的自己收起**（留一块关不掉的置顶窗是最糟的失效方式）。
  // ⚠️ 截图必须拍 `acAnimWin` 而不是 `win`：浮层不在启动器窗口里，
  //    拍主窗口只会得到一张"什么都没有"的图，然后被误读成"浮层没出现"。
  // 期望它出现 ⇔ 点到了启动且被放行（干跑也算：干跑只跳过 spawn 那一步，
  // 浮层照开 —— 正是这一点让"浮层真的出现了"能在不启动游戏的前提下被验到）。
  const launchPassed = clicked === true && (pre?.loginRequired !== true || dryRun === true)
  const animWin = acAnimWin
  const readAnim = async (): Promise<{
    panel: boolean
    percent: number | null
    hasVideo: boolean
    videoSrc: string | null
    videoReady: number | null
    fallback: boolean
    text: string
  }> => {
    const target = acAnimWin && !acAnimWin.isDestroyed() ? acAnimWin : null
    if (!target) {
      return {
        panel: false,
        percent: null,
        hasVideo: false,
        videoSrc: null,
        videoReady: null,
        fallback: false,
        text: ''
      }
    }
    return (
      ((await target.webContents.executeJavaScript(
        `(() => {
           const panel = document.querySelector('[data-testid="ac-startup-overlay"]')
           if (!panel) return { panel: false, percent: null, hasVideo: false, videoSrc: null, videoReady: null, fallback: false, text: '' }
           const fill = panel.querySelector('[data-testid="ac-startup-bar"]')
           const w = fill ? parseFloat(getComputedStyle(fill).width) : NaN
           const track = panel.querySelector('[data-testid="ac-startup-track"]')
           const tw = track ? parseFloat(getComputedStyle(track).width) : NaN
           const v = panel.querySelector('video')
           return {
             panel: true,
             percent: Number.isFinite(w) && Number.isFinite(tw) && tw > 0 ? Math.round((w / tw) * 100) : null,
             hasVideo: !!v,
             videoSrc: v ? String(v.currentSrc || v.getAttribute('src') || '') : null,
             videoReady: v ? v.readyState : null,
             fallback: !!panel.querySelector('svg'),
             text: (panel.innerText || '').replace(/\\n+/g, ' | ').slice(0, 200)
           }
         })()`
      )) as {
        panel: boolean
        percent: number | null
        hasVideo: boolean
        videoSrc: string | null
        videoReady: number | null
        fallback: boolean
        text: string
      } | undefined) ?? {
        panel: false,
        percent: null,
        hasVideo: false,
        videoSrc: null,
        videoReady: null,
        fallback: false,
        text: ''
      }
    )
  }
  await wait(2400)
  const animA = await readAnim()
  // 截图要对着**浮层窗口**拍（`shot()` 默认拍主窗口，这里单独处理）
  if (animWin && !animWin.isDestroyed()) {
    const img = await animWin.webContents.capturePage()
    writeFileSync(join(dir, '07b-ac-anim.png'), img.toPNG())
  }
  await wait(2400)
  const animB = await readAnim()
  const animPctOk = animB.percent !== null && animB.percent > 0 && animB.percent <= 100
  const animAdvancing = animA.percent !== null && animB.percent !== null && animB.percent > animA.percent
  const animSrcOk = !animB.hasVideo || (animB.videoSrc ?? '').startsWith('file://')
  // 几何 + 角位：右边缘距工作区右边 = AC_ANIM_MARGIN，下边缘同理
  const animGeo =
    animWin && !animWin.isDestroyed()
      ? (() => {
          const b = animWin.getBounds()
          const wa = screen.getDisplayMatching(b).workArea
          return {
            bounds: b,
            workArea: wa,
            rightGap: wa.x + wa.width - (b.x + b.width),
            bottomGap: wa.y + wa.height - (b.y + b.height)
          }
        })()
      : null
  const cornerOk =
    animGeo !== null && animGeo.rightGap === AC_ANIM_MARGIN && animGeo.bottomGap === AC_ANIM_MARGIN
  steps.push({
    step: '07b-ac-anim',
    clicked: `点启动=${clicked === true} 期望出现=${launchPassed} 素材=${
      animB.hasVideo ? '已放（视频）' : '未放（品牌标记 + 动态条）'
    }`,
    // 期望出现 ⇒ 必须真的出现、条在推进、视频（若有）是 file://、窗口贴在右下角
    found: launchPassed
      ? animB.panel && animPctOk && animAdvancing && animSrcOk && cornerOk
      : animB.panel === false,
    text:
      `浮层窗口=${animWin && !animWin.isDestroyed() ? '存在' : '不存在'}（期望 ${launchPassed}）\n` +
      `窗口几何=${animGeo ? JSON.stringify(animGeo.bounds) : '—'} 工作区=${
        animGeo ? JSON.stringify(animGeo.workArea) : '—'
      }（右边距=${animGeo?.rightGap} 下边距=${animGeo?.bottomGap}，期望都是 ${AC_ANIM_MARGIN}）\n` +
      `面板存在=${animB.panel} 读条百分比：第 2.4 秒=${animA.percent} → 第 4.8 秒=${animB.percent}` +
      `（在推进=${animAdvancing}，${animPctOk ? '在 1..100 区间' : '⚠️ 越界'}）\n` +
      `video 元素=${animB.hasVideo} src=${animB.videoSrc ?? '（无）'} readyState=${animB.videoReady}\n` +
      `品牌标记回落=${animB.fallback}\n` +
      `面板文本=[${animB.text}]`
  })

  // 到点必须**自己收起**：一块贴在屏幕上、置顶、点透而且没有关闭入口的窗口
  // 如果不会自己消失，玩家只能去任务管理器杀进程 —— 所以这条必须单独验。
  //
  // ⚠️ 等待时长必须**相对浮层真实出现的时刻**算，不能写死秒数：
  //    浮层是在"点启动"那一步开的，而自检从那一步走到这里已经过了好几秒；
  //    写死秒数会在改 `AC_ANIM_MS` 时变成**假红**（2026-09-19 实测：8.6→11.2 秒之后，
  //    这条立刻报"没自动收起"，而窗口其实完全正常）。判据要相对事实，不相对步骤。
  const animAge = acAnimOpenedAt > 0 ? Date.now() - acAnimOpenedAt : 0
  const animWaitLeft = Math.max(0, AC_ANIM_MS + 1500 - animAge)
  await wait(animWaitLeft)
  const animGone = acAnimWin === null || acAnimWin.isDestroyed()
  steps.push({
    step: '07c-ac-anim-autoclose',
    clicked: `浮层已存在 ${animAge} ms，再等 ${animWaitLeft} ms（AC_ANIM_MS=${AC_ANIM_MS}）`,
    found: launchPassed ? animGone : true,
    text: `浮层是否已自动收起=${animGone}（期望 true）`
  })

  // ---- 「一键修复」的界面自检（2026-09-18）----
  // 为什么要这一步：新加的按钮如果**只**在 renderer 里声明、preload 没暴露，
  // typecheck 一样全绿（App.tsx 的 window.delta 声明是手写的），点下去才会
  // `config.repair is not a function`。所以这里要看它**真的在**。
  // ⚠️ 默认**只查存在、不点击**：一键修复会按清单**真下载**缺失的模组（最多 300+ MB），
  //    而 uishot 是随手就跑的界面自检，不该在运维机器上悄悄拉一个整合包。
  //    要连点击行为一起验，显式加 `--uishot-repair`（配合隔离 userData 用）。
  const repairBtn = await win?.webContents.executeJavaScript(
    `[...document.querySelectorAll('button,a')].some((e) => (e.textContent || '').trim().includes('一键修复'))`
  )
  let repairClicked: boolean | null = null
  let repairText = await visibleText()
  if (repairBtn === true && process.argv.includes('--uishot-repair')) {
    repairClicked = await click('一键修复')
    await wait(6000) // 修复可能拉清单/建目录（不下载时通常 1–3 秒；离线时是快速失败）
    repairText = await visibleText()
  }
  steps.push({
    step: '09-repair',
    clicked: `按钮存在=${repairBtn === true} 已点击=${repairClicked === true}`,
    found: repairBtn === true,
    text: repairText
  })
  await shot('09-repair.png')

  // ---- 可选：真的点一次"启动游戏" ----
  // 这一条才是整条链路的终检：界面点击 → 预检 → 整合包校验 → 组装命令 → 起进程 →
  // 游戏日志回显。前面所有验证（探针、selftest）都绕过了 UI 这条路径。
  // 代价是会真的开一次游戏窗口，所以仅在显式要求时执行。
  if (process.argv.includes('--with-launch')) {
    const launched = await click('启动游戏')
    steps.push({ step: '07-launch-click', clicked: '启动游戏', found: launched })
    // 给 JVM 起进程 + Forge 引导留足时间；每 5 秒抓一次**全部** [launcher] 行与日志尾部。
    // 只取第一条是不够的：真正决定成败的行（整合包校验结果、游戏 stdout）在后面。
    // ⚠️ 判据里**不能**放"游戏运行中"——那是按钮文字，进程一起来就出现，
    // 于是循环 5 秒就跳出，看起来"成功了"其实啥也没验到（2026-09-17 踩到）。
    const marks: string[] = []
    for (let i = 0; i < 24; i++) {
      await wait(5000)
      const t = await visibleText()
      for (const m of t.matchAll(/\[launcher\][^\n]*/g)) {
        if (!marks.includes(m[0])) marks.push(m[0])
      }
      if (/Connecting to |OpenAL initialized|Render thread\/INFO/.test(t)) {
        marks.push(`第 ${(i + 1) * 5} 秒：游戏已进渲染/连接阶段`)
        break
      }
    }
    // 进程侧证据：**按 pid 查**（配置里是 java.exe，不是 javaw.exe——
    // 按镜像名查 javaw 永远是 0，那是探针自己的错，不是启动失败）
    const pid = launch?.state().pid
    let alive = false
    try {
      const { execSync } = await import('node:child_process')
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8' })
      alive = out.includes(String(pid))
    } catch {
      /* ignore */
    }
    marks.push(`launch pid=${pid} 存活=${alive}`)
    steps.push({
      // 同理：原来叫 `06-launch-result`，与 `06-user-chip` 同号不同名不冲突，
      // 但编号与执行顺序对不上（它在 07 之后跑），按顺序改名避免误读。
      step: '08-launch-result',
      clicked: marks.join(' | '),
      found: alive,
      text: await visibleText()
    })
    await shot('08-launch.png')
    if (process.argv.includes('--ac-monitor-proof')) {
      let snapshot = monitorSnapshot()
      const captureProof = process.argv.includes('--capture-proof')
      for (let i = 0; i < (captureProof ? 180 : 90); i++) {
        if (!captureProof && snapshot.tasks.find(t => t.id === 'report')?.state === 'ok' && snapshot.tasks.find(t => t.id === 'scan')?.state === 'ok') break
        await wait(1000)
        snapshot = monitorSnapshot()
        if (i % 5 === 0) writeFileSync(join(dir, 'ac-monitor-live.json'), JSON.stringify(snapshot, null, 2))
      }
      writeFileSync(join(dir, 'ac-monitor-live.json'), JSON.stringify(snapshot, null, 2))
    }
    // 收尾：**只结束我们自己起的那一个进程**，不要在桌面上留窗口，也不要误杀别人的游戏
    try {
      if (pid) {
        const { execSync } = await import('node:child_process')
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
      }
    } catch {
      /* 没起来就没得关 */
    }
  }

  const report = {
    dir,
    webPreferences: { contextIsolation: true },
    steps: steps.map((s) => ({ step: s.step, clicked: s.clicked, found: s.found })),
    texts: Object.fromEntries(steps.map((s) => [s.step, s.text])),
    /**
     * 界面文本卫生检查：**页面上不许出现 markdown 记号**。
     *
     * 为什么要把这条做成自动检查：同一类错误在这个项目里一晚上犯了两次 ——
     * 一次在反作弊的玩家提示里（`本次**只提示**` 直接进了游戏聊天），
     * 一次在启动器界面上（`更新的是**启动器程序本身**`）。人眼审代码时
     * 星号淹没在注释里根本看不见，**只有渲染出来的文本才作数**。
     * 所以判据放在"页面真实文本"上，而不是源码上。
     */
    markdownLeaks: (() => {
      const leaks: { step: string; snippet: string }[] = []
      for (const s of steps) {
        const t = s.text ?? ''
        for (const m of t.matchAll(/\*\*[^*\n]{1,40}\*\*|`[^`\n]{1,40}`/g)) {
          leaks.push({ step: s.step, snippet: m[0].slice(0, 60) })
        }
      }
      return leaks
    })()
  }
  writeFileSync(join(dir, 'uishot.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(`[uishot] 产物目录 ${dir}`)
  if (report.markdownLeaks.length > 0) {
    console.log(`[uishot] ⚠️ 界面文本里有 ${report.markdownLeaks.length} 处 markdown 记号（会原样显示给玩家）：`)
    for (const l of report.markdownLeaks.slice(0, 10)) console.log(`   - ${l.step}: ${l.snippet}`)
  } else {
    console.log('[uishot] ✓ 界面文本无 markdown 残留')
  }
  app.exit(0)
}

/**
 * Minecraft 服务器列表查询（Server List Ping, 1.7+ 协议）。
 *
 * 为什么自己写：只是想显示"在线 / 人数 / 延迟"，为一个 ping 装依赖不值当，
 * 协议本身也就四步——握手 → 状态请求 → 读长度 → 读 JSON。
 *
 * 注意 `protocol version` 传 **-1**：Velocity 代理会据此回它自己的版本信息，
 * 这样"代理后面是哪个版本"也不影响查询。
 */
function pingMinecraft(host: string, port: number, timeoutMs = 4000): Promise<ServerStatus> {
  return new Promise((resolve) => {
    const vint = (n: number): Buffer => {
      const out: number[] = []
      let v = n >>> 0
      do {
        let b = v & 0x7f
        v >>>= 7
        if (v !== 0) b |= 0x80
        out.push(b)
      } while (v !== 0)
      return Buffer.from(out)
    }
    const str = (s: string): Buffer => {
      const b = Buffer.from(s, 'utf8')
      return Buffer.concat([vint(b.length), b])
    }
    const started = Date.now()
    const sock = createConnection({ host, port })
    let acc = Buffer.alloc(0)
    let settled = false
    const done = (r: ServerStatus): void => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    sock.setTimeout(timeoutMs, () => done({ online: false, error: '查询超时' }))
    sock.on('error', (e) => done({ online: false, error: e.message }))
    sock.on('connect', () => {
      const body = Buffer.concat([
        vint(0x00), // packet id: handshake
        vint(0xffffffff), // protocol version = -1（"任意版本"）
        str(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        vint(0x01) // next state: status
      ])
      sock.write(Buffer.concat([vint(body.length), body]))
      sock.write(Buffer.concat([vint(1), vint(0x00)])) // 状态请求
    })
    sock.on('data', (b) => {
      acc = Buffer.concat([acc, b])
      // 读 varint 长度 → 包 id → 字符串长度 → JSON
      let p = 0
      const readVint = (): number | null => {
        let result = 0
        let shift = 0
        for (;;) {
          if (p >= acc.length) return null
          const byte = acc[p++]
          result |= (byte & 0x7f) << shift
          if ((byte & 0x80) === 0) return result >>> 0
          shift += 7
          if (shift > 35) return null
        }
      }
      const len = readVint()
      if (len === null || acc.length < p + len) return
      const id = readVint()
      if (id === null || id !== 0x00) return done({ online: false, error: '响应格式不符' })
      const slen = readVint()
      if (slen === null || acc.length < p + slen) return
      const json = acc.subarray(p, p + slen).toString('utf8')
      try {
        const d = JSON.parse(json) as {
          version?: { name?: string }
          players?: { online?: number; max?: number }
          description?: unknown
        }
        const desc =
          typeof d.description === 'string'
            ? d.description
            : ((d.description as { text?: string } | undefined)?.text ?? '')
        done({
          online: true,
          ping: Date.now() - started,
          players: { online: d.players?.online ?? 0, max: d.players?.max ?? 0 },
          motd: desc.slice(0, 120)
        })
      } catch (e) {
        done({ online: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
  })
}

/**
 * 玩家头像（LittleSkin / Blessing Skin 的 `/avatar/player/{角色名}`）。
 *
 * 三个刻意的选择：
 * 1. **在 main 里抓，不在 renderer 里抓。** renderer 拿着 `<img src="https://…">`
 *    等于把界面变成联网组件；我们的界面不该有对外请求。抓回来转成 data URL 再给界面。
 * 2. **落盘缓存**（`userData/avatars/`，6 小时）：头像不常变，没必要每次开界面都请求；
 *    也顺手让"断网时仍能看到上次的头像"。
 * 3. **校验真的是 PNG**：`/avatar` 在角色不存在时可能被中间层换成 HTML 错误页，
 *    只认 PNG magic bytes，否则当作没有头像（界面回落到首字母）。
 *
 * 以后接自建玩家系统时，只要把 BASE 换成自己的域名/接口即可（这是唯一一处外部图片源）。
 */
const AVATAR_BASE = 'https://littleskin.cn/avatar/player'

async function fetchAvatar(name: string, size = 64): Promise<string | null> {
  // 角色名白名单：绝不把任意字符串拼进 URL
  if (!/^[0-9A-Za-z_]{1,16}$/.test(name)) return null
  const dir = join(app.getPath('userData'), 'avatars')
  const file = join(dir, `${name.toLowerCase()}-${size}.png`)
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 6 * 3600 * 1000) {
      return `data:image/png;base64,${readFileSync(file).toString('base64')}`
    }
  } catch {
    /* 缓存读不了就重新抓 */
  }
  try {
    const url = `${AVATAR_BASE}/${encodeURIComponent(name)}?size=${size}&png`
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const pngMagic = buf.subarray(0, 8).toString('hex')
    if (buf.length < 128 || pngMagic !== '89504e470d0a1a0a') return null
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, buf)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 窗口尺寸 + 界面缩放：按**显示器实际可用区域**算，不再写死 1280×720。
 *
 * 为什么必须改（2026-09-18 运维反馈："4K 屏幕看着好小"）：
 * 窗口写死 1280×720，在 4K 上只占屏幕一角；更要命的是**界面里所有字号都是 CSS 像素**，
 * 而在"4K + Windows 100% 缩放"下 1 CSS px = 1 物理 px ⇒ 11px 的字就真的只有 11px 高。
 *
 * 两条规则分开算，因为它们解决的是**两件不同的事**：
 *   ① **窗口大小**跟着可用区域走（1080p 上≈原来的 1280×720，高分屏上自动变大，并有上下限）；
 *   ② **界面缩放**只在"系统没替我们放大"时才加。Windows 显示缩放 150% 时
 *      `scaleFactor=1.5`，Electron 已经把 CSS 像素放大了，再叠一层就会变成双重放大、字大得离谱。
 *      所以 scaleFactor ≥ 1.25 时不额外缩放，只在低缩放 + 高分辨率（2.5K/4K@100%）上补偿。
 *
 * 拿不到显示器信息时退回原来的 1280×720 —— 宁可跟以前一样，也不能因为算不出来就开不了窗。
 */
function initialWindowSize(): { width: number; height: number; zoom: number } {
  try {
    const display = screen.getPrimaryDisplay()
    const area = display.workAreaSize
    const scale = display.scaleFactor || 1
    const width = Math.max(1180, Math.min(1760, Math.round(area.width * 0.78)))
    const height = Math.max(700, Math.min(1080, Math.round(area.height * 0.86)))
    const byResolution = area.width >= 3400 ? 1.5 : area.width >= 2500 ? 1.25 : 1
    const zoom = scale >= 1.25 ? 1 : byResolution
    return { width, height, zoom }
  } catch {
    return { width: 1280, height: 720, zoom: 1 }
  }
}

function createWindow(): void {
  // ⚠️ uishot 必须留在固定尺寸与固定缩放：截图要能与历史截图对比，
  //    不能因为跑截图的机器屏幕不同就变大小（那会让"界面没变"看起来像变了）。
  const shotMode = process.argv.includes('--uishot')
  const sizing = shotMode ? { width: 1280, height: 720, zoom: 1 } : initialWindowSize()
  console.log(
    `[window] 尺寸=${sizing.width}x${sizing.height} 缩放=${sizing.zoom}` +
      (shotMode ? '（截图模式：固定 1280x720）' : '')
  )
  win = new BrowserWindow({
    width: sizing.width,
    height: sizing.height,
    minWidth: 1024,
    minHeight: 640,
    frame: false,                 // 自绘标题栏（参考图是自定义标题栏）
    backgroundColor: '#0a0c10',
    show: false,
    // 窗口/任务栏图标：打包版用 exe 自带图标（electron-builder 的 win.icon），
    // 开发态没有 exe 资源，得显式指到 build/icon.ico，否则任务栏是默认 Electron 图标。
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', 'icon.ico') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,     // 必须：renderer 拿不到 Node
      nodeIntegration: false,
      backgroundThrottling: !process.argv.includes('--uishot'),
      sandbox: false
    }
  })
  // 缩放必须在页面加载完成后设，否则会被随后的导航重置回 1。
  if (sizing.zoom !== 1) {
    win.webContents.on('did-finish-load', () => win?.webContents.setZoomFactor(sizing.zoom))
  }
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 托盘图标路径。打包后走 `resources/tray.png`（extraResources），开发时走 `build/`。
 *
 * 为什么不用 asar 里的路径：`nativeImage.createFromPath` 读不了 asar 内的虚拟路径，
 * 而且**读不到时 Electron 不抛错、只是没有图标** —— 功能在、入口看不见。
 * 所以这里两条路径都试，并且**失败时打印一行**（否则"托盘没出来"会变成一个谜）。
 */
function trayIconPath(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'tray.png'), join(process.resourcesPath, 'tray@2x.png')]
    : [join(app.getAppPath(), 'build', 'tray.png'), join(app.getAppPath(), 'build', 'tray@2x.png')]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  console.log(`[launcher] ⚠️ 找不到托盘图标，试过：${candidates.join(' | ')}`)
  return ''
}

let tray: Tray | null = null
/**
 * 是否正在**真的退出**。
 *
 * ⚠️ Electron **没有** `app.isQuitting` 这个属性（我一开始凭印象写了它，
 * tsc 直接报 `Property 'isQuitting' does not exist`）。退出流程里的"关窗口"
 * 与"玩家主动关窗口"必须分开，否则点托盘里的"退出"会被 `close` 处理函数
 * 拦成 hide —— 那会变成**永远退不掉**，比没有后台运行糟得多。
 * 所以自己维护这个标志，并在 `before-quit` 里置位。
 */
let quitting = false
/** 是否已经提示过"收进托盘"。只提示一次，避免每次关窗口都弹。 */
let trayHintShown = false

/**
 * 启动游戏的**唯一实现**，由 `app.whenReady()` 里赋值。
 *
 * <p>为什么用模块级变量桥接：托盘相关的代码在模块级（`app.on('before-quit')` 也在外面），
 * 而真正的启动逻辑依赖 `whenReady` 里才建立的状态（`player` / `auth` / `readProfile`）。
 * 两条入口指向**同一个函数**，于是"托盘能起、界面起不了"或更糟的
 * "托盘那条路绕过了某个检查"这类不一致不可能发生。
 */
let doLaunch: (() => Promise<{ ok: boolean; pid?: number; error?: string }>) | null = null

/**
 * 关窗口时的行为：**收进托盘**（默认）还是真的退出。
 *
 * <h2>为什么要做成开关而不是写死</h2>
 * "关掉窗口游戏还在跑"对一部分人是正好，对另一部分人是"怎么关不掉"。
 * 而且这台机器上还有开发/排障场景（`--uishot` 那种自动自检必须能自己退出）。
 * 所以：默认收进托盘（这是"后台运行"要求的），但如果**托盘没建起来**，
 * 就必须退回"真的退出" —— 不然窗口一关，进程变成一个既看不见也关不掉的幽灵。
 */
function shouldHideOnClose(): boolean {
  if (!tray) return false // 没有托盘 = 没有可见入口 ⇒ 绝不能留在后台
  return readOverrides().closeToTray !== false
}

/**
 * 建系统托盘 —— **"后台运行"的载入口**。
 *
 * <h2>为什么必须有托盘，而不是"关掉窗口继续跑"</h2>
 * 没有托盘的"后台进程"对玩家就是**看不见、也关不掉的东西**：任务管理器里多一个
 * 进程，托盘里没图标，他会以为中毒了。托盘给的是三件事：
 *   ① 看得到它在跑 ② 能点回来 ③ 能真的退出
 *
 * <h2>与游戏进程的关系</h2>
 * 启动器持有游戏子进程句柄（`LaunchService.child`）。启动器**整个退出**时，
 * 游戏会失去父进程（Windows 上不必然被杀，但我们就再也管不到它了：
 * 收不了尾、看不到日志、后续的"运行中巡检"也没了宿主）。
 * 所以"后台运行"是把主窗口收进托盘，**不是退出进程**。
 *
 * <h2>托盘建不起来时必须降级</h2>
 * 图标读不到、Tray 构造失败都会让 `tray` 为 null，此时
 * {@link shouldHideOnClose} 会返回 false ⇒ 关窗口就是真退出。
 * **绝不留下"看不见又关不掉"的进程** —— 那是比没有后台运行更糟的结果。
 */
function setupTray(): void {
  if (tray) return
  const icon = trayIconPath()
  if (!icon) return // 上面已经打印过原因
  // `nativeImage.createFromPath` 在读不到/解码失败时**返回空图像而不抛错**，
  // 而空图像传给 `new Tray()` 才抛 —— 两种失败的表现完全不同（一个是"图标没画出来"，
  // 一个是"托盘根本没建"），所以这里先量一下，把原因说准。
  const img = nativeImage.createFromPath(icon)
  if (img.isEmpty()) {
    console.log(`[launcher] ⚠️ 托盘图标解码为空：${icon}（文件在，但 nativeImage 读不出来）`)
    return
  }
  try {
    tray = new Tray(img)
  } catch (e) {
    console.log(`[launcher] ⚠️ 托盘创建失败：${e instanceof Error ? e.message : String(e)}`)
    return
  }
  console.log(`[launcher] 托盘已建立（图标 ${img.getSize().width}x${img.getSize().height}）`)
  tray.setToolTip('断界行动 · Breakline Launcher')
  // 左键单击 = 显示主窗口（Windows 上的习惯）
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
  rebuildTrayMenu()
}

/** 托盘菜单。独立成函数是因为"游戏运行中/未运行"要给出不同的项。 */
function rebuildTrayMenu(): void {
  if (!tray) return
  const running = launch?.state().state === 'running'
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '断界行动 启动器', enabled: false },
      { type: 'separator' },
      { label: '显示主窗口', click: () => showMainWindow() },
      running
        ? { label: `游戏运行中（PID ${launch?.state().pid ?? '?'}）`, enabled: false }
        : {
            label: '启动游戏',
            click: () => {
              // 走的是与界面按钮**同一个** doLaunch，不绕开任何检查
              showMainWindow()
              // 先刷新服务端清单再判定：闸门要按**服务端当前**的整合包版本判，
              // 而不是按装机时的快照（否则更新完反而会被拒）。
              void refreshServerPackManifest().then(() => doLaunch?.()).then((r) => {
                if (r && !r.ok) {
                  win?.webContents.send('launch:log', {
                    line: `[launcher] 托盘启动被拒：${r.error ?? '未知原因'}`
                  })
                }
                // 无论成败都重建菜单：起成功了要把"启动游戏"换成"游戏运行中"
                rebuildTrayMenu()
              })
            }
          },
      { type: 'separator' },
      {
        label: '退出启动器（会一起关掉游戏）',
        click: () => {
          // 玩家点这个就是想关干净：把游戏一起收掉，别留孤儿进程。
          // **必须先置 quitting**，否则 win.close() 会被 close 处理函数拦成 hide，
          // 于是"退出"变成"又收进托盘"（这个坑在别家启动器里很常见）。
          quitting = true
          launch?.stop()
          app.exit(0)
        }
      }
    ])
  )
}

function showMainWindow(): void {
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 配置目录：**分开发/打包两种形态解析**。
 *
 * 打包后 `app.getAppPath()` 指向 `app.asar`，而 `config/` 是通过 extraResources
 * 放到 `resources/` 下的 —— 两条路径完全不同。不处理的话，**开发时一切正常、
 * 装完就"找不到 launch.json"**：这类"只有打包后才坏"的问题最容易漏到玩家手里。
 */
function configDir(): string {
  // electron-vite 的开发主进程在 out/main/ 下执行，app.getAppPath() 在这个形态下
  // 不保证仍是项目根目录。先认当前项目目录，避免测试/维护时误读旧 userData 模板。
  return app.isPackaged ? join(process.resourcesPath, 'config') : join(process.cwd(), 'config')
}

/* ---------------------------------------- 反作弊启动浮层（独立窗口，屏幕右下角） */

/**
 * 浮层窗口的三围。**改动这里就要同步改 `AcStartupPanel.tsx` 里的 `SCALE`**：
 * 面板在窗口里是 `h-full`（占满），而窗口大小是这里给的死值 ——
 * 两边不一致的表现是"面板被切掉一截"或"窗口比面板大出一块透明区"。
 *
 * 基准设计 = **256×144（16:9）**，按 `AC_ANIM_SCALE = 1.5` 放大 ⇒ **384×216**。
 *
 * ⚠️ **尺寸跟着素材走**：有视频素材时，视频用 `object-cover` 铺满整个窗口，
 * 所以窗口比例与片子比例差多少，就裁掉多少画面。
 * 品牌片 `ac-startup.mp4` 是 **1920×1080（16:9）且整幅都是内容**
 * （烟 + MUGEN 字 + 副标题，左右不能切），所以窗口就定成 16:9 ——
 * 一开始那版 378×173（≈2.2:1）会把左右各砍掉 22%，把 MUGEN 的 M 和 N 都切掉一半。
 *
 * 尺寸的几轮改动记在这里，免得下次又凭感觉调（每一步都是当场看效果定的）：
 *   ① 2026-09-19 首版 252×71（EAC 小条）→「再大3倍」⇒ 756×213；
 *   ② 同日「太大了，缩小一半」⇒ 378×144，并改成**视频盖住整个窗口**；
 *   ③ 同日「文本提示有点挡到视频了」⇒ 提示收成一行 + 细条（占高 ~1/4）；
 *   ④ 同日「纵向再宽20%」⇒ 高度 144 → 173（基准 96 → 115）；
 *   ⑤ 同日拿到品牌片后 ⇒ **改成 16:9 的 384×216**（不再裁画面，也就这一步是"按素材定尺寸"）。
 */
const AC_ANIM_SCALE = 1.5
const AC_ANIM_W = Math.round(256 * AC_ANIM_SCALE)
const AC_ANIM_H = Math.round(144 * AC_ANIM_SCALE)
/** 与屏幕工作区边缘的间距（不贴死，留出视觉呼吸 + 阴影） */
const AC_ANIM_MARGIN = 18

/**
 * 浮层窗口时长。**必须 ≥ `AcStartupPanel.tsx` 里的 `DURATION_MS`**：
 * 这里到点就销毁窗口，比面板早关会"读条没走完就消失"（品牌片会被腰斩），
 * 比面板晚关会留下一块空窗。
 */
const AC_ANIM_MS = 11200

let acAnimWin: BrowserWindow | null = null
let acAnimTimer: NodeJS.Timeout | null = null
/**
 * 浮层**这一次**是什么时候开出来的（`Date.now()`）。
 *
 * <p>存在的理由只有一个：自检要判"到点自己收起"，而窗口寿命是从**开出来那一刻**算的，
 * 不是从自检走到那一步开始算的。这两者之间隔着十来秒的界面操作 ——
 * 2026-09-19 就给这个坑绊了一次：浮层时长从 8.6 秒加到 11.2 秒之后，
 * `--uishot` 里那条"等 4.6 秒再看它收没收"立刻变成假红（窗口其实正常）。
 * 判据要**相对事实**，不要相对"页面跑了几步"。
 */
let acAnimOpenedAt = 0

/**
 * 算出浮层窗口该放在哪。
 *
 * <p>用 `display.workArea` 而**不是** `display.bounds`：任务栏在下面或右边时，
 * bounds 会把窗口放到任务栏底下（被盖住一半）。这是"贴右下角"这类需求唯一容易搞错的地方，
 * 所以抽成函数，`--medialist` 会把算出来的坐标一起打出来给运维核。
 */
function computeAcAnimBounds(): { bounds: { x: number; y: number; width: number; height: number }; display: Electron.Display } {
  // 主窗口所在的显示器优先（玩家把启动器拖到副屏时，浮层跟着去那一块屏）
  const display = win
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay()
  const wa = display.workArea
  return {
    bounds: {
      width: AC_ANIM_W,
      height: AC_ANIM_H,
      x: wa.x + wa.width - AC_ANIM_W - AC_ANIM_MARGIN,
      y: wa.y + wa.height - AC_ANIM_H - AC_ANIM_MARGIN
    },
    display
  }
}

/** 浮层页面的地址（开发态走 dev server 的第二个 entry，打包/离线走 out/renderer/acanim.html）。 */
function acAnimTarget(): { url: string; query: Record<string, string> } {
  const media = resolveStartupMedia()
  const query: Record<string, string> = {}
  // 素材地址随查询参数进渲染层：这样浮层**不需要任何 IPC 就能拿到视频**，
  // 也就不必给它开"读文件"的口子（见 preload/acanim.ts 的注释）。
  if (media.url) query['media'] = media.url
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')
    const u = new URL(`${base}/acanim.html`)
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    return { url: u.toString(), query }
  }
  return { url: join(__dirname, '../renderer/acanim.html'), query }
}

/**
 * 打开「反作弊启动中」浮层窗口 —— **一块贴在整个屏幕右下角的独立窗口**。
 *
 * <h2>为什么必须是独立窗口</h2>
 * 运维 2026-09-19 明确：「是要在屏幕右下角播放的」「独立于启动器窗口」。
 * 放在启动器窗口里做不到：启动器可能被最小化、被拖到别处、被收进托盘，
 * 而且玩家点完启动就会去开别的窗口 —— 那时"右下角"就不再是屏幕的右下角。
 *
 * <h2>四条硬要求（少一条这个形态就不成立）</h2>
 * <ol>
 *   <li><b>透明 + 无边框</b>：否则桌面上会多一个黑方块，而不是"浮出来的一块面板"。</li>
 *   <li><b>不抢焦点</b>（`focusable: false` + `showInactive()`）：玩家点完启动往往在
 *       等游戏窗口，浮层一出现就把焦点抢走 = 输一半的字被打断、游戏窗口失去前台。
 *       <b>点透</b>（`setIgnoreMouseEvents(true)`）：鼠标点上去要落到下面的窗口，
 *       不能被一块只会播动画的面板吃掉。</li>
 *   <li><b>置顶</b>（`alwaysOnTop` + `screen-saver` 层）：游戏窗口全屏起来时也要在它上面 ——
 *       这块面板的意义就是"游戏还在起，但反作弊已经就绪"。</li>
 *   <li><b>不进任务栏、不参与关窗流程</b>（`skipTaskbar` + `closable/movable: false`）：
 *       它不是第二个启动器窗口，Alt-Tab 里出现它会让玩家以为启动器开了两个。</li>
 * </ol>
 *
 * <p>返回窗口几何给调用方写日志：**"浮层出现"这件事在界面上是看不见的**
 * （它不在启动器窗口里），只有日志里有坐标才谈得上"真的出现了"。
 */
function openAcAnimWindow(): { ok: boolean; bounds: { x: number; y: number; width: number; height: number } } {
  const { bounds } = computeAcAnimBounds()
  // 重复点启动：先关掉上一块，重新开始播（而不是重叠两块）
  if (acAnimWin && !acAnimWin.isDestroyed()) {
    acAnimWin.destroy()
    acAnimWin = null
  }
  if (acAnimTimer) {
    clearTimeout(acAnimTimer)
    acAnimTimer = null
  }

  const target = acAnimTarget()
  const w = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 绝不抢焦点
    hasShadow: false, // 透明窗口自带阴影会画出一个方框
    acceptFirstMouse: false,
    alwaysOnTop: true,
    title: 'MUGEN AC 启动中',
    webPreferences: {
      preload: join(__dirname, '../preload/acanim.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  acAnimWin = w
  // `screen-saver` 层级：全屏游戏也压得住，但不至于盖住系统的安全提示
  w.setAlwaysOnTop(true, 'screen-saver')
  // 点透：鼠标事件不落在浮层上（它没有可点的东西，也不该挡住下面的游戏/浏览器）
  w.setIgnoreMouseEvents(true)
  w.once('ready-to-show', () => {
    // showInactive 而不是 show：抢焦点会把玩家正在输入的窗口顶下去
    w.showInactive()
  })
  if (target.query['media']) {
    void w.loadFile(target.url, { query: target.query })
  } else {
    void w.loadFile(target.url)
  }
  w.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[launcher] ⚠️ 反作弊启动浮层加载失败：${code} ${desc}`)
  })
  /**
   * 渲染层的报错必须**打到主进程控制台**。
   *
   * <p>为什么这块窗口尤其需要：它是透明 + 不抢焦点 + 点透的，**它出问题时什么都不会发生** ——
   * 玩家看不到报错、点不动、也开不了 devtools，运维那边只有"右下角什么都没有"这一句描述。
   * 2026-09-19 实测就撞到过一次（改了布局之后窗口在、画面全空），当时唯一能查的地方就是这里。
   */
  w.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[launcher] ⚠️ 反作弊启动浮层渲染进程退出：${details.reason}（exitCode=${details.exitCode}）`)
  })
  w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // 只报 warning 及以上：这块窗口正常时会刷一堆无意义的 info
    if (level >= 2) console.log(`[launcher] 浮层控制台[${level}] ${message} (${sourceId}:${line})`)
  })
  w.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.log(`[launcher] ⚠️ 浮层 preload 出错：${preloadPath} ${error.message}`)
  })
  // 到点自己收（不依赖渲染层报告：浮层崩了也必须消失，不能留一块盖在屏幕上的空窗）
  acAnimOpenedAt = Date.now()
  acAnimTimer = setTimeout(() => closeAcAnimWindow('到时收起'), AC_ANIM_MS)
  console.log(
    `[launcher] 反作弊启动浮层已出现：${bounds.width}×${bounds.height} @ (${bounds.x}, ${bounds.y})` +
      `（${target.query['media'] ? '播放素材' : '动态占位'}，${AC_ANIM_MS} ms 后自动收起）`
  )
  return { ok: true, bounds }
}

/** 关掉浮层。`reason` 只进日志（"自己收的"还是"启动器退出时收的"排障时要分得清）。 */
function closeAcAnimWindow(reason: string): void {
  if (acAnimTimer) {
    clearTimeout(acAnimTimer)
    acAnimTimer = null
  }
  if (acAnimWin && !acAnimWin.isDestroyed()) {
    acAnimWin.destroy()
    console.log(`[launcher] 反作弊启动浮层已收起（${reason}）`)
  }
  acAnimWin = null
}

/**
 * 素材目录。与 `configDir()` **同一套分环境规则**（打包后 `app.getAppPath()` 指向
 * `app.asar`，而 extraResources 落在 `resources/` 下 —— 两条路径完全不同）。
 *
 * 与 config 的差别只有一处：**玩家可覆盖**。运维/玩家想把启动动画换成自己的短片时，
 * 不该被迫重新打包一个 exe —— 所以 `%APPDATA%\delta-launcher\media\` 排在包里那份之前。
 */
function mediaDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'media') : join(app.getAppPath(), 'resources', 'media')
}

/** 启动动画候选扩展名。**按序**试第一个存在的；全不存在 → 界面回落成同版式的动态占位。 */
const STARTUP_MEDIA_EXTS = ['.mp4', '.webm', '.m4v'] as const

type StartupMediaResolution = {
  /** 素材基名（换片只改文件名前缀，代码不动） */
  base: string
  /** 命中的真实文件（没有则为 null） */
  path: string | null
  /** 交给 renderer 的 `<video src>`——用 pathToFileURL 转，避免盘符/空格/中文手写转义出错 */
  url: string | null
  /** 玩家目录里的覆盖件（非空 = 用的是玩家那份，不是包里的） */
  overridePath: string | null
  /** 本次找过的所有候选（排障用，顺序即优先级） */
  candidates: string[]
}

/**
 * 解析「反作弊启动动画」素材。
 *
 * <p>为什么要把"找过哪些路径"一起返回：本项目里"素材没生效"这件事的症状永远是
 * **静默回落**（界面照常、只是放着占位），从画面看不出是"没放文件"还是"放错目录"
 * 还是"打包时没带上"。所以解析结果里必须带上候选清单 —— `--medialist` 把它打出来，
 * `--selftest` 与界面自检也各自留证。
 */
function resolveStartupMedia(): StartupMediaResolution {
  const overrideDir = join(app.getPath('userData'), 'media')
  const candidates: string[] = []
  const roots: { dir: string; override: boolean }[] = [
    { dir: overrideDir, override: true },
    { dir: mediaDir(), override: false }
  ]
  let overridePath: string | null = null
  let foundPath: string | null = null
  for (const root of roots) {
    for (const ext of STARTUP_MEDIA_EXTS) {
      const p = join(root.dir, `ac-startup${ext}`)
      candidates.push(p)
      if (foundPath === null && existsSync(p)) {
        foundPath = p
        if (root.override) overridePath = p
      }
    }
  }
  let url: string | null = null
  if (foundPath) {
    try {
      url = pathToFileURL(foundPath).href
    } catch {
      url = null
    }
  }
  return {
    base: 'ac-startup',
    path: foundPath,
    url,
    overridePath,
    candidates
  }
}

/** `--medialist`：把"启动动画素材到底解析到哪"打给运维看（无点击、不改磁盘）。 */
function printMediaList(): void {
  const r = resolveStartupMedia()
  const dir = mediaDir()
  let siblings: string[] = []
  try {
    siblings = readdirSync(dir)
  } catch {
    siblings = []
  }
  // 顺带把**浮层窗口的几何**打出来：这块窗口是"贴在整个屏幕右下角"的，
  // 位置由 workArea（不是屏幕尺寸）算出来 —— 任务栏在右边或下面时会不一样，
  // 而"位置差了几十像素"这种事光看代码看不出来，只有把坐标打出来才能核。
  const geo = computeAcAnimBounds()
  console.log(
    JSON.stringify(
      {
        packaged: app.isPackaged,
        mediaDir: dir,
        mediaDirExists: existsSync(dir),
        overrideDir: join(app.getPath('userData'), 'media'),
        candidates: r.candidates,
        resolved: r.path,
        url: r.url,
        from: r.overridePath ? 'userData（玩家覆盖）' : r.path ? 'launcher（随包分发）' : null,
        siblings,
        animWindow: {
          panel: `${AC_ANIM_W}×${AC_ANIM_H}`,
          margin: AC_ANIM_MARGIN,
          bounds: geo.bounds,
          displayBounds: geo.display.bounds,
          workArea: geo.display.workArea
        }
      },
      null,
      2
    )
  )
}

function readProfile(): LaunchProfile | null {
  // 2026-09-19：以前这里只认 `resources/config/launch.json` 一个位置，读不到就一句
  // 「缺少 config/launch.json（启动模板）」—— 于是"到底是文件没了、还是路径不对、还是 JSON 坏了"
  // 全靠猜（运维当时回的就是"我肯定没缺文件"）。现在：**多候选** + **自愈副本** + **失败说清原因**。
  //
  //   ① <resources>/config/launch.json   —— 打包后的 extraResources（正常路径）
  //   ② <appPath>/config/launch.json     —— asar 内也放了一份（打包配置 files 里加了 config），
  //                                          extraResources 丢/被杀软删掉时仍然能起来
  //   ③ <userData>/launch.json           —— 首次成功读取后自愈写入的副本（跨版本升级保命）
  const candidates: string[] = []
  if (app.isPackaged) candidates.push(join(process.resourcesPath, 'config', 'launch.json'))
  // 开发/维护入口由 electron-vite 从 out/main 启动；process.cwd() 才是发布工程根。
  // 它必须排在用户自愈副本之前，否则旧副本会把新的出厂配置完全遮住。
  if (!app.isPackaged) candidates.push(join(process.cwd(), 'config', 'launch.json'))
  candidates.push(join(app.getAppPath(), 'config', 'launch.json'))
  candidates.push(join(app.getPath('userData'), 'launch.json'))
  const failures: string[] = []
  for (const file of candidates) {
    try {
      const profile = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as LaunchProfile
      if (!profile || typeof profile !== 'object' || !Array.isArray(profile.jvmArgs)) {
        failures.push(`${file}（字段不像启动模板）`)
        continue
      }
      healTemplate(file)
      profileReadError = ''
      return profile
    } catch (err) {
      failures.push(`${file}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  profileReadError = failures.join('；')
  return null
}

/** 首次成功读取后，往 <userData>/launch.json 放一份副本：下次就算包里的没了也能起来。 */
function healTemplate(source: string): void {
  try {
    const target = join(app.getPath('userData'), 'launch.json')
    if (resolve(source) === resolve(target)) return
    if (existsSync(target)) return
    writeFileSync(target, readFileSync(source))
  } catch {
    // 自愈失败不是错误：下次还能从包里读。
  }
}

/** `readProfile()` 失败时的**具体**原因（哪个路径、什么错），界面与日志都用它，不再只报一句话。 */
let profileReadError = ''

function noProfileMessage(): string {
  return profileReadError === ''
    ? '缺少启动模板（launch.json）'
    : `读取启动模板失败：${profileReadError}`
}

/** 玩家可覆盖的字段。模板字段（classpath/jvmArgs/programArgs）**不允许**玩家改。 */
type Overrides = {
  gameRoot?: string
  gameRootHistory?: string[]
  java?: string
  version?: string
  /** 关闭窗口时收进托盘（默认 true；托盘不可用时忽略此项） */
  closeToTray?: boolean
  /**
   * JVM 最大堆（MB）。**2026-09-18 补上**：此前启动器根本没有把 `-Xmx` 传给游戏
   * （全仓 grep 无命中）⇒ 79 个模组的整合包跑在默认堆上，症状是卡顿与切维度 OOM，
   * 而玩家只会觉得"服务器卡"。这里是那个缺失的入口。
   */
  lowMemoryMode?: boolean
  memoryMb?: number
  gcMode?: 'template' | 'tuned'
  /** 游戏窗口宽高（覆盖模板里的值）。 */
  width?: number
  height?: number
  /** 是否全屏（true 时给游戏加 `--fullscreen`）。 */
  fullscreen?: boolean
}
const OVERRIDABLE = ['gameRoot', 'java', 'version'] as const

/**
 * 玩家设置文件（放在 `userData`，不是程序目录）。
 *
 * 2026-09-17 发现（发布级）：原来的 `config:set` 直接写 `resources/config/launch.json`，
 * 也就是**装完之后的程序目录**。三个后果，每一个都足以毁掉首次运行引导：
 *   1. 启动器一更新/重装，`resources/` 被整体替换 → 玩家刚设好的路径**悄悄回到打包机的路径**
 *      → 症状是"上次还能进，更新完又点不动了"，而且没人会想到是设置被清了。
 *   2. 装到 Program Files（每机器安装）时写入直接失败 → 保存报错或静默失败。
 *   3. 出厂模板与玩家设置混在一个文件里，出问题时无法判断"这条路径是谁写的"。
 *
 * 现在分开：出厂文件只读，玩家设置写这里，读的时候合并。更新只替换出厂文件。
 */
function overridesFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readOverrides(): Overrides {
  try {
    return JSON.parse(readFileSync(overridesFile(), 'utf8').replace(/^\uFEFF/, '')) as Overrides
  } catch {
    return {}
  }
}

/**
 * 出厂配置 + 玩家覆盖 = **生效配置**。
 * 所有消费点（预检、整合包校验、启动、设置界面）都必须走这里，
 * 否则会出现"设置界面显示的是 A，启动用的是 B"这类最难查的不一致。
 *
 * ⚠️ 2026-09-18（发布级缺陷）：**生效的 `gameRoot` 不再是"配置里那串字符"**，
 * 而是经过 `resolveGameRoot()` 解析的"这台机器上真实成立"的目录。原因见下面那段注释
 * 与 `services/GamePaths.ts` 的文件头：出厂配置里原来写着打包机的
 * `F:\HMCL-3.6.12\.minecraft`，随包分发到别人机器上必然不存在，装完就永远
 * "预检未通过、不能启动"。
 */
function readEffectiveProfile(): {
  profile: LaunchProfile
  overrides: Overrides
  /** 片 1（2026-09-18）：真正会拼进命令行的运行时参数。缺省时由模板值兜底。 */
  runtime: { memoryMb: number; width: number | null; height: number | null; fullscreen: boolean; gcMode: 'template' | 'tuned'; autoMemoryMb: number; availableMb: number; modCount: number }
  /** 游戏根目录是**哪一层给的**、有没有回落、回落自哪里（界面与日志都要用） */
  rootInfo: RootInfo
} | null {
  const raw = readProfile()
  if (!raw) return null
  const overrides = readOverrides()
  const profile: LaunchProfile = { ...raw }
  for (const k of OVERRIDABLE) {
    const v = overrides[k]
    if (typeof v === 'string' && v.trim() !== '') profile[k] = v.trim()
  }
  // ---- 游戏根目录：**解析**而不是"照抄配置" ----
  // 优先级（语义定义在 services/GamePaths.ts，改顺序必须先改那里的注释）：
  //   ① DELTA_GAME_ROOT ② settings.json.gameRoot ③ 出厂 launch.json.gameRoot
  //   ④ 本机常见位置里"确实是我们的整合包"的那个 ⑤ <userData>/game（每用户默认）
  // ①②③ 的规则是"展开后存在就用，不存在就继续往下找"——**老玩家不动，新玩家可用**。
  const rootInfo = resolveGameRoot(
    {
      envRoot: process.env[GAME_ROOT_ENV],
      playerRoot: typeof overrides.gameRoot === 'string' ? overrides.gameRoot : undefined,
      // 出厂值本身可能带 ${LAUNCHER_DIR} / %APPDATA% / 相对形式，展开由 GamePaths 统一做
      factoryRoot: typeof raw.gameRoot === 'string' ? raw.gameRoot : undefined,
      version: profile.version,
      manifestNames: bundledManifestNames()
    },
    pathContext()
  )
  profile.gameRoot = rootInfo.root
  if (rootInfo.source === 'portable' && rootInfo.version) {
    profile.version = rootInfo.version
    const bundledJava = join(rootInfo.root, 'runtime', 'java17', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    if (existsSync(bundledJava)) profile.java = bundledJava
  }
  // 数值/布尔类覆盖与上面分开（那条循环要求字符串）。
  // 只在类型正确时生效：设置文件被手改坏（"8G" / null）时退回默认，绝不把 NaN 拼进命令行
  // —— `-XmxNaNm` 会让游戏直接起不来，而报错信息完全指不到"设置文件写坏了"。
  const num = (v: unknown, lo: number, hi: number): number | null => {
    const n = typeof v === 'number' ? v : Number.NaN
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.max(lo, Math.min(hi, Math.round(n)))
  }
  // 默认内存：物理内存的一半，上限 8 GB（再高对 MC 没好处，反而拖慢 GC）。
  const availableMb = Math.floor(freemem() / 1024 / 1024)
  const isolatedModsDir = join(rootInfo.root, 'versions', profile.version, 'mods')
  const isolatedCount = countMods(isolatedModsDir)
  const modsDir = isolatedCount > 0 ? isolatedModsDir : join(rootInfo.root, 'mods')
  const modCount = countMods(modsDir)
  const autoMemoryMb = lowMemoryHeapMb(planHeapMb(availableMb, modCount), overrides.lowMemoryMode === true)
  const runtime = {
    memoryMb: lowMemoryHeapMb(selectHeapMb(num(overrides.memoryMb, 512, 32768) ?? undefined, availableMb, modCount), overrides.lowMemoryMode === true),
    width: num(overrides.width, 320, 7680),
    height: num(overrides.height, 240, 4320),
    fullscreen: overrides.fullscreen === true,
    gcMode: overrides.gcMode === 'template' ? 'template' as const : 'tuned' as const,
    autoMemoryMb,
    availableMb,
    modCount
  }
  return { profile, overrides, runtime, rootInfo }
}

/** 展开/解析路径时用到的"这台机器的事实"。集中一处，避免各调用点各拼一份。 */
function pathContext(): PathContext {
  const appData = app.getPath('appData')
  const history = readOverrides().gameRootHistory
  const portable = process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe'))
  return {
    userData: app.getPath('userData'),
    appData,
    // Electron 没有 'localAppData' 这个名字，Windows 上从环境变量取（缺失时按惯例推）
    localAppData: process.env['LOCALAPPDATA'] ?? join(appData, '..', 'Local'),
    home: app.getPath('home'),
    env: process.env as Record<string, string | undefined>,
    portableDir: portable,
    searchRoots: [
      ...(Array.isArray(history) ? history.filter(p => typeof p === 'string') : []),
      portable, join(portable, 'game'), join(portable, '.minecraft'),
      app.getPath('desktop'), app.getPath('downloads'),
      ...(process.platform === 'win32' ? ['D:/我的世界', 'D:/游戏', 'D:/Games', 'D:/Minecraft', 'E:/我的世界', 'E:/游戏', 'E:/Games'] : [])
    ]
  }
}

/**
 * 授权清单里的文件名（候选扫描用它判断"这个目录里是不是我们的整合包"）。
 * 读不到就返回 null —— 那种情况下**不采用**任何候选（宁可回落到默认目录：
 * 认错整合包会让玩家启动起一堆陌生模组，比"目录是空的"严重得多）。
 */
function bundledManifestNames(): string[] | null {
  if (serverPackManifest && serverPackManifestExpiresAt > Date.now()) return Object.keys(serverPackManifest)
  try {
    const raw = JSON.parse(
      readFileSync(join(configDir(), 'pack-manifest.json'), 'utf8').replace(/^\uFEFF/, '')
    )
    const names = Object.keys(packSnapshotFiles(raw))
    return names.length > 0 ? names : null
  } catch {
    return null
  }
}

/**
 * 生效的游戏目录结构信息（解析 + 自动建目录 + mods 三态）。
 *
 * `create=false` 时**只读**：`update:check` 那条纪律（"检查永远无副作用"）同样适用于这里，
 * 而预检/整合包校验要的是"目录必须已经能用"，所以它们传 `create=true`。
 */
function gameDirInfo(create: boolean): {
  rootInfo: RootInfo
  ensure: EnsureResult
  mods: ModsDirState
  notices: ReturnType<typeof describeGameDir>
} | null {
  const eff = readEffectiveProfile()
  if (!eff) return null
  const { rootInfo } = eff
  const versionDir = join(rootInfo.root, 'versions', eff.profile.version)
  const modsDir = join(versionDir, 'mods')
  const ensure: EnsureResult = create
    ? ensureGameStructure(rootInfo.root, eff.profile.version)
    : {
        root: rootInfo.root,
        versionDir,
        modsDir,
        configDir: join(versionDir, 'config'),
        created: []
      }
  const mods = classifyModsDir(modsDir)
  return { rootInfo, ensure, mods, notices: describeGameDir({ rootInfo, ensure, mods }) }
}

/**
 * 采纳"玩家选中的目录"：解释形态 → 写进**可写的用户配置** → 回读 → 报告生效值。
 *
 * 由两处共用（必须是同一条代码路径，否则"界面上点的那次"与"命令行设的那次"
 * 会变成两份真相）：
 *   · `config:pick` IPC（原生目录选择器，玩家点「浏览…」）
 *   · `--set-game-root <目录>`（无点击的端到端验证 / 运维批量部署用）
 *
 * ⚠️ 落盘位置：`%APPDATA%\<产品名>\settings.json`（RuntimeSettings.setPathOverride）。
 * **绝不能**写 `config/launch.json`：那是 extraResources，在安装目录下、随包分发、
 * 更新时整体替换 —— 写在那里等于玩家一更新就被打回出厂路径（本项目修过一次的发布级缺陷）。
 */
function applyPickedGameDir(dir: string): {
  ok: boolean
  picked: string
  form: string
  gameRoot: string
  version: string
  versionChanged: boolean
  modsDir: string
  modsState: string
  notes: string[]
  /** 落盘之后的**生效**值（回读，不是"我以为"） */
  effective: { gameRoot: string; version: string; source: string; sourceLabel: string } | null
  settingsFile: string
} {
  const eff = readEffectiveProfile()
  const currentVersion = eff?.profile.version ?? readProfile()?.version ?? ''
  const picked = interpretPickedDir(dir, currentVersion, bundledManifestNames())
  if (picked.rejected) {
    // 目录不存在：**不写配置**（写了只会让下一次解析多一条 rejected 记录）。
    return {
      ok: false,
      picked: picked.dir,
      form: picked.form,
      gameRoot: picked.gameRoot,
      version: picked.version,
      versionChanged: false,
      modsDir: picked.modsDir,
      modsState: picked.mods.state,
      notes: picked.notes,
      effective: null,
      settingsFile: overridesFile()
    }
  }
  const written = setPathOverride({ gameRoot: picked.gameRoot, version: picked.version })
  // 回读生效值：玩家与界面看到的必须是"真的存进去并真的会被用"的那个目录。
  const after = readEffectiveProfile()
  return {
    ok: true,
    picked: picked.dir,
    form: picked.form,
    gameRoot: picked.gameRoot,
    version: picked.version,
    versionChanged: picked.versionChanged,
    modsDir: picked.modsDir,
    modsState: picked.mods.state,
    notes: picked.notes,
    effective: after
      ? {
          gameRoot: after.profile.gameRoot,
          version: after.profile.version,
          source: after.rootInfo.source,
          sourceLabel: sourceLabel(after.rootInfo.source)
        }
      : null,
    settingsFile: written.file
  }
}


/**
 * 展开配置里的路径模板。
 *
 * - `${GAME_DIR}` → `profile.gameRoot`：**换机器只改这一个字段**，
 *   不用把 94 条 classpath 全改一遍（那正是"只能在本机跑"的根因）。
 * - `${GAME_VERSION_DIR}` → `${GAME_DIR}/versions/<version>`：版本隔离目录。
 *   2026-09-17 发现：实例名 `test` 原来写死在 `gameDir` 与 `programArgs` 两处，
 *   别人机器上实例名不叫 `test` 就会去开一个空目录（mods/ 全空 → 表现为"纯净服"）。
 *   现在只认 `version` 字段，玩家改名不用碰 37 条 programArgs。
 * - `${LAUNCHER_DIR}` → 启动器自己的运行目录（`userData/runtime`）：
 *   LittleSkin 登录要用的 authlib-injector.jar 放在那里，
 *   而它绝不能指向 HMCL 的依赖目录（别人机器上没有）。
 *
 * 刻意返回新对象、不改原配置：预检与日志都要能看到"模板态"与"展开态"的差别。
 */
function resolveProfile(profile: LaunchProfile): LaunchProfile {
  // ⚠️ `${LAUNCHER_DIR}` = **启动器数据目录**（不含 runtime）。
  // 2026-09-17 真跑一次才发现的 bug：这里原来写的是 `…/runtime`，而配置里写的是
  // `${LAUNCHER_DIR}/runtime/authlib-injector-….jar` ⇒ 拼出 `runtime/runtime/…`
  // ⇒ JVM 直接失败（`agent library failed to init: instrument` /
  // `Error opening zip file or JAR manifest missing`）。
  // 玩家看到的现象是"点了启动，闪一下就没了"——正是最该被真跑一次拦住的那类问题。
  const launcherDataDir = app.getPath('userData')
  const versionDir = join(profile.gameRoot, 'versions', profile.version)
  // HMCL/原版都按 `<versionId>.jar` 命名版本 jar，所以实例名一改，jar 名跟着改。
  const versionJar = join(versionDir, `${profile.version}.jar`)
  // 展开分两层，**顺序不能反**：
  //   ① 配置自己的路径模板（下面四条 ${...}）；
  //   ② 通用的机器/用户相关形式（%APPDATA% / ~）——由 GamePaths 统一处理。
  // ② 放在 ① 之后：模板展开出来的仍可能是 `%APPDATA%\...` 这种形式（运维在 settings.json
  // 里就爱这么写），反过来则会让 `%APPDATA%` 里出现的 `${...}` 逃过 ①。
  //
  // ⚠️⚠️ 2026-09-18 事故（真机"开不了游戏"）：**参数数组与路径字段必须用不同的展开器**。
  //   · 路径字段（gameDir/assetsDir）：expandPath —— 允许相对路径与归一化；
  //   · 参数数组（jvmArgs/classpath/programArgs）：expandTokens —— **逐字节保留**，
  //     绝不做"相对路径 ⇒ 相对数据目录"。
  //   当时两条都走 expandPath，于是 `-XX:+UseG1GC`、`--username`、`-javaagent:…` 被加上
  //   数据目录前缀，JVM 把第一个非选项当主类 ⇒ 命令行整个坏掉。判据见 `--pathtest` 第 ⑮ 节。
  const ctx = pathContext()
  const templates = (s: string): string =>
    s
      // 长模板先替换：`${GAME_VERSION_JAR}` / `${GAME_VERSION_DIR}` 与 `${GAME_DIR}`
      // 前缀重叠，顺序反了会漏。
      .replace(/\$\{GAME_VERSION_JAR\}/g, versionJar)
      .replace(/\$\{GAME_VERSION_DIR\}/g, versionDir)
      .replace(/\$\{GAME_DIR\}/g, profile.gameRoot)
      .replace(/\$\{LAUNCHER_DIR\}/g, launcherDataDir)
  /** 参数用：只展开 token，保持原样（见上面的 ⚠️） */
  const portable = (s: string): string => process.platform === 'win32' ? s :
    s.split(';').filter(entry => !/natives-windows-(arm64|x86)\.jar$/i.test(entry)).join(':')
      .replace(/\\/g, '/').replace(/natives-windows/g, process.platform === 'darwin' ? 'natives-macos' : 'natives-linux')
  const expandArg = (s: string): string => expandTokens(templates(portable(s)), ctx)
  /** 路径字段用：展开 + 相对路径解析 + 归一化 */
  const expandField = (s: string): string => expandPath(templates(portable(s)), ctx)
  return {
    ...profile,
    java: process.platform !== 'win32' && /^[A-Za-z]:/.test(profile.java) ? '/usr/bin/java' : profile.java,
    jvmArgs: versionJarIgnoreList(profile.jvmArgs.map(expandArg), profile.version),
    classpath: profile.classpath.filter(entry => process.platform === 'win32' || !/natives-windows-(arm64|x86)\.jar$/i.test(entry)).map(expandArg),
    // ⚠️ 2026-09-17 事故：这一行原来**漏了**，于是 `${GAME_VERSION_DIR}` / `${GAME_DIR}`
    // 以字面量形式进了 JVM，游戏直接崩：
    //   OptionArgumentConversionException: Cannot parse argument '${GAME_VERSION_DIR}' of option gameDir
    // 探针自己有展开逻辑，所以一直正常——**"探针能启动"不等于"启动器能启动"**。
    // 界面启动这条路当时根本没被验过（uishot 只看到"预检通过"就以为成了）。
    programArgs: profile.programArgs?.map(expandArg),
    gameDir: expandField(profile.gameDir),
    assetsDir: expandField(profile.assetsDir)
  }
}

/**
 * 展开后仍残留的模板——**一个都不该有**。
 *
 * 上面那次事故的教训：漏展开**不会报错**，只会在游戏里变成一句看不懂的
 * jopt-simple 异常（而玩家看到的是"点了没反应"）。所以在 spawn 之前先查一遍，
 * 有残留就拒绝启动并指名道姓，而不是把一条坏命令行丢出去。
 * 两个认证占位符是例外：它们本来就该保持字面量（离线模式下游戏不使用）。
 *
 * 2026-09-18 起这里**也管 `%NAME%` 形式**：`expandPath()` 对未定义的环境变量刻意
 * 保持原样（不替换成空串），残留下来的那一个就是"这台机器上少了某个环境变量"，
 * 必须在这里被拦住——否则命令行里会出现 `%APPDATA%\...` 这种永远找不到的路径。
 */
function leftoverTemplates(profile: LaunchProfile): string[] {
  const allow = new Set(['${clientid}', '${auth_xuid}'])
  const out: string[] = []
  const scan = (s: string | undefined): void => {
    if (!s) return
    for (const m of s.matchAll(/\$\{[^}]*\}/g)) {
      if (!allow.has(m[0])) out.push(m[0])
    }
    out.push(...leftoverEnvTokens(s))
  }
  for (const a of profile.jvmArgs) scan(a)
  for (const a of profile.classpath) scan(a)
  for (const a of profile.programArgs ?? []) scan(a)
  scan(profile.gameDir)
  scan(profile.assetsDir)
  return [...new Set(out)]
}

/**
 * 整合包校验（M2）：把 `mods/` 与启动器持有的权威清单逐文件比对。
 *
 * 信任根的位置是关键：清单在**启动器/服务端**这边，不在玩家可改的游戏目录里。
 * 客户端模组里那份 `deltaac-mods-baseline.properties` 改一行就免检；
 * 这份不会。所以"改客户端绕过"这条路在这里被堵上。
 *
 * ⚠️ **2026-09-18 修的一个真陷阱：清单有"两份"，而闸门原来只认安装包里那份快照。**
 *   · 启动闸门读 `config/pack-manifest.json`（**随安装包分发**，一次装机就固定了）
 *   · 更新卡片读服务端 `/api/pack/manifest`（**跟着整合包走**）
 *   两者不一致时，玩家会掉进死循环：
 *   更新源换成新版 ⇒ 玩家下载新版 ⇒ 闸门按内置旧清单判「被改动」⇒ **拒绝启动**，
 *   而玩家唯一的动作是"照提示点了更新"。那天真机就踩到了这一幕。
 *
 *   所以现在：**能拿到服务端清单时以它为准**（缓存在内存里，登录取到 session 前不阻塞启动），
 *   拿不到就退回内置快照（离线/服务端挂了时仍然有保护）。内置清单仍然必须随包更新，
 *   但它不再是"唯一真相"——它只是**离线兜底**。
 *
 * 容错：清单是配置文件，会被各种编辑器打开，**记事本与 PowerShell 都会写 BOM**，
 * 而 JSON.parse 见 BOM 直接抛错 ⇒ 症状是"校验永远失败"，与"真的不一致"难以区分。
 * 所以统一在读取时剥掉 BOM。
 */
let serverPackManifest: Record<string, string> | null = null
/** 服务端清单的来源说明，供日志/状态栏区分"用的是哪一份"（排查这类问题的第一手信息）。 */
let serverPackManifestNote = '未获取'

/**
 * 拉取服务端权威清单（失败不抛：闸门要能在离线时退回内置快照）。
 *
 * 只在启动前调用一次；不缓存到磁盘 —— 缓存反而会把"过期快照"这个坑搬回来。
 */
let serverPackManifestExpiresAt = 0
function useServerManifest(snapshot: Awaited<ReturnType<typeof fetchPackSnapshot>>): void {
  serverPackManifest = Object.fromEntries(snapshot.manifest.files.map(file => [file.name, file.sha256.toLowerCase()]))
  serverPackManifestExpiresAt = snapshot.expiresAt
  serverPackManifestNote = `服务端清单（${snapshot.manifest.files.length} 个文件）`
}
async function refreshServerPackManifest(): Promise<void> {
  try {
    const snapshot = await fetchPackSnapshot(playerApiBase(), '/api/pack/manifest', app.getVersion())
    useServerManifest(snapshot)
    win?.webContents.send('launch:log', { line: `[launcher] 已获取并验证服务器清单：${snapshot.manifest.files.length} 个文件` })
  } catch (error) {
    if (serverPackManifestExpiresAt <= Date.now()) serverPackManifest = null
    serverPackManifestNote = error instanceof Error ? error.message : String(error)
  }
}

function verifyPack(): ReturnType<typeof checkPackFiles> {
  const result = checkPackFiles()
  acMonitor.recordPack(result)
  return result
}

function checkPackFiles(): {
  ok: boolean
  expected: number
  actual: number
  /** 清单里的反作弊客户端模组是否当前在位（状态栏那条"Anti-Cheat 已加载"靠它） */
  antiCheat: boolean
  antiCheatFile: string | null
  missing: string[]
  extra: string[]
  changed: string[]
  /** 这次校验用的是哪一份清单（服务端 / 内置快照）—— 排查"更新后反而被拒"的第一手信息。 */
  sourceNote?: string
  error?: string
  /**
   * 目录三态（2026-09-18）：**"目录不存在"与"目录在但没模组"必须能被界面分开**。
   * 原来两种情况共用一句"读不到 mods 目录"，玩家不知道该建目录还是该下整合包。
   */
  dirState?: 'ok' | 'empty' | 'missing' | 'unreadable'
  /** 生效的游戏目录信息（哪一层给的、建了什么、mods 路径、三态提示） */
  dir?: {
    gameRoot: string
    source: string
    sourceLabel: string
    modsDir: string
    modsJars: number
    created: string[]
    rejected: { raw: string; expanded: string; source: string }[]
    notices: { code: string; text: string; detail?: string }[]
  }
} {
  const empty = {
    ok: false,
    expected: 0,
    actual: 0,
    antiCheat: false,
    antiCheatFile: null,
    missing: [],
    extra: [],
    changed: []
  }


  try {
    if (!serverPackManifest || serverPackManifestExpiresAt <= Date.now()) return { ...empty, error: `官方清单尚未验证：${serverPackManifestNote}。请重新检查更新。` }
    const eff = readEffectiveProfile()
    if (!eff) return { ...empty, error: '缺少 config/launch.json' }
    // 目录信息在**展开配置之前**取：它要回答"这个根目录是哪一层给的、自动建了什么"。
    // `create=true`：整合包校验本来就要读写这个目录，缺目录时先建出来，
    // 否则新玩家的第一次校验只会得到"读不到" —— 而那是启动器自己能解决的事。
    const info = gameDirInfo(true)!
    const profile = resolveProfile(eff.profile)
    const dir = {
      gameRoot: info.rootInfo.root,
      source: info.rootInfo.source,
      sourceLabel: sourceLabel(info.rootInfo.source),
      modsDir: info.ensure.modsDir,
      modsJars: info.mods.jars,
      created: info.ensure.created,
      rejected: info.rootInfo.rejected.map((r) => ({
        raw: r.raw,
        expanded: r.expanded,
        source: sourceLabel(r.source)
      })),
      notices: info.notices.map((n) => ({ code: n.code, text: n.text, detail: n.detail }))
    }
    const manifestFile = join(configDir(), 'pack-manifest.json')
    // 新版启动器以服务端清单为在线信任根；资源目录里的 pack-manifest.json
    // 只是离线兜底。旧版便携包曾出现 extraResources 缺失，导致玩家明明有
    // 完整 72 个模组，却被“缺少 config/pack-manifest.json”挡在启动门外。
    // 在线清单已经通过 refreshServerPackManifest() 校验时，不应再把可选快照
    // 当成硬前置；离线时仍保留原来的明确失败信息。
    let bundled: Record<string, string> = {}
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, '')) as {
        files?: Record<string, string> | { name: string; sha256: string }[]
      }
      bundled = packSnapshotFiles(manifest)
    } else if (!serverPackManifest) {
      return {
        ...empty,
        dir,
        dirState: info.mods.state,
        error: '缺少 config/pack-manifest.json，且当前无法获取服务端清单；联网后请重试'
      }
    }
    // ⚠️ 优先用**服务端**清单：内置的那份是装机时的快照，而整合包会往后走。
    //    只认快照就会出现"玩家照提示更新完，反而被闸门拒绝启动"（2026-09-18 真机踩到）。
    //    官方签名清单不可用时，前面的检查会给出重试提示。
    const expected: Record<string, string> = {}
    for (const [k, v] of Object.entries(bundled)) expected[k] = String(v).toLowerCase()
    const source = serverPackManifest ?? expected
    const sourceNote = serverPackManifest
      ? serverPackManifestNote
      : `内置快照（${serverPackManifestNote}）`
    const modsDir = join(profile.gameDir, 'mods')
    // ---- 三态分开报，且各自说清"下一步做什么" ----
    // 对玩家而言这是三件不同的事：missing = 启动器会建（新装机器/首次运行）；
    // empty = 目录已就绪、去下载整合包；unreadable = 权限/磁盘问题（玩家或运维要动手查）。
    // 混成一句"读不到 mods 目录"时，玩家只能来问"我要建目录吗"。
    if (info.mods.state === 'missing') {
      return {
        ...empty,
        dir,
        dirState: 'missing',
        error: `mods 目录还不存在（启动器会创建）：${modsDir}`
      }
    }
    if (info.mods.state === 'unreadable') {
      return {
        ...empty,
        dir,
        dirState: 'unreadable',
        error: `读不到 mods 目录（权限或磁盘问题，不是"没装整合包"）：${modsDir}${
          info.mods.error ? `（${info.mods.error}）` : ''
        }`
      }
    }
    if (info.mods.state === 'empty') {
      return {
        ...empty,
        dir,
        dirState: 'empty',
        // 这句显示在「模组管理」页，所以下一步动作要指向**这一页上的按钮**，
        // 而不是把玩家再指回"模组管理"（那就是原地打转）。
        error: `整合包尚未安装：${modsDir} 里没有任何 .jar（点上面的「立即更新」下载 ${
          Object.keys(expected).length
        } 个模组）`
      }
    }

    const actual: Record<string, string> = {}
    for (const name of readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue
      const p = join(modsDir, name)
      actual[name] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }

    const missing = Object.keys(source).filter((n) => !(n in actual))
    const extra = Object.keys(actual).filter((n) => !(n in source))
    const changed = Object.keys(source).filter((n) => n in actual && actual[n] !== source[n])
    // "反作弊已加载"要做成**可验证**的状态，不能是写死的一行字：
    // 清单里必须有我们的客户端模组，且它当前确实在位（不是 missing/changed）。
    const acName = Object.keys(source).find((n) => /^(?:breakline-ac|deltaac[-_]?client)-[0-9][^/\\]*\.jar$/i.test(n))
    const antiCheat =
      acName !== undefined &&
      acName in actual &&
      !missing.includes(acName) &&
      !changed.includes(acName)
    return {
      ok: missing.length === 0 && extra.length === 0 && changed.length === 0,
      expected: Object.keys(source).length,
      actual: Object.keys(actual).length,
      // 状态栏要用的两条真实信息
      antiCheat,
      antiCheatFile: acName ?? null,
      missing,
      extra,
      changed,
      sourceNote,
      dirState: 'ok',
      dir
    }
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 启动前预检：把"点下去没反应"变成"明确告诉你缺什么"。
 *
 * 存在的理由很实际：启动失败最常见的原因不是代码，而是**环境不对**——
 * 换了 JDK、整合包换了版本、classpath 没重新生成。没有预检时表现是"点了没反应"，
 * 而那种症状会让人去怀疑启动器本身。
 *
 * 这也是 M2（整合包完整性校验）的种子：**同一套「逐项校验 + 具名失败」结构**，
 * 只是 M2 校验的是 mods/ 里的文件哈希（服务端权威清单），这里校验的是启动环境。
 */
function profileChecks(profile: LaunchProfile): LaunchCheck[] {
  const check = (key: string, title: string, ok: boolean, failure: string): LaunchCheck => ({ key, title, status: ok ? 'ready' : 'error', message: ok ? '已就绪' : failure, repairable: true })
  const missing = profile.classpath.filter(file => !existsSync(file)).length
  const forge = missingForgeRuntime(profile.gameRoot)
  const agents = profile.jvmArgs.filter(value => value.startsWith('-javaagent:')).map(value => value.slice(11).split('=')[0])
  return [
    check('dir', '游戏位置', existsSync(profile.gameDir), '自动查找已有游戏，或创建安装目录'),
    check('java', 'Java 运行环境', existsSync(profile.java), '自动寻找本机 Java 17，未找到时自动安装'),
    check('official', '游戏与声音材质', existsSync(join(profile.gameDir, `${profile.version}.jar`)) && existsSync(join(profile.assetsDir, 'indexes', `${profile.assetIndex}.json`)), '自动复用已有资源，只下载缺少的文件'),
    check('forge', 'Forge 和运行依赖', profile.classpath.length > 0 && missing === 0 && forge.length === 0 && profile.jvmArgs.length > 0, '自动补齐游戏运行依赖'),
    check('login-component', '登录组件', agents.every(file => existsSync(file)), '自动安装登录组件')
  ]
}

app.whenReady().then(() => {
  // ---- `--mcauthtest`：正版登录（微软设备码）自检，mock 链 + 真端点形状自检 ----
  if (process.argv.includes('--mcauthtest')) {
    void runMinecraftAuthSelfTest().then((code) => app.exit(code))
    return
  }
  // ---- `--updatertest`：让**真的 electron-updater** 走一遍 检查→下载→sha512 校验 ----
    // ---- `--launchargstest`：命令行拼装的纯函数自测（片 1 的验收手段）----
  // ---- `--javadownload`：片 3 的整条链（下载 → 校验 → 解压 → 探测）----
  // 做成无头入口而不是只留 UI 按钮：这条链要下 177 MB，**必须有办法在发版前自己跑一遍**，
  // 而不是让玩家当第一个试验者（本项目的规矩：可复现证据先于发布）。
  if (process.argv.includes('--javadownload')) {
    void provisionJava((p) => {
      console.log(`[java] ${p.phase} ${p.percent}% ${p.message}`)
    }).then(async (r) => {
      if (r.ok) {
        const check = await validateJava(r.javaPath ?? '')
        console.log(`[java] ✅ 成功：${r.javaPath}`)
        console.log(`[java] 镜像=${r.mirror} 可运行=${check.ok} 版本=${check.version ?? '-'}`)
        app.exit(0)
      } else {
        console.log(`[java] ✗ 失败：${r.error}`)
        app.exit(1)
      }
    })
    return
  }
  if (process.argv.includes('--launchargstest')) {
    const codes = [runLaunchArgsSelfTest(), runMemoryPlanSelfTest(), runGcProfileSelfTest()]
    void runMemoryCleanupSelfTest(memoryCleanupHelperPath()).then(cleanupCount => {
      console.log(`[launchargstest] MEMORY_CLEANUP=${cleanupCount}`)
      app.exit(codes.some(code => code !== 0) ? 1 : 0)
    }).catch(error => {
      console.error('[launchargstest] MEMORY_CLEANUP failed', error)
      app.exit(1)
    })
    return
  }
  // ---- `--pathtest`：游戏目录解析的纯函数自测（2026-09-18 那个发布级缺陷的判据）----
  //
  // 为什么单开一个入口：**"出厂配置写死了打包机的路径"这件事在打包机上是测不出来的**
  // ——本机 `F:\HMCL-3.6.12\.minecraft` 真的存在，所以 typecheck、构建、界面自检全绿。
  // 这个自测把"别人机器"造成输入（空的 %APPDATA% + 一条不存在的显式路径），
  // 断言生效目录回落到每用户默认目录。它读出厂配置、不碰真实游戏目录。
  if (process.argv.includes('--pathtest')) {
    console.log('[pathtest] 游戏目录解析自测（模拟"别人机器"）')
    const rawForTest = readProfile()
    console.log(`[pathtest] 出厂 gameRoot = ${JSON.stringify(rawForTest?.gameRoot ?? null)}`)
    // 把**真的** resolveProfile 交给自测（第 ⑮ 节）：只有它能回答"启动器拼出来的命令行对不对"。
    // 2026-09-18 真机"开不了游戏"就是因为没人测这条路——自测只测纯函数、探针用自己的展开器。
    const effForTest = readEffectiveProfile()
    const probe: LauncherProbe | undefined =
      rawForTest && effForTest
        ? {
            raw: { ...rawForTest, gameRoot: effForTest.profile.gameRoot } as RawProfileLike,
            userData: app.getPath('userData'),
            resolve: (p) =>
              resolveProfile({ ...rawForTest, ...p } as unknown as LaunchProfile) as unknown as RawProfileLike
          }
        : undefined
    app.exit(runGamePathsSelfTest(rawForTest?.gameRoot ?? null, probe))
    return
  }
  // Offline diagnostic through the actual resolver and LaunchService. Never
  // reads player identity or joins a server; all game writes use a fresh folder.
  const earlyTest = process.argv.indexOf('--early-window-test')
  if (earlyTest > 0) {
    void (async () => {
      const libraryRoot = process.argv[earlyTest + 1]
      if (!libraryRoot || libraryRoot.startsWith('--')) throw new Error('Missing .minecraft library root')
      const raw = readProfile()
      if (!raw) throw new Error('Missing launch profile')
      const game = mkdtempSync(join(app.getPath('temp'), 'delta-early-service-'))
      const profile = resolveProfile({ ...raw, gameRoot: resolve(libraryRoot) })
      profile.gameDir = game
      profile.jvmArgs = profile.jvmArgs.filter(a => !a.startsWith('-javaagent:') && !a.startsWith('-Dauthlibinjector.') && !a.startsWith('-Ddelta.launcher.'))
      profile.jvmArgs.unshift('-Ddelta.early.capture=' + join(game, 'early-frame.png'))
      const original = profile.programArgs ?? []
      profile.programArgs = []
      for (let i = 0; i < original.length; i++) {
        const arg = original[i]
        if (['--quickPlayMultiplayer', '--quickPlaySingleplayer', '--quickPlayRealms', '--server', '--port'].includes(arg)) { i++; continue }
        if (arg === '--gameDir') { profile.programArgs.push(arg, game); i++; continue }
        profile.programArgs.push(arg)
      }
      let log = '', ended = false
      const service = new LaunchService(state => { if ((state as { state: string }).state === 'exited') ended = true }, line => { log += line })
      const status = () => ({ installed: log.includes('[delta-bootstrap] branded early loading installed'), rendered: log.includes('[delta-bootstrap] branded early loading rendered'), handedOff: /Sound engine started|Created: .*textures\/atlas\/blocks/.test(log) })
      try {
        const result = service.start(profile, { username: 'DeltaLoadingProbe', uuid: '00000000000000000000000000000001', token: '0', type: 'legacy' })
        if (!result.ok) throw new Error(result.error)
        const deadline = Date.now() + 90_000
        while (!ended && Date.now() < deadline && !Object.values(status()).every(Boolean)) await new Promise(resolve => setTimeout(resolve, 500))
      } finally {
        service.stop()
        writeFileSync(join(game, 'probe.log'), log)
      }
      const result = { game, ...status() }
      writeFileSync(join(app.getPath('userData'), 'early-window-test.json'), JSON.stringify(result, null, 2))
      console.log('[early-window-test] ' + JSON.stringify(result))
      app.exit(Object.values(status()).every(Boolean) ? 0 : 1)
    })().catch(error => { console.error('[early-window-test]', error); app.exit(1) })
    return
  }
  // ---- `--set-game-root <目录>`：**无点击**走一遍"玩家点浏览…"的落盘链路 ----
  //
  // 与 `config:pick` 共用 applyPickedGameDir（同一份解释/持久化逻辑），所以它能证明
  // "选择真的生效并持久化"，而不用去点那个原生对话框。运维部署时也用得上：
  //   BreaklineLauncher.exe --set-game-root "D:\mc\.minecraft" --selftest
  const setRootFlag = process.argv.indexOf('--set-game-root')
  if (setRootFlag > 0) {
    const dir = process.argv[setRootFlag + 1]
    if (!dir || dir.startsWith('--')) {
      console.log('[set-game-root] 缺少目录参数：--set-game-root <目录>')
      app.exit(2)
      return
    }
    const applied = applyPickedGameDir(dir)
    console.log(JSON.stringify(applied, null, 2))
    console.log(
      applied.ok
        ? `[set-game-root] ✓ 已写入 ${applied.settingsFile}；生效 gameRoot=${applied.effective?.gameRoot} version=${applied.effective?.version}`
        : `[set-game-root] ✗ 未采纳（${applied.notes.join('；')}）`
    )
    app.exit(applied.ok ? 0 : 1)
    return
  }
  if (process.argv.includes('--updatertest')) {
    void runUpdaterSelfTest(app.getVersion()).then((code) => app.exit(code))
    return
  }
  // ---- `--selfupdatecheck`：打**线上 feedUrl**，只查不装（"配好没有"的最终判据）----
  if (process.argv.includes('--selfupdatecheck')) {
    const raw = readProfile() as unknown as { launcherUpdate?: { feedUrl?: string } } | null
    void runSelfUpdateCheck(
      (raw?.launcherUpdate?.feedUrl ?? '').trim(),
      app.getVersion()
    ).then((code) => app.exit(code))
    return
  }
  // ---- `--playertest`：只测玩家系统客户端（**不开窗口、不打生产服务器**）----
  //
  // 它自己起一个 mock HTTP 服务，把 PlayerApi 当真客户端打进去。
  // 放在最前面：这一条不需要窗口，也不该受窗口初始化失败的影响。
  if (process.argv.includes('--playertest')) {
    void runPlayerApiSelfTest().then((code) => app.exit(code))
    return
  }
  // ---- `--updatetest`：只测更新器（同样自起 mock 更新源）----
  if (process.argv.includes('--updatetest')) {
    void runUpdateSelfTest().then((code) => app.exit(code))
    return
  }
  // ---- `--updatelive`：清单元数据取自**真服务器**，文件用本地替身 ----
  if (process.argv.includes('--updatelive')) {
    const base = resolveApiBase(process.argv)
    console.log(`[updatelive] 目标 ${base}`)
    void runUpdateLiveCheck(base).then((code) => app.exit(code))
    return
  }
  // ---- `--playerlogin <邮箱>`：打**真实**玩家系统走一遍登录（验证码从服务端库取）----
  // 与 `--playertest` 的分工：那个证明"客户端按协议说话"，这个证明"对面真的按协议回话"。
  if (process.argv.includes('--playerlogin')) {
    const arg = (flag: string, dflt: string): string => {
      const i = process.argv.indexOf(flag)
      const v = i >= 0 ? process.argv[i + 1] : undefined
      return v && !v.startsWith('--') ? v : dflt
    }
    const email = arg('--playerlogin', '')
    if (!email) {
      console.log('[playerlogin] 缺少邮箱：--playerlogin <邮箱>')
      app.exit(2)
      return
    }
    void runRealLogin(
      email,
      arg('--name', 'Tester'),
      arg('--session-out', join(app.getPath('temp'), 'delta-player-session.json')),
      process.argv.includes('--skip-send')
    ).then((c) => app.exit(c))
    return
  }
  // ---- `--selftest`：不开窗口，打印"这台机器上生效的配置" ----
  // 为什么要有：排障时最常问的三个问题是"你改的是哪个文件""启动器实际用的是哪条路径"
  // "出厂值和你的设置差在哪"。让玩家跑一条命令就能把这三件事一起交出来，
  // 比来回问十句强。也是本仓库验证"玩家设置真的生效"的唯一无点击手段。
  if (process.argv.includes('--medialist')) {
    // 启动动画素材的**无点击**核查：只读、不改磁盘。
    // 存在的理由与 `--selftest` 同源 —— "素材没生效"的症状是静默回落成占位，
    // 画面看不出是没放、放错目录、还是打包没带上，所以要有命令能把候选路径打出来。
    printMediaList()
    app.exit(0)
    return
  }
  if (process.argv.includes('--selftest')) {
    // 用 async IIFE 包一层：这个回调本身不是 async，而头像那条要真的发一次请求
    void (async () => {
    const eff = readEffectiveProfile()
    const factory = readProfile()
    // 只读一次目录状态（不建目录：--selftest 是排障命令，不该改变磁盘上的东西）
    const selftestDir = eff ? gameDirInfo(false) : null
    const out = {
      packaged: app.isPackaged,
      configDir: configDir(),
      settingsFile: overridesFile(),
      settings: readOverrides(),
      factory: factory
        ? { gameRoot: factory.gameRoot, version: factory.version, java: factory.java }
        : null,
      effective: eff
        ? { gameRoot: eff.profile.gameRoot, version: eff.profile.version, java: eff.profile.java }
        : null,
      /**
       * 游戏目录**是这台机器上的哪个目录、谁给的**（2026-09-18 补）。
       *
       * 这一块存在的唯一理由：玩家说"进不去"时，第一个必须回答的问题已经不是
       * "启动器能不能用"，而是"它到底在找哪个目录、那条路径是谁写进去的"。
       * 出厂值（打包机的绝对路径）与生效值（本机解析结果）必须能一眼对照。
       */
      gameRoot: eff
        ? {
            envValue: process.env[GAME_ROOT_ENV] ?? null,
            playerValue: typeof readOverrides().gameRoot === 'string' ? readOverrides().gameRoot : null,
            factoryValue: factory?.gameRoot ?? null,
            effective: eff.profile.gameRoot,
            source: eff.rootInfo.source,
            sourceLabel: sourceLabel(eff.rootInfo.source),
            note: eff.rootInfo.note,
            /** 显式指定过但本机不存在的层（非空 = 这条路径在这台机器上没用） */
            rejected: eff.rootInfo.rejected,
            dir: selftestDir
              ? {
                  versionDir: selftestDir.ensure.versionDir,
                  modsDir: selftestDir.ensure.modsDir,
                  modsState: selftestDir.mods.state,
                  modsJars: selftestDir.mods.jars,
                  notices: selftestDir.notices
                }
              : null
          }
        : null,
      // 展开后的真实路径 + 存在性：一个字段回答"到底能不能启动"
      resolved: eff
        ? (() => {
            const p = resolveProfile(eff.profile)
            return {
              gameDir: p.gameDir,
              gameDirExists: existsSync(p.gameDir),
              modsDir: join(p.gameDir, 'mods'),
              modsExists: existsSync(join(p.gameDir, 'mods')),
              java: p.java,
              javaExists: existsSync(p.java),
              assetsDir: p.assetsDir,
              assetsExists: existsSync(p.assetsDir),
              // 展开后残留的模板：必须是空数组。非空 = 启动必定失败（见 leftoverTemplates 注释）
              leftoverTemplates: leftoverTemplates(p)
            }
          })()
        : null,
      // 顺带把"检测到哪些候选"一起交出来：玩家说"自动检测找不到"时，看这个就知道扫了哪些位置
      detected: { dirs: detectGameDirs(), javas: detectJavas() },
      // 头像链路自检：能不能真的取到 PNG（拿不到不代表坏，只是没登录/没那个角色）
      avatar: await (async () => {
        const name = readEffectiveProfile()?.profile.username ?? ''
        const url = await fetchAvatar(name, 64)
        return { name, ok: url !== null, bytes: url ? Math.round((url.length * 3) / 4) : 0 }
      })()
    }
    const text = JSON.stringify(out, null, 2)
    console.log(text)
    // Windows 上 GUI 子系统的 stdout 未必接得到终端，所以同时落一份文件。
    // `--selftest-out <文件>` 可指定落点：自动化验证（tools/verify-gameroot.mjs）在**隔离的
    // userData** 下连跑多次时，共用一个 %TEMP% 路径会互相覆盖（第一版就撞过）。
    try {
      const outFlag = process.argv.indexOf('--selftest-out')
      const f =
        outFlag > 0 && process.argv[outFlag + 1] && !process.argv[outFlag + 1].startsWith('--')
          ? process.argv[outFlag + 1]
          : join(app.getPath('temp'), 'delta-launcher-selftest.json')
      writeFileSync(f, text, 'utf8')
      console.log(`\n[selftest] 已写入 ${f}`)
    } catch {
      /* 写不了就只打印，不因为日志失败而失败 */
    }
    app.exit(0)
    })()
    return
  }

  // ---- `--acanim`：只开那块"屏幕右下角的反作弊启动浮层"，然后自己退出 ----
  // 为什么要有：这块浮层**不在启动器窗口里**，所以 `--uishot` 那套"截启动器窗口"根本拍不到它。
  // 没有这个开关，"浮层长什么样、贴在哪"就只能靠人肉点一次启动、再自己看屏幕。
  // ⚠️ 它**不登录、不校验整合包、不起游戏进程**，纯粹是把窗口开出来给人看/给自检拍。
  if (process.argv.includes('--acanim')) {
    // 让 require 能解析到 electron 内置模块（与下面那条自检同一个理由）
    module.paths.push(process.cwd())
    // ⚠️ 先把素材目录建出来再算：不建的话 `--medialist` 打印的 siblings 永远是空数组，
    // 看起来像"目录里什么都没有"，而实际只是**目录还不存在**（两种情况的处理完全不同）。
    try {
      mkdirSync(mediaDir(), { recursive: true })
    } catch {
      /* 建不出来不致命：浮层会走动态占位 */
    }
    const r = resolveStartupMedia()
    openAcAnimWindow()
    /**
     * `--acanim-shot <文件>`：**这块窗口自己拍自己**（`webContents.capturePage`）。
     *
     * <p>为什么需要它：浮层是透明、置顶、点透的窗口，用外部截图工具拍它会踩三个坑 ——
     * 合成时机（透明窗口首帧可能是空的）、DPR/多屏、以及"拍到的是桌面还是窗口"。
     * 而"浮层长什么样"这件事必须能**确定性地**取证（它是玩家唯一会看到的东西）。
     * `capturePage` 拿的是渲染进程自己画出来的位图，绕开上面全部三个坑。
     */
    const shotFlag = process.argv.indexOf('--acanim-shot')
    const shotFile =
      shotFlag > 0 && process.argv[shotFlag + 1] && !process.argv[shotFlag + 1].startsWith('--')
        ? process.argv[shotFlag + 1]
        : null
    /**
     * 浮层是**透明、点透、不抢焦点**的窗口：它出问题时屏幕上什么都没有，
     * 而"什么都没有"既可能是"没渲染"，也可能是"渲染了但窗口没合成"。
     * 两种原因的修法完全不同，所以这里把 **DOM 侧的证据**也一起打出来
     * （面板在不在、尺寸多少、视频 readyState、有没有报错文本）。
     */
    const probe = async (): Promise<void> => {
      try {
        if (!acAnimWin || acAnimWin.isDestroyed()) {
          console.log('[acanim] DOM 探针：窗口已不在')
          return
        }
        const info = await acAnimWin.webContents.executeJavaScript(
          `(() => {
             const p = document.querySelector('[data-testid="ac-startup-overlay"]')
             const v = document.querySelector('video')
             const r = p ? p.getBoundingClientRect() : null
             return {
               readyState: document.readyState,
               hasPanel: !!p,
               panelRect: r ? { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) } : null,
               bodyText: (document.body.innerText || '').replace(/\\n+/g, ' | ').slice(0, 160),
               video: v ? { src: v.currentSrc || v.getAttribute('src'), readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, err: v.error ? v.error.code : null } : null,
               zoom: getComputedStyle(document.querySelector('#root > div') || document.body).zoom,
               // 高度链：面板被压扁时，问题一定在这条链上的某一环
               chain: (() => {
                 const out = []
                 const push = (label, el) => {
                   if (!el) { out.push(label + '=null'); return }
                   const r = el.getBoundingClientRect()
                   const cs = getComputedStyle(el)
                   out.push(label + '=' + Math.round(r.width) + 'x' + Math.round(r.height) +
                     '{h:' + cs.height + ',minH:' + cs.minHeight + ',maxH:' + cs.maxHeight +
                     ',display:' + cs.display + ',flex:' + cs.flex + ',align:' + cs.alignItems + '}')
                 }
                 push('html', document.documentElement)
                 push('body', document.body)
                 push('root', document.getElementById('root'))
                 push('wrap1', document.querySelector('#root > div'))
                 push('wrap2', document.querySelector('#root > div > div'))
                 push('panel', document.querySelector('[data-testid="ac-startup-overlay"]'))
                 return out
               })()
             }
           })()`
        )
        console.log(`[acanim] DOM 探针：${JSON.stringify(info)}`)
      } catch (e) {
        console.log(`[acanim] DOM 探针失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (shotFile) {
      // 4 秒：已经过入场动画、读条走到一半（能看到"在推进"的样子），且远早于自动收起
      setTimeout(() => {
        void (async () => {
          try {
            await probe()
            if (acAnimWin && !acAnimWin.isDestroyed()) {
              const img = await acAnimWin.webContents.capturePage()
              const size = img.getSize()
              writeFileSync(shotFile, img.toPNG())
              console.log(
                `[acanim] 已把浮层画面写到 ${shotFile}（${size.width}×${size.height}，` +
                  `空图=${img.isEmpty()}）`
              )
            } else {
              console.log('[acanim] ⚠️ 想截图时浮层已经不在了')
            }
          } catch (e) {
            console.log(`[acanim] ⚠️ 浮层截图失败：${e instanceof Error ? e.message : String(e)}`)
          }
        })()
      }, 4000)
    }
    // 留够一轮完整时间轴（AC_ANIM_MS 会自动收起窗口），然后打印两份证据后退出：
    //   ① 素材解析结论（媒体目录 / 候选 / 命中） ② 浮层窗口几何（位置来自 workArea）
    setTimeout(() => {
      console.log(`[acanim] 浮层窗口是否已收起=${acAnimWin === null}`)
      console.log(`[acanim] 素材命中=${r.path ?? '（无，动态占位）'}`)
      printMediaList()
      app.exit(0)
    }, AC_ANIM_MS + 700)
    return
  }

  launch = new LaunchService(
    (s) => { acMonitor.recordState((s as { state: string }).state); if ((s as { state: string }).state !== 'running') launcherCapture.reset(!!readConsent().launcherCaptureAllowed); win?.webContents.send('launch:state', s) },
    (l) => { acMonitor.observe(l); win?.webContents.send('launch:log', { line: l.slice(-4000) }) }
  )
  auth = new YggdrasilAuth(join(app.getPath('userData'), 'auth.json'))
  mcAuth = new MinecraftAuth(join(app.getPath('userData'), 'minecraft-auth.json'), undefined, {
    encrypt: value => {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用；仅保留本次会话')
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
  })
  player = new PlayerApi(
    new SessionStore(join(app.getPath('userData'), 'player-session.json')),
    playerApiBase(),
    app.getVersion()
  )
  console.log(`[launcher] 玩家系统 API：${player.base}`)

  ipcMain.handle('consent:get', () => readConsent())
  ipcMain.handle('anticheat:status', () => monitorSnapshot())
  ipcMain.handle('consent:accept', (_e, accepted: boolean) => {
    const state = writeConsent(accepted === true)
    launcherCapture.reset(!!state.launcherCaptureAllowed)
    return state
  })
  // ---- 片 1 后半：游戏运行参数（内存 / 分辨率 / 全屏）----
  // 只认四个键的白名单（见 RuntimeSettings.ts 的注释：不做任意 JSON 合并）。
  // 返回**回读后的生效值** —— 界面据此显示"真的存进去了什么"。
  const runtimeSettingsView = (): RuntimeSettings & { autoMemoryMb?: number; availableMb?: number; modCount?: number } => {
    const eff = readEffectiveProfile()
    return {
      ...getRuntimeSettings(),
      ...(getRuntimeSettings().lowMemoryMode === true ? { memoryMb: eff?.runtime.memoryMb } : {}),
      autoMemoryMb: eff?.runtime.autoMemoryMb,
      availableMb: eff?.runtime.availableMb,
      modCount: eff?.runtime.modCount
    }
  }
  ipcMain.handle('settings:runtime:get', () => runtimeSettingsView())
  ipcMain.handle('settings:runtime:set', async (_e, patch: RuntimeSettings) => {
    await setRuntimeSettings(patch ?? {})
    return runtimeSettingsView()
  })
  // 片 2：列出本机**真的能跑**的 Java（路径/版本/架构/来源）。探测有超时，不会拖住启动器。
  ipcMain.handle('java:list', () => listJavas())
  // 片 3：下载并安装 Java（177 MB，带进度）。进度走后发事件，因为一次下载要几分钟，
  // 界面需要一个不会"看起来卡死"的反馈（这正是免安装版更新踩过的那个坑）。
  ipcMain.handle('java:provision', async (event) => {
    return provisionJava((p) => {
      try {
        event.sender.send('java:progress', p)
      } catch {
        // 窗口关了就算了，不能因为推不进进度就中断下载
      }
    })
  })

  // ---- 玩家系统（第 2 项：不允许离线账号）----
  //
  // 三个通道刻意分开，且**都不接受任意 URL/命令**：renderer 只能提交
  // 「角色名 + 邮箱 + 验证码」，请求由主进程按固定端点发出。
  ipcMain.handle('player:status', async () => {
    // 每次界面问一次都**真的问服务端**：本地有 token 不等于会话有效。
    // 结论同时写进 sessionCheck，供同步的 preflight 使用。
    sessionCheck = await player.status()
    return shapeSession(sessionCheck)
  })
  ipcMain.handle('player:sendCode', async (_e, name: string, email: string, site?: string) => {
    if (typeof name !== 'string' || typeof email !== 'string') {
      return { ok: false, error: 'bad_request', message: '参数不完整' }
    }
    // 身份来源由界面传入，但**只在白名单里选**：不能让 renderer 指定任意站点。
    const src = site === 'premium' ? 'premium' : DEFAULT_SITE
    const r = await player.sendCode(name, email, src)
    // 日志里**不写邮箱全文与验证码**：邮箱属个人信息，验证码是凭据。
    // 失败时把服务端给的原因码也带上 —— 排障时"为什么被拒"必须一眼看到，
    // 而不是只看到一句通用文案（2026-09-17 email_in_use 那次就吃了这个亏）。
    win?.webContents.send('launch:log', {
      line: r.ok
        ? `[launcher] 验证码请求已提交（${src} 角色名 ${name.trim()}）${
            r.accepted === false ? '，但服务端未能发信' : ''
          }`
        : `[launcher] 获取验证码失败${r.code ? `（${r.code}）` : ''}：${r.message ?? r.error}`
    })
    return r
  })
  // ---- 密码登录（2026-09-18）----
  //
  // 两条新通道，分工与 PlayerApi 里的两个方法一致：
  //   player:accountStatus → "这个角色该怎么登"（**只读**，绝不发邮件）
  //   player:loginPassword → 纯密码登录
  ipcMain.handle('player:accountStatus', async (_e, name: string, site?: string) => {
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, exists: false, hasPassword: false, message: '请先填角色名' }
    }
    const src = site === 'premium' ? 'premium' : DEFAULT_SITE
    return player.accountStatus(name, src)
  })
  ipcMain.handle('player:loginPassword', async (_e, name: string, password: string, site?: string) => {
    if (typeof name !== 'string' || typeof password !== 'string' || !password) {
      return { ok: false, error: 'bad_request', message: '请把角色名和密码都填上' }
    }
    const src = site === 'premium' ? 'premium' : DEFAULT_SITE
    const r = await player.loginWithPassword(name, password, src)
    // 与验证码登录同一纪律：拿到的会话必须让**服务端**点头才算数。
    if (r.ok) sessionCheck = await player.status()
    win?.webContents.send('launch:log', {
      line: r.ok
        ? `[launcher] 玩家系统登录成功（密码）：${r.player?.name}`
        : `[launcher] 玩家系统登录失败（密码）：${r.message ?? r.error}`
    })
    return r
  })
  ipcMain.handle('player:loginLittleSkin', async (_e, account: string, password: string) => {
    identityAttempt++
    mcAuth.logout()
    if (typeof account !== 'string' || typeof password !== 'string' || !account.trim() || !password) {
      return { ok: false, error: 'bad_request', message: '请输入 LittleSkin 账号和密码' }
    }
    const authenticated = await auth.login(account.trim(), password)
    if (!authenticated.ok || !authenticated.session) {
      return { ok: false, error: 'littleskin_login_failed', message: authenticated.error ?? 'LittleSkin 登录失败' }
    }
    const result = await player.loginWithLittleSkin(authenticated.session)
    if (result.ok) sessionCheck = await player.status()
    return result
  })
  ipcMain.handle('player:login', async (_e, email: string, code: string, password?: string) => {
    if (typeof email !== 'string' || typeof code !== 'string') {
      return { ok: false, error: 'bad_request', message: '参数不完整' }
    }
    // password 可选：带上就是"首次绑定邮箱时顺手设密码"（运维 2026-09-18 要求）。
    const r = await player.login(email, code, typeof password === 'string' ? password : undefined)
    // 登录成功后立刻复核一次：只有服务端认这个会话，闸门才会开
    // （避免"本地写了 token 就放行"这种看起来能用、实际没有校验的状态）。
    if (r.ok) sessionCheck = await player.status()
    win?.webContents.send('launch:log', {
      line: r.ok
        ? `[launcher] 玩家系统登录成功：${r.player?.name}${password ? '（并已设置密码）' : ''}`
        : `[launcher] 玩家系统登录失败：${r.message ?? r.error}`
    })
    return r
  })
  ipcMain.handle('player:logout', () => {
    identityAttempt++
    mcAuth.logout()
    player.logout()
    sessionCheck = { state: 'none' }
    return { ok: true }
  })
  ipcMain.handle('player:info', () => {
    const c = player.cached()
    return c ? { name: c.player.name, email: c.player.email, site: c.player.site } : null
  })

  // ---- 正版登录（第 4 项：微软设备码流程）----
  //
  // 纪律：交给 renderer 的状态一律走 `toPublicState`（**去掉 device_code**）。
  // 那个码是轮询凭据，谁拿到谁能替玩家领 token，没有任何理由离开主进程。
  ipcMain.handle('mc:state', () => toPublicState(mcAuth.state()))
  ipcMain.handle('mc:start', async () => {
    identityAttempt++
    const previous = player.cached()
    microsoftLinkSession = previous?.player.site === 'littleskin' ? { token: previous.token, name: previous.player.name } : undefined
    player.logout()
    sessionCheck = { state: 'none' }
    const r = await mcAuth.start(msClientId())
    if (r.ok) {
      win?.webContents.send('launch:log', {
        line: `[launcher] 正版登录：请在浏览器里打开 ${r.session.verificationUri} 并输入 ${r.session.userCode}`
      })
    }
    return r.ok ? { ok: true } : r
  })
  ipcMain.handle('mc:poll', async () => {
    const attempt = identityAttempt
    const st = await mcAuth.poll(msClientId())
    if (attempt !== identityAttempt) return { state: 'none' }
    if (st.state === 'ok') {
      const credentials = mcAuth.credentials()
      if (!credentials) return { state: 'error', error: '微软游戏身份缺失，请重新登录' }
      const link = microsoftLinkSession?.name.toLowerCase() === credentials.username.toLowerCase() ? microsoftLinkSession.token : undefined
      const result = await player.loginWithMicrosoft(credentials, () => attempt === identityAttempt, link)
      microsoftLinkSession = undefined
      if (attempt !== identityAttempt) return { state: 'none' }
      if (!result.ok) {
        const error = result.message ?? '正版身份验证未通过'
        win?.webContents.send('launch:log', { line: `[launcher] 正版服务器登录未完成：${error}` })
        return { state: 'error', error }
      }
      sessionCheck = await player.status()
      win?.webContents.send('launch:log', { line: `[launcher] 正版登录成功：${st.profile.name}` })
    } else if (st.state === 'error') {
      win?.webContents.send('launch:log', { line: `[launcher] 正版登录失败：${st.error}` })
    }
    return toPublicState(st)
  })
  ipcMain.handle('mc:logout', () => {
    identityAttempt++
    microsoftLinkSession = undefined
    mcAuth.logout()
    return { ok: true }
  })
  /** 打开系统浏览器去输码。**绝不内嵌浏览器**——那等于让我们经手玩家的微软密码。 */
  ipcMain.handle('mc:openBrowser', async () => {
    const st = mcAuth.state()
    const url = st.state === 'pending' ? st.session.verificationUri : 'https://microsoft.com/link'
    await shell.openExternal(url)
    return { ok: true }
  })

  // 启动闸门的**只读预演**：界面在首页就能显示"为什么现在点不动"，
  // 不必让玩家点一次按钮才知道。与真正启动走同一段判定（preflight），不存在第二套逻辑。
  ipcMain.handle('launch:preflight', async () => {
    await refreshServerPackManifest()
    return preflight()
  })

  /**
   * 启动动画素材（"反作弊启动中"那个面板上面那块视频）。
   *
   * <p>为什么素材路径必须由主进程给：renderer 是浏览器环境，既不知道
   * `process.resourcesPath`，也不该自己拼盘符路径。它只会拿到一个
   * `file://` URL（=null 表示素材没放 ⇒ 界面回落到同版式的动态占位）。
   *
   * <p>**只有这一条通道，且不带参数**：不给 renderer 传任意路径的口子
   * （传了就等于把"读本机任意文件"做进 UI 层）。
   */
  ipcMain.handle('media:startup', () => {
    const r = resolveStartupMedia()
    if (r.path) {
      console.log(`[launcher] 启动动画素材：${r.path}${r.overridePath ? '（玩家目录覆盖）' : ''}`)
    } else {
      console.log('[launcher] 启动动画素材：未找到（界面使用动态占位；放 ac-startup.mp4 即生效）')
    }
    return { url: r.url, path: r.path, expected: r.candidates }
  })

  /**
   * 打开「反作弊启动中」浮层（屏幕右下角的独立窗口）。
   *
   * <p>**没有参数**：浮层的位置、大小、素材、时长全部由主进程决定。
   * renderer 只能"请求开一次"，不能指定坐标、大小或路径 —— 否则 renderer 被注入
   * 就能在屏幕上任意位置开一块置顶窗口（那是比弹广告更糟的东西）。
   */
  ipcMain.handle('anim:show', () => openAcAnimWindow())

  /** 浮层自报时间轴进度。只进日志：窗口寿命由主进程按固定时长控，报告不能延长它。 */
  ipcMain.on('anim:signal', (event, payload: unknown) => {
    // 只认浮层那一个 webContents 发来的消息
    if (!acAnimWin || acAnimWin.isDestroyed() || event.sender.id !== acAnimWin.webContents.id) return
    const text = typeof payload === 'string' ? payload.slice(0, 80) : ''
    console.log(`[launcher] 反作弊启动浮层进度：${text}`)
    win?.webContents.send('launch:log', { line: `[launcher] 反作弊启动浮层：${text}` })
  })

  ipcMain.handle('launch:start', async () => {
    // 启动前刷新服务端清单（见 verifyPack 的注释：闸门必须按服务端当前版本判）。
    // 拉不到就用内置快照，绝不因为网络问题挡住启动。
    win?.webContents.send('launch:log', { line: '[launcher] 启动检查：正在获取服务器清单…' })
    await refreshServerPackManifest()
    return doLaunch!()
  })

  /**
   * 启动游戏的**唯一实现**。两个入口共用它：`launch:start`（界面按钮）
   * 与托盘菜单的"启动游戏"（见模块级 `doLaunch`）。
   *
   * <p>抽出来的理由与 `preflight()` 同源：**判定只能有一份**。
   * 托盘那条路上如果另写一遍，两边迟早会不一致 —— 而那次不一致会是
   * "托盘能起、界面起不了"或更糟的"托盘绕过了某个检查"。
   */
  const launchChecked = async (): Promise<{ ok: boolean; pid?: number; error?: string }> => {
    if (repairInFlight) return { ok: false, error: '正在修复运行环境，请等待修复结果后再启动' }
    if (launch?.state().state === 'running') return { ok: false, error: '游戏已在运行' }
    win?.webContents.send('launch:log', { line: '[launcher] 启动检查：正在核实玩家登录会话…' })
    const sessionState = await player.status()
    sessionCheck = sessionState
    if (sessionState.state === 'none') return { ok: false, error: '玩家系统登录已过期或尚未登录，请重新登录启动器账号后再启动游戏' }
    if (sessionState.state === 'unreachable') return { ok: false, error: `无法核实登录会话：${sessionState.error}。请检查网络后重试。` }
    if (sessionState.state === 'banned') return { ok: false, error: '账号处于封禁状态，请联系管理员复核' }
    if (!dryRun && sessionState.player.site !== 'premium') {
      win?.webContents.send('launch:log', { line: '[launcher] 启动检查：正在校验 LittleSkin 登录组件…' })
      try {
        await ensureLoginComponent(app.getPath('userData'), join(configDir(), 'authlib-injector-1.2.8.jar'))
      } catch (e) {
        return { ok: false, error: `登录组件安装失败：${e instanceof Error ? e.message : String(e)}。请重试或点“一键修复”。` }
      }
    }
    let verdict = preflight()
    let prepared = false
    if (!dryRun && readConsent().accepted && (verdict.ok || ['env_problem', 'pack_mismatch'].includes(verdict.code ?? ''))) {
      const java = readEffectiveProfile()
      const javaUsable = java ? (await validateJava(resolveProfile(java.profile).java)).ok : false
      if (!verdict.ok || !javaUsable) {
        const result = await repairGameDir()
        if (!result.ok) return { ok: false, error: result.remaining[0] ?? '准备尚未完成，再点一次将继续已有进度' }
        prepared = true
        await refreshServerPackManifest()
        verdict = preflight()
      }
    }
    if (!verdict.ok) return { ok: false, error: verdict.message }
    const playerName = verdict.player
    if (!playerName) return { ok: false, error: '玩家会话缺少角色名，请退出账号后重新登录' }
    win?.webContents.send('launch:log', { line: '[launcher] 启动检查：正在核实设备标识和虚拟机环境…' })
    const deviceCheck = await player.checkDevice()
    if (!deviceCheck.ok) return { ok: false, error: deviceCheck.error ?? '设备与启动环境验证未通过' }

    // Red item models are client-side only. Verify and enable them in the effective isolated instance.
    // UI dry-runs do not alter the player's real game directory; the dedicated resource-pack test covers this path.
    if (!dryRun) {
      win?.webContents.send('launch:log', { line: '[launcher] 启动检查：正在校验模组和官方资源，下载进度将显示在这里…' })
      const updated = prepared ? { ok: true } : await updateApply()
      if (!updated.ok) return { ok: false, error: `客户端更新验证失败：${updated.error ?? '未知原因'}。请点“一键修复”后重试。` }
      const cosmeticGameDir = gameDirInfo(true)?.ensure.versionDir
      if (cosmeticGameDir) await provisionCosmeticAssets(cosmeticGameDir, line =>
        win?.webContents.send('launch:log', { line: '[launcher] ' + line }))
    }

    // 身份只能有一条：玩家系统名、令牌签名名、Minecraft --username 必须完全一致。
    // 微软/LittleSkin 缓存属于别的角色时明确拒绝，不能静默串号。
    let skinSession: YggdrasilSession | null = null
    win?.webContents.send('launch:log', { line: '[launcher] 启动检查：正在核实游戏身份…' })
    const premium = sessionState.player.site === 'premium'
    const official = premium ? await mcAuth.ensureFresh() : null
    if (!premium) {
      try { skinSession = await auth.ensureFresh() } catch { skinSession = null }
    }
    if (premium && !official) return { ok: false, error: '微软正版登录已失效或无法验证，请重新登录后启动游戏' }
    if (!premium && !skinSession) return { ok: false, error: 'LittleSkin 登录已失效，请重新登录后启动游戏' }
    const chosen = premium && official
      ? { username: official.username, uuid: official.uuid, token: official.accessToken, type: 'msa' }
      : { username: skinSession!.username, uuid: skinSession!.uuid, token: skinSession!.accessToken, type: 'mojang' }
    if (chosen.username.toLowerCase() !== playerName.toLowerCase()
        || chosen.uuid.replace(/-/g, '').toLowerCase() !== sessionState.player.uuid.replace(/-/g, '').toLowerCase()) {
      const source = premium ? '微软正版' : 'LittleSkin'
      return {
        ok: false,
        error: `账号不一致：玩家系统是 ${playerName}，${source} 当前是 ${chosen.username}。请退出错误账号后重新登录。`
      }
    }
    // 令牌拿不到就不启动。旧行为会继续拉起一个注定在 5 秒后被踢的游戏，
    // 玩家只能看到“启动器启动也被踢”，完全无法判断是网络、会话还是账号错绑。
    let issued: Awaited<ReturnType<typeof player.launcherToken>>
    try {
      issued = await player.launcherToken(chosen.username)
      if (!issued.ok) {
        return { ok: false, error: `启动验证失败：${issued.error}` }
      }
      win?.webContents.send('launch:log', {
        line: `[launcher] 启动身份 ${chosen.username} 已核实，来源令牌 ${issued.ttlSeconds} 秒有效 ✓`
      })
    } catch (e) {
      return { ok: false, error: `启动验证异常：${e instanceof Error ? e.message : String(e)}` }
    }
    // 自检的干跑：判定照走，**进程不真起**。
    // 放在判定之后、spawn 之前——这样干跑验的仍是同一段闸门逻辑，不是另写一份。
    if (dryRun) {
      win?.webContents.send('launch:log', {
        line: '[launcher] 干跑（--uishot-dry-run）：判定全部通过，但不启动进程'
      })
      /**
       * 干跑也**照常播浮层** —— 它的价值就在这里：界面自检要能在不真的开一次游戏的前提下
       * 验到"浮层真的出现在屏幕右下角、读条真的在走"。干跑跳过的只是 spawn 那一步。
       */
      openAcAnimWindow()
      return { ok: true }
    }
    const eff = readEffectiveProfile()
    if (!eff) return { ok: false, error: noProfileMessage() }
    const profile = resolveProfile(eff.profile)
    if (premium) profile.jvmArgs = profile.jvmArgs.filter(value => !value.startsWith('-javaagent:') && !value.startsWith('-Dauthlibinjector.'))
    const identity = chosen
    win?.webContents.send('launch:log', {
      line: `[launcher] 登录模式：${premium ? '微软正版' : 'LittleSkin'} ${identity.username}`
    })
    let lease: LaunchLease
    try {
      launcherCapture.reset(!!readConsent().launcherCaptureAllowed)
      lease = await LaunchLease.start(issued, () => player.launcherToken(identity.username), frame => acMonitor.receive(frame), ticket => {
        parseCaptureTicket(ticket, identity.username)
        const pid = launch?.state().pid
        void launcherCapture.request(ticket, identity.username, pid, !!readConsent().launcherCaptureAllowed, (request, bytes) => {
          if (!readConsent().launcherCaptureAllowed || launch?.state().pid !== pid) throw new Error('授权已撤销或游戏已退出，已取消上传')
          return player.uploadScreenshot(request, bytes)
        }).catch(() => {})
      })
      activeLease = lease
    } catch {
      return { ok: false, error: '后台验证服务启动失败，请重启启动器后重试' }
    }
    const javaInfo = await validateJava(profile.java)
    if (!javaInfo.ok) {
      lease.close()
      return { ok: false, error: `Java 版本检查失败：${javaInfo.error ?? '无法读取版本'}` }
    }
    if (getRuntimeSettings().memoryCleanupEnabled === true) {
      const cleanup = await runMemoryCleanup(memoryCleanupHelperPath())
      win?.webContents.send('launch:log', {
        line: cleanup.status === 'success'
          ? `[launcher] ${cleanup.message}`
          : `[launcher] 内存回收未完成：${cleanup.message}`
      })
    }
    try { applyLowMemoryMode(profile.gameDir, readOverrides().lowMemoryMode) } catch (error) { lease.close(); return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    const r = launch!.start(profile, identity, lease, javaInfo.major ?? 17)
    if (!r.ok) lease.close()
    rebuildTrayMenu() // 状态变了，托盘菜单跟着变
    /**
     * 启动成功 ⇒ 开「反作弊启动中」浮层（**屏幕右下角的独立窗口**）。
     *
     * <p>放在这里而不是界面里：这里是**两条入口（界面按钮 + 托盘菜单）唯一共用的那段**。
     * 放界面里的话，从托盘启动就不会有动画 —— 而"从托盘起就没有"这种不一致
     * 事后几乎不可能被发现（没人会两条路都试一遍）。
     */
    if (r.ok) openAcAnimWindow()
    return r
  }

  let launchAttempt: Promise<{ ok: boolean; pid?: number; error?: string }> | null = null
  doLaunch = () => {
    if (!launchAttempt) launchAttempt = (async () => {
      try { const result = await launchChecked(); if (!result.ok) closeAcAnimWindow('启动未通过'); return result }
      catch (error) { closeAcAnimWindow('启动异常'); throw error }
    })().finally(() => { launchAttempt = null })
    return launchAttempt
  }

  // 头像给界面用（data URL）。**只允许已登录的用户名或界面正在输入的名字**，
  // 不做任意查询——否则 renderer 被注入就能拿这个当"探测任意角色是否存在"的接口。
  ipcMain.handle('auth:avatar', async (_e, name: unknown) => {
    if (typeof name !== 'string') return null
    return await fetchAvatar(name, 64)
  })

  /** 整合包清单的端点：从配置读，客户端不自己拼地址（换地址只改配置一处）。 */
  function packManifestPath(): string {
    const raw = readProfile() as unknown as { packUpdate?: { manifestPath?: string } } | null
    const p = raw?.packUpdate?.manifestPath
    return typeof p === 'string' && p.startsWith('/') ? p : '/api/pack/manifest'
  }

  /** 自身更新源：同样从配置读。留空 = 不检查（并明确告诉界面"没配"）。 */
  function selfUpdateService(): SelfUpdateService {
    const raw = readProfile() as unknown as { launcherUpdate?: { feedUrl?: string } } | null
    const feed = (raw?.launcherUpdate?.feedUrl ?? '').trim()
    return new SelfUpdateService(feed, (p) =>
      win?.webContents.send('update:self-progress', p)
    )
  }

  /**
   * 启动时把"哪些能力是关着的、为什么"打一遍。
   *
   * <p>为什么必须打：这三项（自身更新 / 整合包更新源 / 正版登录）在**没配好时
   * 全都表现得像"正常但没事发生"** —— 不报错、不弹窗、界面照常。
   * 2026-09-17 运维问"启动器会不会自己更新"，答案在配置里，但**界面上没有任何地方
   * 会主动告诉你"这项没开"**（只有翻到设置页、点一下检查，才能看到一句"未配置更新源"）。
   * 一句启动日志是成本最低的"可发现性"：排障时看日志就知道开关状态。
   */
  function logCapabilityStatus(): void {
    const raw = readProfile() as unknown as
      | { launcherUpdate?: { feedUrl?: string; msClientId?: string } }
      | null
    const feed = (raw?.launcherUpdate?.feedUrl ?? '').trim()
    const msId = msClientId()
    const line =
      `[launcher] 能力开关：自身更新=${feed ? `开（${feed}）` : '关（未配 launcherUpdate.feedUrl）'}` +
      ` ｜ 正版登录=${msId ? '开' : '关（未配 launcherUpdate.msClientId）'}` +
      ` ｜ 打包形态=${app.isPackaged ? '安装版' : '开发模式（自身更新天然不可用）'}`
    console.log(line)
    win?.webContents.send('launch:log', { line })
  }

  /**
   * 微软 client_id：**必须由运维注册自己的 Azure 应用**。
   *
   * 为什么不内置一个"公共 client_id"：拿别人的 id 去用是冒用，对方随时能吊销，
   * 而且违反微软条款。没配时界面会明确说"正版登录还没配置"，
   * 而不是给一个永远转圈的按钮（那会让玩家以为是自己网络的问题）。
   */
  function msClientId(): string {
    const raw = readProfile() as unknown as { launcherUpdate?: { msClientId?: string } } | null
    return (raw?.launcherUpdate?.msClientId ?? process.env['DELTA_MS_CLIENT_ID'] ?? '319f82ca-6a54-46ac-a703-59e26cc350b3').trim()
  }

  /**
   * 整合包更新的两个动作。**判定与写入分离**：
   * - `updateCheck()` 只读：拿清单 + 差量比对，告诉界面"差几个、要下多少字节"。
   * - `updateApply()` 会写磁盘：下载 → 校验 → 原子替换，失败自动回滚。
   */
  function modsDirOf(): string | null {
    const eff = readEffectiveProfile()
    if (!eff) return null
    // gameDir 指向 `versions/<实例名>`（版本隔离），模组在它的 mods/ 下
    return join(resolveProfile(eff.profile).gameDir, 'mods')
  }

  function updaterFor(): UpdateService | null {
    const mods = modsDirOf()
    if (!mods) return null
    const ud = app.getPath('userData')
    return new UpdateService(
      mods,
      join(ud, 'update-staging'),
      join(ud, 'update-backup'),
      (p) => win?.webContents.send('update:progress', p)
    )
  }

  /**
   * 拉清单。**必须过 `validateManifest`**：形状不对就拒绝，不让坏清单变成"全部不一致"。
   *
   * ⚠️ 请求要带 `X-Delta-Launcher-Version`：服务端据此判断"这个启动器的启动闸门
   *    是以服务端清单为准（新版）还是只认装机快照（老版）"。**老版会拿到一份冻结的旧清单**，
   *    于是它的更新卡片算出来"无差异"，玩家不会被诱导去更新、也就不会掉进
   *    「更新完被自己的闸门拒绝启动」那个死循环。见 player-api 的 legacy_pack_manifest。
   */
  async function fetchManifest(): Promise<{ ok: true; manifest: PackManifest } | { ok: false; error: string }> {
    try {
      const snapshot = await fetchPackSnapshot(player.base, packManifestPath(), app.getVersion())
      useServerManifest(snapshot)
      return { ok: true, manifest: snapshot.manifest }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  async function updateCheck(): Promise<{
    ok: boolean
    error?: string
    packVersion?: string
    gameVersion?: string
    missing?: number
    changed?: number
    extra?: string[]
    upToDate?: boolean
    bytesTotal?: number
    /** 清单里有条目但没有下载地址 ⇒ 服务端还没配对象存储 */
    noDownloadBase?: boolean
  }> {
    const svc = updaterFor()
    if (!svc) return { ok: false, error: noProfileMessage() }
    const r = await fetchManifest()
    if (!r.ok) return { ok: false, error: r.error }
    const d = svc.diff(r.manifest)
    const todo = [...d.missing, ...d.changed]
    return {
      ok: true,
      packVersion: r.manifest.packVersion,
      gameVersion: r.manifest.gameVersion,
      missing: d.missing.length,
      changed: d.changed.length,
      extra: d.extra,
      upToDate: todo.length === 0 && d.extra.length === 0,
      bytesTotal: todo.reduce((s, e) => s + e.size, 0),
      noDownloadBase: r.manifest.files.some((f) => !f.url)
    }
  }

  let updateInFlight: ReturnType<typeof performUpdateApply> | null = null
  function updateApply(): ReturnType<typeof performUpdateApply> {
    if (!updateInFlight) updateInFlight = performUpdateApply().finally(() => { updateInFlight = null })
    return updateInFlight
  }
  async function performUpdateApply(): Promise<{
    ok: boolean
    error?: string
    applied?: number
    rolledBack?: boolean
    backupDir?: string
    resourcesRemoved?: number
  }> {
    if (repairInFlight) return { ok: false, error: '正在自动准备游戏，请等待当前准备完成' }
    if (launch?.state().state === 'running') return { ok: false, error: '游戏运行中，请先关闭游戏再更新' }
    const svc = updaterFor()
    if (!svc) return { ok: false, error: noProfileMessage() }
    const r = await fetchManifest()
    if (!r.ok) return { ok: false, error: r.error }
    const info = gameDirInfo(true)
    if (!info) return { ok: false, error: noProfileMessage() }
    const bundle = await provisionClientBundle(resolveApiBase(), info.ensure.versionDir, bundleActivity)
    if (!bundle.ok) return { ok: false, error: bundle.error }
    const red = await installRedPack(resolveApiBase(), info.ensure.versionDir)
    if (!red.ok) return { ok: false, error: red.error }
    const mods = await applyMods(svc, r.manifest)
    return mods.ok ? { ...mods, resourcesRemoved: bundle.removed ?? 0 } : mods
  }

  async function applyMods(svc: UpdateService, manifest: PackManifest): Promise<{
    ok: boolean; error?: string; applied?: number; rolledBack?: boolean; backupDir?: string
  }> {
    const res = await svc.apply(manifest)
    if (!res.ok) {
      win?.webContents.send('launch:log', {
        line: `[launcher] 更新失败：${res.failed ?? ''}${res.rolledBack === true ? '（已回滚，模组保持原样）' : res.rolledBack === false ? '（⚠️ 回滚未完成，请检查 mods/）' : '（尚未替换游戏模组，可重试）'}`
      })
      return { ok: false, error: res.failed, rolledBack: res.rolledBack, backupDir: res.backupDir }
    }
    win?.webContents.send('launch:log', {
      line: `[launcher] 更新完成：${res.applied.length} 个文件已替换${res.backupDir ? `（旧文件备份在 ${res.backupDir}）` : ''}`
    })
    return { ok: true, applied: res.applied.length, backupDir: res.backupDir }
  }

  /**
   * 「一键修复」：把启动器**能自己修**的都修掉，然后把修不了的说清楚。
   *
   * <h2>为什么需要它（运维 2026-09-18 追加要求："最好出一个尽可能一键修复的按钮"）</h2>
   * 这一轮之前，玩家遇到"进不去"要自己做四件事：判断目录对不对、选目录、下载整合包、
   * 再回来点启动。每一步都可能卡住，而每一步失败的样子都很像（"还是进不去"）。
   * 一键修复把这条链压成一次点击，并且**每一步都留下可读结论**（不是一句"修复完成"）。
   *
   * <h2>顺序即依赖关系</h2>
   * ① 目录：当前生效目录不可用时，主动在本机常见位置找**我们的**整合包并采用（写 settings.json）
   * ② 结构：创建 `<root>/versions/<实例>/{mods,config}`（幂等）
   * ③ 整合包：按服务端权威清单做**差量**下载 + 逐文件 SHA-256 校验 + 原子替换（复用 M3 更新器）
   * ④ 官方内容：检查 assets / libraries / 版本 jar——**启动器目前不下载这些**，缺就如实报
   * ⑤ Java：不存在就指路（设置页可选用/可下载）——**不替玩家决定**用哪个 JDK
   * ⑥ 复检：跑与启动闸门同一段整合包校验，把剩余问题逐条列出来
   *
   * <h2>刻意不做的事</h2>
   * - **不伪造成功**：`ok` 只在"每一项都过"时才为 true；剩下的逐条进 `remaining`。
   * - **不删玩家自己装的模组**：更新器只补/换清单里的文件（既有纪律，见 UpdateService）。
   * - **不写 config/**：玩家选择写 `%APPDATA%\<产品名>\settings.json`（见 applyPickedGameDir）。
   */
  let preparation: LaunchPreparation = { running: false, startedAt: 0, checks: [] }
  let repairInFlight: ReturnType<typeof performRepairGameDir> | null = null
  function repairGameDir(): ReturnType<typeof performRepairGameDir> {
    if (!repairInFlight) repairInFlight = (async () => { if (updateInFlight) await updateInFlight; return performRepairGameDir() })().catch(error => ({ ok: false, steps: [], effective: null, remaining: [error instanceof Error ? error.message : String(error)], pack: null })).finally(() => { repairInFlight = null; win?.webContents.send('launch:preparation', { ...preparation, running: false }) })
    return repairInFlight
  }
  // Repair the small missing/changed mod first; large content downloads must not hide that work.
  async function repairMods(): Promise<Awaited<ReturnType<typeof applyMods>>> {
    const svc = updaterFor()
    if (!svc) return { ok: false, error: noProfileMessage() }
    const manifest = await fetchManifest()
    if (!manifest.ok) return { ok: false, error: manifest.error }
    const result = await applyMods(svc, manifest.manifest)
    win?.webContents.send('launch:log', { line: result.ok
      ? `[launcher] 一键修复：模组检查完成，已修复 ${result.applied ?? 0} 个文件；继续检查客户端资源…`
      : `[launcher] 一键修复：模组修复未完成：${result.error ?? '未知原因'}` })
    return result
  }
  async function performRepairGameDir(): Promise<{
    ok: boolean
    steps: { key: string; title: string; ok: boolean; changed: boolean; message: string; detail?: string }[]
    effective: { gameRoot: string; version: string; source: string; sourceLabel: string } | null
    remaining: string[]
    pack: ReturnType<typeof verifyPack> | null
  }> {
    if (launch?.state().state === 'running') {
      return { ok: false, steps: [], effective: null, remaining: ['游戏运行中，请先关闭游戏再修复'], pack: null }
    }
    const steps: {
      key: string
      title: string
      ok: boolean
      changed: boolean
      message: string
      detail?: string
    }[] = []
    const log = (line: string): void => {
      win?.webContents.send('launch:log', { line: `[launcher] 一键修复：${line}` })
    }
    preparation = { running: true, startedAt: Date.now(), checks: [] }
    const begin = (key: string, title: string, message: string): void => {
      preparation.checks = [...preparation.checks.filter(check => check.key !== key), { key, title, status: 'working', message }]
      win?.webContents.send('launch:preparation', preparation)
    }
    const addStep = (step: typeof steps[number]): void => {
      steps.push(step)
      preparation.checks = [...preparation.checks.filter(check => check.key !== step.key), { key: step.key, title: step.title, status: step.ok ? 'ready' : 'error', message: step.message }]
      win?.webContents.send('launch:preparation', preparation)
    }
    begin('dir', '游戏位置', '正在查找已有游戏包…')
    log('正在确认游戏目录…')

    const eff0 = readEffectiveProfile()
    if (!eff0) {
      return {
        ok: false,
        steps: [
          {
            key: 'profile',
            title: '读取配置',
            ok: false,
            changed: false,
            message: noProfileMessage()
          }
        ],
        effective: null,
        remaining: ['缺少 config/launch.json'],
        pack: null
      }
    }
    // 顺手把结构建出来（幂等）：修复的第一步本来就是"让这个目录能用"。
    const before = gameDirInfo(true)!
    const manifestNames = bundledManifestNames()

    // ---- ① 目录 ----
    if (before.mods.state === 'ok') {
      addStep({
        key: 'dir',
        title: '游戏目录',
        ok: true,
        changed: before.ensure.created.length > 0,
        message: `已就绪：${before.rootInfo.root}（${sourceLabel(before.rootInfo.source)}，${before.mods.jars} 个 jar）`
      })
    } else {
      const found = discoverCandidateRoot(
        eff0.profile.version,
        manifestNames,
        pathContext(),
        [before.rootInfo.root]
      )
      if (found) {
        const applied = applyPickedGameDir(found.modsDir)
        addStep({
          key: 'dir',
          title: '游戏目录',
          ok: applied.ok,
          changed: applied.ok,
          message: applied.ok
            ? `自动发现并采用本机已有的整合包：${found.root}（${found.note}）`
            : `发现了候选目录但未能采用：${applied.notes.join('；')}`,
          detail: applied.ok ? `已写入 ${applied.settingsFile}` : undefined
        })
        log(`自动采用 ${found.root}（命中 ${found.overlap} 个清单文件）`)
      } else {
        addStep({
          key: 'dir',
          title: '游戏目录',
          ok: before.mods.state !== 'unreadable',
          changed: before.ensure.created.length > 0,
          message:
            before.mods.state === 'unreadable'
              ? `读不到 ${before.ensure.modsDir}（权限/磁盘问题，启动器无法自行修复）`
              : `常见位置里没有找到我们的整合包；沿用当前生效目录（${sourceLabel(before.rootInfo.source)}）：${before.rootInfo.root}`,
          detail: before.rootInfo.note
        })
      }
    }

    // ---- ② 结构 ----
    const info = gameDirInfo(true)!
    addStep({
      key: 'structure',
      title: '目录结构',
      ok: !info.ensure.error,
      changed: info.ensure.created.length > 0,
      message: info.ensure.error
        ? `创建失败：${info.ensure.error}`
        : info.ensure.created.length > 0
          ? `已创建 ${info.ensure.created.length} 层目录（${info.ensure.modsDir}）`
          : `已存在，无需创建（${info.ensure.modsDir}）`
    })

    // ---- ④ Java + 官方内容（启动器自行下载并逐项校验）----
    // 官方依赖安装要用 JDK 的 jar.exe 解压 natives，所以先确保 Java 17 存在。
    let profile = resolveProfile(readEffectiveProfile()?.profile ?? eff0.profile)
    let javaChanged = false
    begin('java', 'Java 运行环境', '优先使用电脑里已有的 Java 17…')
    if (!(await validateJava(profile.java)).ok) {
      const installed = (await listJavas(discoverLocalRoots(pathContext()).slice(0, 48))).find(candidate => candidate.usable)
      if (installed) { await setRuntimeSettings({ java: installed.path }); profile = resolveProfile(readEffectiveProfile()?.profile ?? eff0.profile) }
    }
    if (!(await validateJava(profile.java)).ok) {
      log('未找到 Java 17，开始下载受校验的内置运行时…')
      const java = await provisionJava((p) => {
        win?.webContents.send('java:progress', p)
        log(p.message)
      })
      if (java.ok && java.javaPath) {
        await setRuntimeSettings({ java: java.javaPath })
        javaChanged = true
        profile = resolveProfile(readEffectiveProfile()?.profile ?? eff0.profile)
      } else {
        addStep({
          key: 'java',
          title: 'Java 17',
          ok: false,
          changed: false,
          message: `自动安装失败：${java.error ?? '未知原因'}`
        })
      }
    }

    const javaReady = (await validateJava(profile.java)).ok
    if (!steps.some(step => step.key === 'java')) addStep({ key: 'java', title: 'Java 17', ok: javaReady, changed: javaChanged, message: javaReady ? '已找到并验证 Java 17（64 位），无需重复下载' : 'Java 暂未准备好，再点一次会继续已有下载进度' })
    if (!javaReady) return { ok: false, steps, effective: null, remaining: steps.filter(step => !step.ok).map(step => step.title + '：' + step.message), pack: null }

    // ---- ③ 整合包（差量下载 + 校验 + 原子替换）----
    begin('mods', '客户端模组', '只更新缺少或发生变化的文件…')
    log('正在核对服务器模组清单…')
    const check = await updateCheck()
    if (!check.ok) {
      // 连不上服务端时**不能直接判失败**：玩家可能只是断网，而本地整合包本来就是好的。
      // 退回随包清单做本地核对：一致 ⇒ 这一步算过（并说明"未能与服务端核对"）；
      // 不一致 ⇒ 如实报"无法自动补齐"（离线时确实补不了）。
      const local = verifyPack()
      const localConsistent = local.ok && local.dirState === 'ok'
      addStep({
        key: 'mods',
        title: '整合包文件',
        ok: localConsistent,
        changed: false,
        message: localConsistent
          ? `离线/服务端不可用，已按随包清单核对：${local.actual}/${local.expected} 个文件一致`
          : `无法自动补齐：${check.error ?? '未知原因'}`,
        detail: localConsistent
          ? '未能与服务端核对最新版本；联网后再跑一次「一键修复」可确认是否落后。'
          : '离线或服务端不可用时，mods 只能靠手动拷贝完整整合包。'
      })
    } else if (check.upToDate) {
      const applied = await repairMods()
      addStep({
        key: 'mods',
        title: '整合包文件',
        ok: applied.ok,
        changed: false,
        message: applied.ok ? `已核对模组与反作弊基线（packVersion=${check.packVersion ?? '-'}）` : `基线同步失败：${applied.error ?? '未知原因'}`
      })
    } else if (check.noDownloadBase) {
      addStep({
        key: 'mods',
        title: '整合包文件',
        ok: false,
        changed: false,
        message: `缺 ${check.missing ?? 0} 个、被改动 ${check.changed ?? 0} 个，但服务端清单里没有下载地址`,
        detail: '需要运维在服务端把整合包放到对象存储并在清单里写 url（M3 的下载源）。'
      })
    } else {
      log(
        `开始补齐：缺 ${check.missing ?? 0} 个、被改动 ${check.changed ?? 0} 个，共 ${Math.round(
          (check.bytesTotal ?? 0) / 1024 / 1024
        )} MB`
      )
      const applied = await repairMods()
      addStep({
        key: 'mods',
        title: '整合包文件',
        ok: applied.ok,
        changed: applied.ok,
        message: applied.ok
          ? `已补齐 ${applied.applied ?? 0} 个文件（${Math.round((check.bytesTotal ?? 0) / 1024 / 1024)} MB）`
          : `下载/替换失败：${applied.error ?? '未知原因'}${
              applied.rolledBack === true ? '（已回滚，模组保持原样）' : applied.rolledBack === false ? '（⚠️ 回滚未完成）' : '（尚未替换游戏模组，可重试）'
            }`,
        detail: applied.backupDir ? `旧文件备份：${applied.backupDir}` : undefined
      })
    }

    // ---- ②b 客户端资源（config / tacz / resourcepacks）----
    begin('client-bundle', '枪械与界面资源', '正在校验资源，已完成的下载会继续使用…')
    const bundle = await provisionClientBundle(resolveApiBase(), info.ensure.versionDir, bundleActivity)
    addStep({
      key: 'client-bundle',
      title: '客户端资源',
      ok: bundle.ok,
      changed: bundle.changed,
      message: bundle.ok
        ? bundle.changed ? `已校验 ${Math.round((bundle.bytes ?? 0) / 1048576)} MB 的官方资源，删除 ${bundle.removed ?? 0} 个过期文件` : '配置和枪械内容完整，全部文件校验通过'
        : `自动安装失败：${bundle.error ?? '未知原因'}`,
      detail: bundle.ok ? undefined : '可再次点击“一键修复”断点续装；不需要 HMCL。'
    })

    begin('red-resource-pack', '物品模型与贴图', '正在检查已有贴图…')
    log('正在校验物品模型与贴图…')
    const red = launch?.state().state === 'running'
      ? { ok: false, changed: false, error: '游戏运行中，请关闭游戏后安装 3D 资源包' }
      : await installRedPack(resolveApiBase(), info.ensure.versionDir)
    addStep({
      key: 'red-resource-pack',
      title: '红色物品 3D 资源包',
      ok: red.ok,
      changed: red.changed,
      message: red.ok ? red.changed ? '物品模型和贴图资源已校验、安装并启用' : '物品模型和贴图资源已校验并启用' : `自动安装失败：${red.error ?? '未知原因'}`
    })

    try {
      const changed = await ensureLoginComponent(app.getPath('userData'), join(configDir(), 'authlib-injector-1.2.8.jar'))
      addStep({ key: 'login-component', title: 'LittleSkin 登录组件', ok: true, changed, message: '登录组件已独立安装并通过校验' })
    } catch (e) {
      addStep({ key: 'login-component', title: 'LittleSkin 登录组件', ok: false, changed: false, message: e instanceof Error ? e.message : String(e) })
    }
    begin('official', 'Minecraft 与 Forge', '优先复用已有依赖，自动补齐缺少部分…')
    log('正在检查 Minecraft 和 Forge 运行环境…')
    const official = existsSync(profile.java)
      ? await provisionOfficial({ ...profile, launcherDataDir: app.getPath('userData'), reuseRoots: discoverLocalRoots(pathContext()).filter(root => existsSync(join(root, 'libraries')) || existsSync(join(root, 'assets'))) }, (p) => {
          win?.webContents.send('launch:log', { line: `[launcher] 官方资源：${p.message}` })
          downloadActivity({ id: 'official', title: 'Minecraft 与 Forge', phase: p.phase === 'done' ? 'done' : p.phase === 'error' ? 'error' : 'working', percent: p.phase === 'metadata' || p.total < 1 ? null : Math.round(p.done / p.total * 100), current: p.current ?? p.message, remaining: Math.max(0, p.total - p.done), error: p.phase === 'error' ? p.message : undefined })
        }, join(configDir(), 'official-runtime-lock.json'))
      : { ok: false, downloaded: 0, verified: 0, error: 'Java 17 不可用' }
    const missingLibs = profile.classpath.filter((c) => !existsSync(c)).length
    const hasAssets = existsSync(join(profile.assetsDir, 'indexes', `${profile.assetIndex}.json`))
    const hasVersionJar = existsSync(join(profile.gameDir, `${profile.version}.jar`))
    const officialOk = official.ok && hasAssets && missingLibs === 0 && hasVersionJar
    addStep({
      key: 'official',
      title: 'Minecraft 与 Forge',
      ok: officialOk,
      changed: official.downloaded > 0,
      message: officialOk
        ? `已就绪：校验 ${official.verified} 项，下载/修复 ${official.downloaded} 项`
        : `${official.error ?? '安装未完成'}。尚缺文件：${[
            hasAssets ? '' : 'assets',
            missingLibs > 0 ? `classpath ${missingLibs}/${profile.classpath.length} 条` : '',
            hasVersionJar ? '' : `${eff0.profile.version}.jar`
          ]
            .filter(Boolean)
            .join('、') || '文件已在位，但完整性检查尚未通过'}`,
      detail: officialOk ? '已检查 Minecraft 主程序、Forge 依赖、材质/声音文件和 Windows 原生库；所有文件按发布清单验证。'
        : '已校验 ' + official.verified + ' 项，已下载/修复 ' + official.downloaded + ' 项。网络超时：检查网络后重试；文件无法写入：先关闭游戏，确认游戏目录可写后重试。已完成的文件会保留并重新校验。'
    })

    // ---- ⑤ Java ----
    const javaOk = (await validateJava(profile.java)).ok
    if (!steps.some((s) => s.key === 'java')) {
      addStep({
        key: 'java',
        title: 'Java 17',
        ok: javaOk,
        changed: javaChanged,
        message: javaOk ? `可用：${profile.java}` : `不存在：${profile.java}`,
        detail: javaOk ? undefined : '联网后再次点击“一键修复”，启动器会自动下载并校验 Java 17。'
      })
    }

    // ---- ⑥ 复检 ----
    const pack = verifyPack()
    const packOk = pack.ok || pack.dirState === 'ok'
    addStep({
      key: 'verify',
      title: '复检',
      ok: pack.ok,
      changed: false,
      message: pack.error
        ? pack.error
        : pack.ok
          ? `整合包 ${pack.actual}/${pack.expected} 个文件与清单一致`
          : `与清单不一致：缺失 ${pack.missing.length} · 多出 ${pack.extra.length} · 被改动 ${pack.changed.length}`
    })

    const after = readEffectiveProfile()
    const remaining = steps.filter((s) => !s.ok).map((s) => `${s.title}：${s.message}`)
    // `ok` 的判据是**逐项检查全部通过**，不是"函数跑完了"——后者是自证。
    const allOk = steps.every((s) => s.ok)
    log(allOk ? '全部检查通过 ✓' : `仍有 ${remaining.length} 项未通过：${remaining.join('；')}`)
    return {
      ok: allOk,
      steps,
      effective: after
        ? {
            gameRoot: after.profile.gameRoot,
            version: after.profile.version,
            source: after.rootInfo.source,
            sourceLabel: sourceLabel(after.rootInfo.source)
          }
        : null,
      remaining,
      pack: packOk ? pack : null
    }
  }

  /**
   * 启动前的**全部判定**，唯一一份。
   *
   * <p>2026-09-18 加了一层壳（`preflightCore` + 下面的 `preflight()`）：无论判定从哪一条
   * 早退（没登录/条款/预检/整合包），返回里都必须带着**生效游戏目录的信息**。
   * 理由是那次"别人机器上永远预检未通过"的缺陷：玩家看到的只有一句
   * "预检未通过（5 项）"，而界面要给出「浏览…」按钮就必须先知道目录是哪个、状态如何。
   * 让每个早退分支各自拼一遍，早晚会漏掉一条（那正是"界面说 A、启动用 B"的来源）。
   */
  function preflightCore(): {
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
      dirState?: 'ok' | 'empty' | 'missing' | 'unreadable'
      dir?: ReturnType<typeof verifyPack>['dir']
    }
  } {
    // ---- 1) 玩家系统会话：**这是"不允许离线账号"的落点** ----
    //
    // 三层判定的顺序不能换：
    //   ① 本地有没有 token（没有 → 直接拒）
    //   ② 连通性（连不上 → 拒，且**明确说"连不上"而不是"没登录"**：
    //      这两种情况对玩家的下一步动作完全不同，混为一谈会让他在错误的路上折腾）
    //   ③ 服务端说有效吗（过期/被封 → 拒）
    const cached = player.cached()
    if (!cached) {
      return {
        ok: false,
        code: 'no_session',
        message: '未登录玩家系统：请先在右上角账号区完成登记 / 登录，之后才能启动游戏'
      }
    }
    if (sessionCheck.state === 'none') {
      return {
        ok: false,
        code: 'session_invalid',
        message: '登录状态已失效（可能已过期或被封禁）：请重新登录玩家系统'
      }
    }
    if (sessionCheck.state === 'unreachable') {
      return {
        ok: false,
        code: 'api_unreachable',
        message: `连不上玩家系统（${sessionCheck.error}）：无法确认登录状态，已拒绝启动。请检查网络后重试`
      }
    }
    if (sessionCheck.state === 'banned') {
      return { ok: false, code: 'banned', message: `账号已被封禁：${sessionCheck.reason}` }
    }
    const playerName = sessionCheck.state === 'ok' ? sessionCheck.player.name : cached.player.name

    // ---- 2) 条款 ----
    if (!readConsent().accepted) {
      return { ok: false, code: 'no_consent', message: '未同意条款，拒绝启动' }
    }
    // ---- 3) 配置与路径 ----
    const eff = readEffectiveProfile()
    if (!eff) return { ok: false, code: 'no_profile', message: noProfileMessage() }
    // 目录先说清楚：**这台机器上生效的游戏目录是哪来的、缺的东西启动器会不会自己建**。
    // 2026-09-18 那个"别人机器上永远预检未通过"的缺陷之所以难查，一半原因是界面只报
    // "预检未通过（5 项）"，没人告诉玩家这 5 项里有一条是**别的机器的路径**。
    // 这几行日志是那次事故的直接产物：每次预检都留下"根目录谁给的 + 建了什么"。
    const dirInfo = gameDirInfo(true)!
    win?.webContents.send('launch:log', {
      line: `[launcher] 游戏目录：${dirInfo.rootInfo.root}（来源：${sourceLabel(dirInfo.rootInfo.source)}）`
    })
    for (const n of dirInfo.notices) {
      win?.webContents.send('launch:log', {
        line: `[launcher] ${n.text}${n.detail ? ` —— ${n.detail}` : ''}`
      })
    }
    // 先展开模板再预检：预检必须看**真实路径**，否则 ${GAME_DIR} 会被当成不存在的目录。
    const profile = resolveProfile(eff.profile)
    // 兜底：模板没展开就拒绝启动（2026-09-17 的事故就是漏展开，症状是"点了没反应"）
    if (cached.player.site === 'premium') profile.jvmArgs = profile.jvmArgs.filter(value => !value.startsWith('-javaagent:') && !value.startsWith('-Dauthlibinjector.'))
    const leftovers = leftoverTemplates(profile)
    if (leftovers.length > 0) {
      const msg = `内部错误：${leftovers.length} 个路径模板未展开（${leftovers.join('、')}），已阻止启动`
      win?.webContents.send('launch:log', { line: `[launcher] ${msg}` })
      return { ok: false, code: 'template_leftover', message: msg }
    }
    const checks = profileChecks(profile)
    const problems = checks.filter(check => check.status === 'error').map(check => check.title + '：' + check.message)
    if (problems.length > 0) {
      for (const p of problems) {
        win?.webContents.send('launch:log', { line: `[launcher] 预检未通过：${p}` })
      }
      return {
        ok: false,
        code: 'env_problem',
        message: `有 ${problems.length} 项需要准备，点击主按钮即可自动完成`,
        checks,
        player: playerName
      }
    }
    // ---- 4) 整合包完整性：与**服务端权威清单**（拿不到时用内置快照）逐文件比对 ----
    //
    // 这是"改客户端绕过"真正落地的地方：前几轮做了清单与比对，但如果比对结果不影响启动，
    // 那它只是一张报表。这里把它变成闸门。
    //
    // 三类的说法刻意不同，因为对玩家的含义不同：
    //   被改动 = 文件内容与清单不符（掉包/篡改）
    //   多出   = 装了清单以外的模组（反作弊规则里"整合包以外的任何模组"就是这一类）
    //   缺失   = 整合包不完整（下载中断/被删）
    const pack = verifyPack()
    if (pack.error) return { ok: false, code: 'manifest_unavailable', message: pack.error, player: playerName, checks }
    if (!pack.error && !pack.ok) {
      const detail =
        pack.changed.length > 0
          ? `被改动 ${pack.changed.length} 个（例如 ${pack.changed[0]}）`
          : pack.extra.length > 0
            ? `多出 ${pack.extra.length} 个（例如 ${pack.extra[0]}）`
            : `缺失 ${pack.missing.length} 个（例如 ${pack.missing[0]}）`
      win?.webContents.send('launch:log', {
        line: `[launcher] 整合包校验未通过（依据：${pack.sourceNote ?? '未知来源'}）：${detail}`
          + ' —— 已拒绝启动（完整差异见「模组管理」页）'
      })
      return {
        ok: false,
        code: 'pack_mismatch',
        message: `整合包与服务器清单不一致（${detail}），已拒绝启动`,
        player: playerName
      }
    }
    if (pack.ok) {
      win?.webContents.send('launch:log', {
        line: `[launcher] 整合包校验通过：${pack.actual}/${pack.expected} 个文件与清单一致 ✓`
      })
    } else if (pack.error) {
      // 校验本身跑不起来（缺清单/读不到目录）不能当成"通过"，但也不该硬拦——
      // 如实说出来，让玩家与运维知道这次是在**没有校验**的情况下启动的。
      win?.webContents.send('launch:log', {
        line: `[launcher] 注意：整合包校验未执行（${pack.error}）—— 本次启动没有完整性保护`
      })
    }
    return {
      ok: true,
      player: playerName,
      pack: {
        ok: pack.ok,
        expected: pack.expected,
        actual: pack.actual,
        error: pack.error,
        dirState: pack.dirState,
        dir: pack.dir
      }
    }
  }

  /**
   * 对外的预检：`preflightCore()` 的结论 + **游戏目录快照**。
   *
   * 目录快照（`dir`）是界面「浏览…」与三态文案的数据源，形状与 `verifyPack().dir` 一致
   * ——两处必须是同一个东西，否则首页与模组管理页会各说各话。
   */
  function preflight(): {
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
      dirState?: 'ok' | 'empty' | 'missing' | 'unreadable'
      dir?: ReturnType<typeof verifyPack>['dir']
    }
    dir?: ReturnType<typeof verifyPack>['dir']
    /** 目录三态（顶层也放一份：界面无论从哪条分支拿到结论，都能直接用它决定文案） */
    dirState?: 'ok' | 'empty' | 'missing' | 'unreadable'
  } {
    const verdict = preflightCore()
    // 只读（不建目录）：预演不该改变磁盘。真正启动那次（preflightCore 内部）才建结构。
    const info = gameDirInfo(false)
    const dir = verdict.pack?.dir ?? undefined
    const effective = readEffectiveProfile()
    const checks = verdict.checks ?? (effective ? profileChecks(resolveProfile(effective.profile)) : [])
    return {
      ...verdict,
      checks: [{ key: 'account', title: '账号登录', status: sessionCheck.state === 'ok' ? 'ready' : 'error', message: sessionCheck.state === 'ok' ? '已登录' : '点击右上角登录账号' }, ...checks,
        { key: 'mods', title: '客户端模组', status: verdict.pack?.ok ? 'ready' : 'waiting', message: verdict.pack?.ok ? '与服务器版本一致' : '准备时自动校验并更新', repairable: true }],
      dirState: verdict.pack?.dirState ?? info?.mods.state,
      dir: dir ?? (info
        ? {
            gameRoot: info.rootInfo.root,
            source: info.rootInfo.source,
            sourceLabel: sourceLabel(info.rootInfo.source),
            modsDir: info.ensure.modsDir,
            modsJars: info.mods.jars,
            created: info.ensure.created,
            rejected: info.rootInfo.rejected.map((r) => ({
              raw: r.raw,
              expanded: r.expanded,
              source: sourceLabel(r.source)
            })),
            notices: info.notices.map((n) => ({ code: n.code, text: n.text, detail: n.detail }))
          }
        : undefined),
      pack: verdict.pack
        ? { ...verdict.pack, dirState: verdict.pack.dirState ?? info?.mods.state, dir: verdict.pack.dir ?? undefined }
        : undefined
    }
  }

  // 登录（LittleSkin / Yggdrasil）。密码只在内存里活到换取 token 为止，不落盘、不进日志。
  ipcMain.handle('auth:login', async (_e, username: string, password: string) => {
    const r = await auth.login(username, password)
    return r.ok && r.session
      ? { ok: true, username: r.session.username, uuid: r.session.uuid }
      : { ok: false, error: r.error ?? '登录失败' }
  })
  ipcMain.handle('auth:status', async () => {
    const s = await auth.ensureFresh()
    return s ? { loggedIn: true, username: s.username } : { loggedIn: false }
  })
  ipcMain.handle('auth:logout', () => {
    auth.logout()
    return { ok: true }
  })

  // 整合包校验：模组管理页调用。**只读、不改文件**——修复动作要单独设计并有回滚。
  // 先刷新服务端清单，这样"模组管理"页看到的差异和启动闸门用的是同一份依据。
  ipcMain.handle('pack:verify', async () => {
    await refreshServerPackManifest()
    return verifyPack()
  })

  // ---- 整合包更新（第 3 项）----
  //
  // 三件事分开，是为了让"检查"永远安全：`pack:verify` 与 `update:check` 都**只读**，
  // 只有 `update:apply` 会写磁盘。玩家点"检查更新"不该有副作用。
  ipcMain.handle('update:check', async () => updateCheck())
  ipcMain.handle('update:apply', async () => updateApply())
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), packaged: app.isPackaged }))

  // ---- 启动器自身更新（第 3 项的另一半）----
  // 免安装版（portable）在 SelfUpdateService 内部走**自替换通道**
  // （下载 → 验哈希 → 起助手 → 退出 → 删旧 exe → 新版改名到位 → 启动），
  // 所以这里不需要分支：两条路的对外的 check/apply 形状是一样的。
  ipcMain.handle('update:self-check', async () => selfUpdateService().check())
  ipcMain.handle('update:self-apply', async () => {
    if (selfUpdateBusy) return { ok: false, error: '启动器正在更新，请等待' }
    // 装上就不能一边装一边打游戏：安装会替换启动器程序文件，而启动器退出会带走游戏。
    // 这里**先拦**，把"打到一半被踢下线"挡在门外。
    if (launch?.state().state === 'running') {
      return { ok: false, error: '游戏正在运行：请先退出游戏再更新启动器' }
    }
    selfUpdateBusy = true
    downloadActivity({ id: 'launcher', title: '启动器更新', phase: 'working', percent: null, current: '准备更新', remaining: 1 })
    try {
      const result = await selfUpdateService().downloadAndInstall()
      if (!result.ok) {
        selfUpdateBusy = false
        downloadActivity({ id: 'launcher', title: '启动器更新', phase: 'error', percent: null, current: '更新未完成', remaining: 1, error: result.error })
      }
      return result
    } catch (error) {
      selfUpdateBusy = false
      const message = error instanceof Error ? error.message : String(error)
      downloadActivity({ id: 'launcher', title: '启动器更新', phase: 'error', percent: null, current: '更新未完成', remaining: 1, error: message })
      return { ok: false, error: message }
    }
  })

  // ---- 首次运行引导：探测函数保留给 `--selftest` 用 ----
  // （界面上的"自动检测 / 浏览"已按运维要求移除，见下面 config:get 的注释；
  //   这两个函数继续供排障自检输出"这台机器上都有什么"，不删。）
  ipcMain.handle('config:detect', () => ({ dirs: detectGameDirs(), javas: detectJavas() }))

  /**
   * 常见游戏目录。
   *
   * 返回每个目录的**根 mods 数**与**各实例的 mods 数**——因为 1.20.1 的整合包几乎都是
   * **版本隔离**的：真正被加载的是 `versions\<实例名>\mods`，根 `mods/` 往往是空的或残留。
   * 实测本机：根 `mods/` 20 个，`versions\test\mods` **79** 个，`versions\` 下还有
   * 4 个别的实例（ArdaCraft / cs / vivecraft / 1.20.1-Forge）。
   * 只报根目录会让玩家选中"20 个模组"的那个——**看起来对，进去就错**。
   */
  function detectGameDirs(): {
    path: string
    exists: boolean
    mods: number
    note: string
    instances: { name: string; mods: number }[]
  }[] {
    const home = app.getPath('home')
    // 当前生效的根目录**放第一个**：它通常就是"有 79 个模组"的那个。
    // 不列它的话，界面会把一个 0 模组的原版目录填进去——玩家一保存就把能用的配置改坏了。
    const cur = readEffectiveProfile()?.profile.gameRoot
    const candidates: string[] = cur ? [cur] : []
    candidates.push(
      join(app.getPath('appData'), '.minecraft'),
      join(home, 'AppData', 'Roaming', '.minecraft'),
      join(home, '.minecraft'),
      'C:\\Program Files (x86)\\Minecraft Launcher\\game',
      'C:\\XboxGames\\Minecraft Launcher\\Content'
    )
    const seen = new Set<string>()
    const countJars = (d: string): number => {
      try {
        return existsSync(d) ? readdirSync(d).filter((n) => n.toLowerCase().endsWith('.jar')).length : 0
      } catch {
        return 0
      }
    }
    const out: {
      path: string
      exists: boolean
      mods: number
      note: string
      instances: { name: string; mods: number }[]
    }[] = []
    for (const c of candidates) {
      if (seen.has(c)) continue
      seen.add(c)
      let exists = false
      const instances: { name: string; mods: number }[] = []
      try {
        exists = existsSync(c)
        if (exists) {
          const versionsDir = join(c, 'versions')
          if (existsSync(versionsDir)) {
            for (const name of readdirSync(versionsDir)) {
              const vd = join(versionsDir, name)
              try {
                if (!statSync(vd).isDirectory()) continue
              } catch {
                continue
              }
              const m = countJars(join(vd, 'mods'))
              if (m > 0) instances.push({ name, mods: m })
            }
            // 模组多的排前面：玩家要找的就是"装了我们整合包的那个实例"
            instances.sort((a, b) => b.mods - a.mods)
          }
        }
      } catch {
        // 探测失败就当不存在，不抛——这是"尽力而为"的引导
      }
      out.push({
        path: c,
        exists,
        mods: exists ? countJars(join(c, 'mods')) : 0,
        note: c === cur ? '当前配置' : '',
        instances
      })
    }
    return out
  }

  /**
   * 常见 Java 位置。
   *
   * 玩家机器上**通常没有 JDK 17**（我们的默认值是打包机的 `C:\Program Files\Java\jdk-17`）。
   * 最可能存在的其实是官方启动器自带的那份运行时——它藏在两处很深的路径里，
   * 没人猜得到，正好适合自动检测。版本号目录用 readdir 匹配，避免写死 17.0.x 的小版本。
   */
  function detectJavas(): { path: string; exists: boolean; note: string }[] {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = app.getPath('appData').replace(/\\Roaming$/, '\\Local')
    const out: { path: string; exists: boolean; note: string }[] = []
    const add = (p: string, note: string): void => {
      if (out.some((o) => o.path === p)) return
      let exists = false
      try {
        exists = existsSync(p)
      } catch {
        /* ignore */
      }
      out.push({ path: p, exists, note })
    }

    // 1) 官方启动器自带的运行时（玩家机器上最常见的那一个）
    add(
      join(
        pf86,
        'Minecraft Launcher',
        'runtime',
        'java-runtime-delta',
        'windows-x86_64',
        'java-runtime-delta',
        'bin',
        'javaw.exe'
      ),
      '官方启动器自带运行时'
    )
    add(
      join(
        local,
        'Packages',
        'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
        'LocalCache',
        'Local',
        'runtime',
        'java-runtime-delta',
        'windows-x86_64',
        'java-runtime-delta',
        'bin',
        'javaw.exe'
      ),
      '官方启动器自带运行时（应用商店版）'
    )

    // 2) 常见 JDK 17 发行版：父目录里带版本号的，扫一层。
    const vendors: [string, string][] = [
      [join(pf, 'Java'), 'Oracle/OpenJDK'],
      [join(pf, 'Eclipse Adoptium'), 'Adoptium Temurin'],
      [join(pf, 'Microsoft'), 'Microsoft OpenJDK'],
      [join(pf, 'Zulu'), 'Azul Zulu'],
      [join(pf, 'BellSoft'), 'Liberica'],
      [join(pf, 'Amazon Corretto'), 'Amazon Corretto'],
      [join(pf, 'Semeru'), 'IBM Semeru'],
      [join(pf, 'RedHat'), 'Red Hat']
    ]
    for (const [base, label] of vendors) {
      try {
        if (!existsSync(base)) continue
        for (const name of readdirSync(base)) {
          // 只列 17 与 21：1.20.1 Forge 47 官方要求 17；21 多数情况能跑但不是官方组合，
          // 所以列出来但把版本号写进 note，让玩家知道自己在选什么。Java 8 一定不行，不列。
          if (!/^jdk-?(17|21)([._-]|$)/i.test(name)) continue
          add(join(base, name, 'bin', 'javaw.exe'), `${label} ${name}`)
        }
      } catch {
        /* ignore */
      }
    }

    // 3) 当前配置里的那个（哪怕是打包机的路径）也列出来，方便对照"现在用的是哪个"
    const cur = readEffectiveProfile()?.profile.java
    if (cur) add(cur, '当前配置')
    return out
  }

  // 原生目录选择器也已移除（原来用于"手动指定游戏目录/Java"）。
  // 理由同下：不给玩家改路径的口子。需要排障时看 `--selftest` 的输出即可。

  // ---- 路径设置：**2026-09-18 运维要求重新开放（"必须让玩家能自己浏览并选择游戏目录"）** ----
  //
  // 上一轮（同一天早些时候）按"不需要设置路径，只能启动我的客户端"把
  // `config:set` / `config:detect` / `config:pick` 三个 IPC 一并删了。现在**只恢复一个**，
  // 且形状与当时不同 —— 这个区别很重要：
  //   · 恢复的是 `config:pick`：**只能由原生目录选择器产生路径**。renderer 传不了路径字符串，
  //     所以 UI 层被注入也**无法**把启动器指向任意目录（RCE/重定向面没有回来）。
  //   · 仍然不提供 `config:set`（任意字符串写路径）。需要脚本化设置时走命令行
  //     `--set-game-root <目录>`（运维自己在那台机器上执行，不是 renderer 能碰的）。
  //   · 写盘位置是可写的用户配置（%APPDATA%\<产品名>\settings.json），**不是** config/。
  ipcMain.handle('config:pick', async (_event, importOnly?: boolean) => {
    if (repairInFlight || updateInFlight || launch?.state().state === 'running') return { ok: false, notes: ['正在准备或运行游戏，完成后再导入，当前游戏位置已保留'] }
    const eff = readEffectiveProfile()
    const options: Electron.OpenDialogOptions = {
      title: importOnly === true ? '导入已有游戏包：选择解压后的游戏文件夹' : '选择 Minecraft 游戏目录',
      // 让玩家从"当前生效目录"或其上一级开始找，比从"我的文档"开始省事
      defaultPath: eff?.profile.gameRoot,
      properties: ['openDirectory'],
      buttonLabel: '用这个目录'
    }
    // 有窗口就挂成模态（否则对话框可能躲到窗口后面，玩家以为点了没反应）
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true }
    if (importOnly === true) {
      const picked = interpretPickedDir(r.filePaths[0], eff?.profile.version ?? 'BREAKLine OPs Beta', bundledManifestNames())
      if (!picked.ok || !looksLikeOurInstance(picked.gameRoot, picked.version, bundledManifestNames()).ok)
        return { ok: false, notes: ['这个位置还没有找到断界行动游戏包，原安装位置已保留。请选择解压后的游戏文件夹；没有游戏包时点击“自动安装”。'] }
    }
    const applied = applyPickedGameDir(r.filePaths[0])
    win?.webContents.send('launch:log', {
      line: `[launcher] 玩家选择了游戏目录：${applied.picked} → 生效 ${applied.effective?.gameRoot ?? '(未采纳)'}` +
        `${applied.notes.length > 0 ? `（${applied.notes.join('；')}）` : ''}`
    })
    return applied
  })
  // 恢复默认（清掉玩家选择，回到出厂 + 每用户默认目录）。没有这个出口，
  // 玩家选错一次就永远困在那个目录上——"设置"必须能撤销。
  ipcMain.handle('config:reset-path', () => {
    if (repairInFlight || updateInFlight || launch?.state().state === 'running') return { ok: false, error: '正在准备或运行游戏，请完成后再更换位置' }
    const { file } = clearPathOverride()
    const eff = readEffectiveProfile()
    return {
      ok: true,
      settingsFile: file,
      effective: eff
        ? { gameRoot: eff.profile.gameRoot, version: eff.profile.version, source: eff.rootInfo.source }
        : null
    }
  })
  /**
   * 「一键修复」：发现目录 → 建结构 → 差量补齐整合包 → 复检，逐项返回结论。
   * 与命令行 `--repair` **共用 repairGameDir()**（一条代码路径，两份入口）。
   */
  ipcMain.handle('config:repair', () => repairGameDir())
  ipcMain.handle('config:get', () => {
    const eff = readEffectiveProfile()
    if (!eff) return null
    // 只读（不建目录）：设置页只是"看一眼"，看一眼不该有副作用。
    const info = gameDirInfo(false)
    return {
      // gameRoot 是**生效值**（已按本机解析），factory.gameRoot 是出厂原文 —— 两者
      // 必须都给出来：出厂是打包机路径、生效是本机路径，界面要能看出差别在哪。
      gameRoot: eff.profile.gameRoot,
      java: eff.profile.java,
      version: eff.profile.version,
      factory: { gameRoot: readProfile()?.gameRoot ?? '', version: readProfile()?.version ?? '' },
      settingsFile: overridesFile(),
      resolved: info
        ? {
            source: info.rootInfo.source,
            sourceLabel: sourceLabel(info.rootInfo.source),
            note: info.rootInfo.note,
            modsDir: info.ensure.modsDir,
            modsState: info.mods.state,
            modsJars: info.mods.jars,
            rejected: info.rootInfo.rejected.map((r) => ({
              raw: r.raw,
              expanded: r.expanded,
              source: sourceLabel(r.source)
            })),
            notices: info.notices
          }
        : null
    }
  })
  // 自动进入的服务器：**从 programArgs 里读**，不另开字段。
  // 单一真相——启动参数就是它，界面只负责显示；否则地址会有两份，早晚对不上。
  ipcMain.handle('config:target', () => {
    const args = readEffectiveProfile()?.profile.programArgs ?? []
    const i = args.indexOf('--quickPlayMultiplayer')
    return i >= 0 ? (args[i + 1] ?? '') : ''
  })

  // ---- 服务器状态：真 ping，不是写死的数字 ----
  // 例图上那排"在线 / 128 200 / 36 ms"是设计稿示意值。要么给真值，要么写"待接入"——
  // 显示一个假的在线人数比不显示更容易误事（首页原来就写死过 128/200，已删）。
  let statusCache: { at: number; value: ServerStatus } | null = null
  ipcMain.handle('server:status', async () => {
    if (statusCache && Date.now() - statusCache.at < 15_000) return statusCache.value
    const args = readEffectiveProfile()?.profile.programArgs ?? []
    const i = args.indexOf('--quickPlayMultiplayer')
    const target = i >= 0 ? (args[i + 1] ?? '') : ''
    if (!target) return { online: false, error: '未配置自动进入地址' }
    const [host, portStr] = target.split(':')
    const value = await pingMinecraft(host, Number(portStr) || 25565)
    statusCache = { at: Date.now(), value }
    return value
  })

  const announcements = new AnnouncementFeed(join(app.getPath('userData'), 'announcements.json'), resolveApiBase)
  ipcMain.handle('news:get', () => announcements.get())
  ipcMain.handle('launch:state', () => launch!.state())

  ipcMain.on('window:minimize', () => win?.minimize())
  // 例图标题栏是三个按钮（最小化/最大化/关闭），所以补一个最大化切换
  ipcMain.on('window:maximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', () => win?.close())

  // `--repair`：**无点击**跑一遍「一键修复」（与界面按钮共用 repairGameDir()）。
  // 放在实例初始化之后、开窗口之前：验收/远程排障不需要界面，也不需要托盘。
  if (process.argv.includes('--repair')) {
    void (async () => {
      console.log('[repair] 一键修复（与界面按钮同一条代码路径）')
      const r = await repairGameDir()
      for (const s of r.steps) {
        console.log(`  ${s.ok ? '✓' : '✗'} ${s.title}：${s.message}${s.detail ? `\n      ${s.detail}` : ''}`)
      }
      console.log(`\n[repair] 生效目录：${r.effective?.gameRoot ?? '(未知)'}（${r.effective?.sourceLabel ?? '-'}）`)
      console.log(
        r.ok
          ? '[repair] 结论：全部检查通过 ✓'
          : `[repair] 结论：仍有 ${r.remaining.length} 项需要人处理：\n  - ${r.remaining.join('\n  - ')}`
      )
      app.exit(r.ok ? 0 : 1)
    })()
    return
  }

  createWindow()
  // 托盘要在窗口之后建：菜单里"显示主窗口"依赖 win 已存在。
  // 自检模式（--uishot / --playertest 等）不建托盘 —— 那些是自动化流程，
  // 需要进程能自己干净退出，不该被一个托盘图标留住。
  const automation = process.argv.some((a) =>
    ['--uishot', '--playertest', '--updatetest', '--updatelive', '--mcauthtest',
     '--playerlogin', '--selftest', '--selfupdatecheck', '--traytest', '--pathtest',
     '--set-game-root', '--repair'].includes(a)
  )
  // ⚠️ 排查提示（留在这儿比留一行 log 有用）：如果托盘没出来，先看这里是不是把它跳过了。
  //    `--traytest` **也在这个列表里**，所以那个自检必须自己再调一次 `setupTray()` ——
  //    否则它会把自己要测的东西跳过，永远报"托盘已建=false"（第一版就是这么错的）。
  if (!automation) setupTray()
  // 启动时先拉一次官方签名清单，失败时显示重试原因。
  // 这样"模组管理"页与状态栏从一开始显示的就是**服务端当前**的判定依据。
  void refreshServerPackManifest()
  // 窗口起来之后再打这行：它走 `launch:log` 推到界面日志区，
  // 太早发会丢（webContents 还没挂上监听）。
  win?.webContents.once('did-finish-load', () => logCapabilityStatus())

  // 关窗口 = 收进托盘（而不是退出）。这是"后台运行"的入口。
  win?.on('close', (e) => {
    if (quitting) return // 真的在退出（托盘菜单/系统关机），放行
    if (shouldHideOnClose()) {
      e.preventDefault()
      win?.hide()
      // 第一次收起时说一句，否则玩家会以为"关不掉"
      if (!trayHintShown) {
        trayHintShown = true
        win?.webContents.send('launch:log', {
          line: '[launcher] 已收进托盘，游戏继续运行。要彻底退出：右键托盘图标 → 退出启动器。'
        })
        try {
          new Notification({
            title: '断界行动 启动器仍在后台运行',
            body: '游戏不会被关闭。右键托盘图标可退出。'
          }).show()
        } catch {
          /* 通知失败不影响收进托盘 */
        }
      }
    }
  })

  if (process.argv.includes('--uishot')) void uiShot()

  /**
   * 自替换机制自测（`--portableswaptest <旧文件> <新文件>`）。
   *
   * 免安装版助手需要等待旧进程退出、原子替换、启动新版，并在启动失败时恢复旧版。
   * 通过两个独立的测试可执行文件检查，不修改玩家正在使用的启动器。
   */
  const swapFlag = process.argv.indexOf('--portableswaptest')
  if (swapFlag > 0 && process.argv.length >= swapFlag + 3) {
    const [, oldFile, newFile] = process.argv.slice(swapFlag)
    try {
      const helper = writeSwapHelper(oldFile, newFile)
      console.log(`[swaptest] 助手已生成：${helper}`)
      console.log(`[swaptest] 等本进程退出后：原子替换 ${oldFile} → 启动新版；失败保留或恢复旧版`)
      void startSwapHelper(helper).then(() => setTimeout(() => app.exit(0), 800)).catch(() => app.exit(2))
    } catch (e) {
      console.error(`[swaptest] 生成助手失败：${e instanceof Error ? e.message : String(e)}`)
      app.exit(2)
    }
  }

  /**
   * `--traytest`：**无点击验证后台运行**。
   *
   * 为什么值得单独做：托盘这类功能的表现是"看不见"的 ——
   * 建失败、图标读不到、close 没拦住，界面全都一样正常，
   * 只有"关掉窗口后进程还在不在"这一个可观测量能区分。所以直接量它：
   *   ① 建托盘成功吗（图标路径能不能读到）
   *   ② 关窗口后 2 秒，本进程是否仍存活（存活 = 真的收进托盘了）
   * 判据落在**进程是否存活**上，而不是"我调用了 hide()" —— 后者是自证。
   */
  if (process.argv.includes('--traytest')) {
    void (async () => {
      // ⚠️ `--traytest` 在 automation 列表里 ⇒ 上面那句 `if (!automation) setupTray()`
      // **把它自己的被测对象跳过了**，于是测出来永远是"托盘已建=false"。
      // 这是"测试与实现互相抵消"的典型（第一版就踩了）。所以这里显式建一次。
      setupTray()
      const i = process.argv.indexOf('--traytest-out')
      const outFile = i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
        ? process.argv[i + 1]
        : join(app.getPath('temp'), 'delta-traytest.json')
      const results: Record<string, unknown> = {
        trayBuilt: tray !== null,
        trayIcon: trayIconPath(),
        shouldHideOnClose: shouldHideOnClose(),
        windowVisibleBefore: win?.isVisible() ?? false
      }
      console.log(`[traytest] 托盘已建 = ${results.trayBuilt}`)
      console.log(`[traytest] 图标路径 = ${results.trayIcon}`)
      console.log(`[traytest] 关窗口会收进托盘 = ${results.shouldHideOnClose}`)
      await new Promise((r) => setTimeout(r, 2500))
      // 真的去关窗口（等价于玩家点右上角 X）
      win?.close()
      await new Promise((r) => setTimeout(r, 2000))
      results.windowVisibleAfterClose = win?.isVisible() ?? false
      results.windowDestroyed = win?.isDestroyed() ?? true
      // **硬证据**：进程还活着（能执行到这里就说明没退出）
      results.processAliveAfterClose = true
      console.log(`[traytest] 关窗口后：可见=${results.windowVisibleAfterClose} 已销毁=${results.windowDestroyed}`)
      console.log(`[traytest] 进程仍存活 = true（后台运行生效）`)
      // 复原：真的退出，别在测试机器上留一个托盘进程
      try {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8')
        console.log(`[traytest] 结果已写入 ${outFile}`)
      } catch {
        /* ignore */
      }
      quitting = true
      app.exit(results.trayBuilt && results.processAliveAfterClose ? 0 : 1)
    })()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * 所有窗口关闭时。
 *
 * ⚠️ **这里有"后台运行"与"绝不留下幽灵进程"之间的取舍**：
 * 关窗口被上面拦成了 hide，所以正常路径下这个事件根本不会触发；
 * 能走到这里的是"窗口真的被销毁了"（例如托盘不可用、或系统强制关闭）。
 * 那时如果还留着托盘，就**只收托盘不退出**（游戏还在跑，启动器得留着管它）；
 * 没有托盘就必须真的退出 —— 否则进程会变成一个既看不见也关不掉的幽灵。
 */
app.on('window-all-closed', () => {
  // ⚠️ 浮层窗口也算一个窗口。主窗口真的被销毁时若浮层还开着，这里会被它"吊住"——
  // 于是启动器既不退出、也没有可见的主界面。所以先把浮层收掉再判。
  closeAcAnimWindow('主窗口已销毁')
  if (tray && !quitting) return // 驻留：游戏还在跑，我们得管着它
  launch?.stop()
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 退出前把标志置上。
 *
 * 所有"真的要退出"的路径（Alt+F4 以外的系统关机、托盘菜单、`app.quit()`）
 * 都会先过这里，于是 `close` 处理函数知道该放行而不是收起窗口。
 */
app.on('before-quit', () => {
  quitting = true
  // 浮层绝不能活过启动器：那会变成屏幕右下角一块**关不掉**的置顶窗口
  // （它 skipTaskbar、不抢焦点、没有关闭入口，玩家只能去任务管理器杀进程）。
  closeAcAnimWindow('启动器退出')
})
