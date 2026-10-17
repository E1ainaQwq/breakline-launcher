import { app } from 'electron'

import { PortableSelfUpdate } from './PortableSelfUpdate'

/**
 * 启动器**自身**更新（第 3 项的另一半）。
 *
 * <h2>为什么用它而不是自己写</h2>
 * 启动器自己是 NSIS 安装包，自更新要处理"下载安装包 → 校验 → 静默安装 → 重启"，
 * 而 electron-builder 已经把这件事做完了：打包时就会产出 `latest.yml` +
 * `.exe.blockmap`（差分），`electron-updater` 按 generic provider 拉这两个文件即可。
 * 自己重写一遍只会得到一个"看起来能更新、装完是坏的"版本。
 *
 * <h2>它和"整合包更新"是两件事，别混</h2>
 * | | 整合包更新（`UpdateService`） | 自身更新（本模块） |
 * |---|---|---|
 * | 更新什么 | `mods/` 里的 jar | 启动器程序本身 |
 * | 清单 | 我们自己的 `/api/pack/manifest` | `latest.yml`（electron-builder 产出） |
 * | 谁校验 | 我们逐文件算 sha256 | electron-updater（sha512，来自 latest.yml） |
 * | 失败后果 | 回滚，整合包保持原样 | 安装包损坏时安装失败，旧版本仍在 |
 *
 * <h2>开发环境会说"不支持"，这是刻意的</h2>
 * `app.isPackaged === false` 时更新毫无意义（改代码即生效），
 * 而且 electron-updater 在未打包状态下会抛错。所以直接返回一句人话，
 * **不假装成功**——"检查更新成功但什么也没发生"是最容易被误读成"功能好了"的状态。
 */

export interface SelfUpdateInfo {
  /** 当前启动器版本（来自 package.json） */
  currentVersion: string
  /** 是否打包版（未打包时自更新不可用） */
  packaged: boolean
  /** 是否有新版本 */
  available: boolean
  /** 新版本号（有更新时） */
  version?: string
  /** 更新说明（latest.yml / releaseNotes） */
  notes?: string
  /** 不能检查时的原因（未打包、没配 feed、连不上……） */
  error?: string
}

/**
 * 远端版本是否**严格新于**本地版本。
 *
 * 为什么不能写 `latest !== current`：那样"本地比 feed 新"（先构建后发布、或装了内测版）
 * 会被判成"有新版本"，界面于是给出一个**降级**按钮，玩家点了就真的退回旧版。
 * 逐段比较数字；段数不同按缺省 0 处理；解析不出来时保守返回 false（不提示更新）。
 */
function versionGreater(remote: string | undefined, local: string): boolean {
  if (!remote) return false
  const ra = String(remote).split('.').map((x) => Number.parseInt(x, 10))
  const la = String(local).split('.').map((x) => Number.parseInt(x, 10))
  if (ra.some((n) => Number.isNaN(n)) || la.some((n) => Number.isNaN(n))) return false
  for (let i = 0; i < Math.max(ra.length, la.length); i++) {
    const r = ra[i] ?? 0
    const l = la[i] ?? 0
    if (r !== l) return r > l
  }
  return false
}

/** 我们用到的 electron-updater 表面（结构化类型，免得为了一个类型把整个包引进来）。 */
interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  removeAllListeners: (event: string) => void
  on: (event: string, listener: (p: { percent: number; transferred?: number }) => void) => void
  checkForUpdates: () => Promise<{ updateInfo?: { version?: string; releaseNotes?: unknown } } | null>
  downloadUpdate: (token?: unknown) => Promise<unknown>
  quitAndInstall: (silent?: boolean, forceRunAfter?: boolean) => void
}

/**
 * 进程内**共享**的 updater 实例（模块级，不是每个 SelfUpdateService 一份）。
 *
 * <h2>为什么必须是模块级</h2>
 * 界面上的「检查启动器更新」与「更新到 X」是**两次 IPC**，而主进程每次都
 * `new SelfUpdateService(...)`（见 index.ts 的 `selfUpdateService()`）。
 * 所以实例级缓存等于没有缓存：`downloadUpdate()` 会在一张白纸上被调用，
 * 报 `Please check update first` —— **2026-09-18 运维截图实测**。
 *
 * 原来的代码能跑，是因为它用的是 `electron-updater` 的 `autoUpdater` 导出 ——
 * 那是个**模块级单例**。我把它换成"自己 new 一个 NsisUpdater"时，
 * 顺手把这个隐式共享弄丢了：修好了一个坑（惰性 getter 在打包版里是 undefined），
 * 又挖出另一个（两次调用不共享实例）。**教训**：换掉一个隐式约定时，
 * 要把这个约定**显式写出来**，而不是指望调用方恰好还是同一个对象。
 */
let sharedUpdater: unknown = null
let sharedUpdaterFeed = ''

function sharedUpdaterFor(feedUrl: string, make: () => unknown): unknown {
  // feed 变了就重建：换更新源之后还用旧实例会一直打旧地址。
  if (sharedUpdater && sharedUpdaterFeed === feedUrl) return sharedUpdater
  sharedUpdater = make()
  sharedUpdaterFeed = feedUrl
  return sharedUpdater
}

export class SelfUpdateService {
  /**
   * @param feedUrl `latest.yml` 与安装包所在的静态目录。为空 = 没配，检查会明确报出来。
   */
  constructor(
    private readonly feedUrl: string,
    private readonly onProgress: (p: { percent: number; message: string }) => void = () => {}
  ) {}

  version(): string {
    return app.getVersion()
  }

  /**
   * 拿到（并缓存）真正可用的 updater 实例。
   *
   * <h2>为什么不直接用 `import('electron-updater').autoUpdater`</h2>
   * 那个导出是**惰性 getter**：首次访问时才 `new NsisUpdater()`，而这条构造路径走的是
   * CommonJS 的 `require('electron').app` —— 在 electron-vite 打出的 ESM bundle 里
   * 那一步拿到的是 `undefined`，于是 `autoUpdater` 就是 `undefined`，报错为
   * `Cannot set properties of undefined (setting 'autoDownload')`。
   *
   * **2026-09-18 运维截图实测**：0.2.1 的「检查启动器更新」就是这个错。
   * 而这个坑其实早就写在 `UpdaterSelfTest` 里（那份自检之所以能过，正是因为它绕开了
   * 这个 getter）—— **知识写在了一个文件里，却没有应用到另一个文件**，于是线上照样踩。
   *
   * Windows 上 `autoUpdater` 最终也是 `NsisUpdater`，所以直接实例化它：行为一致，
   * 且不依赖那个脆弱的 getter。
   */
  private async updaterInstance(): Promise<Updater> {
    if (sharedUpdater && sharedUpdaterFeed === this.feedUrl) return sharedUpdater as Updater
    // 动态 import：electron-updater 在开发模式下会打印一堆无意义的日志，
    // 而且它不是核心路径（更新失败不该影响启动游戏），所以按需加载。
    // ⚠️ 但**不要用 `autoUpdater` 那个导出**（惰性 getter，在打包版里是 undefined）。
    const { NsisUpdater } = await import('electron-updater')
    return sharedUpdaterFor(this.feedUrl, () => {
      const created = new NsisUpdater({ provider: 'generic', url: this.feedUrl })
      created.autoDownload = false // 由玩家决定何时下载
      created.autoInstallOnAppQuit = true
      return created
    }) as Updater
  }

  /**
   * **仅供自检**：取当前会用于下载的那个 updater 实例（用于断言"两次调用是同一个对象"）。
   *
   * 为什么要暴露它：`Please check update first` 的根因是"检查与下载拿到了两个不同实例"，
   * 而这件事**没法靠行为去测** —— electron-updater 只在**真有新版本**时才记住检查结果，
   * 所以"本地版本已经比 feed 新"时，换实例下载也会报同一句话（假红）。
   * 断言**对象同一性**才是那个不变量：与版本高低无关，且正好是"两次 IPC 共用一份"。
   */
  async updaterForTest(): Promise<unknown> {
    return this.updaterInstance()
  }

  /**
   * 只查、不下载。
   *
   * 为什么把"查"和"装"分开：`checkForUpdatesAndNotify` 会自动下载并在退出时安装，
   * 那对玩家是**意外行为**（他可能正打到一半）。这里的纪律是：
   * 检查无副作用，装不装由玩家点。
   */
  async check(): Promise<SelfUpdateInfo> {
    const packaged = app.isPackaged
    const currentVersion = this.version()
    if (process.platform !== 'win32') return { currentVersion, packaged, available: false, error: '此平台请下载安装新版启动器；游戏资源仍可自动更新' }
    // 免安装版走**自己的自替换通道**（运维 2026-09-18 定的口径：
    // 「把老的结束掉然后删除旧的只运行新的」）。安装版那条会去跑 NSIS 安装包，
    // 对选了"不安装"的玩家等于被装了一份，而且此后他会同时有两份启动器。
    if (PortableSelfUpdate.isPortable()) {
      return new PortableSelfUpdate(this.feedUrl, this.onProgress).check()
    }
    if (!packaged) {
      return {
        currentVersion,
        packaged,
        available: false,
        error: '开发模式（未打包）：自更新不适用，改动代码即生效'
      }
    }
    if (!this.feedUrl) {
      return {
        currentVersion,
        packaged,
        available: false,
        error: '未配置更新源（config/launch.json 的 launcherUpdate.feedUrl 为空）'
      }
    }
    try {
      // 动态 import：electron-updater 在开发模式下会打印一堆无意义的日志，
      // 而且它不是核心路径（更新失败不该影响启动游戏），所以按需加载。
      // ⚠️ 但**不要用 `autoUpdater` 那个导出**（惰性 getter，在打包版里是 undefined），
      //    见 updaterInstance() 的注释 —— 0.2.1 的"检查更新"就是栽在这里。
      const updater = await this.updaterInstance()
      updater.removeAllListeners('download-progress')
      updater.on('download-progress', (p) => {
        this.onProgress({ percent: Math.floor(p.percent), message: p.transferred ? `${p.percent.toFixed(0)}%` : '' })
      })
      const r = await updater.checkForUpdates()
      const latest = r?.updateInfo?.version
      // ⚠️ 判据是"远端**比**本地新"，不是"远端和本地不一样"。
      //    用 `!==` 的话，本地版本比 feed 新（例如我先构建后发布）时会提示"发现新版本 0.2.2"
      //    并给一个**降级**按钮 —— 玩家点了就真的退回旧版。
      //    （2026-09-18 实测：0.2.3 的构建对着还放着 0.2.2 的 feed，就报了 available=true。）
      const available = versionGreater(latest, currentVersion)
      return {
        currentVersion,
        packaged,
        available,
        version: latest,
        notes: typeof r?.updateInfo?.releaseNotes === 'string' ? r.updateInfo.releaseNotes : undefined
      }
    } catch (e) {
      return {
        currentVersion,
        packaged,
        available: false,
        error: `检查失败：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  /**
   * **只下载**，不安装（安装会退出并替换程序文件）。
   *
   * 拆出来是为了能被自检覆盖：`Please check update first` 这个错就出在这一步
   * （下载用的实例与检查用的不是同一个），而原来"下载+安装"捆在一起，自检根本不敢调
   * —— 一调就真的把启动器装掉了。现在自检可以只调这一步。
   */
  async doDownload(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'win32') return { ok: false, error: '请下载对应平台的安装包' }
    if (!app.isPackaged) return { ok: false, error: '开发模式下不执行下载' }
    if (!this.feedUrl) return { ok: false, error: '未配置更新源' }
    try {
      // 用共享实例：它已经带着 check() 的结果（`updateInfoAndProvider`）。
      const updater = await this.updaterInstance()
      await updater.downloadUpdate()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 下载并安装，然后退出重启。
   *
   * ⚠️ 调用方必须**先确认没有游戏在跑**：安装会替换启动器程序文件，
   * 而启动器退出时会顺手把游戏一起收掉（见 `window-all-closed`），
   * 打到一半被踢下线对玩家是不可接受的。
   */
  async downloadAndInstall(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'win32') return { ok: false, error: '请下载对应平台的安装包' }
    // 免安装版：下载 → 验哈希 → 起自替换助手 → 退出（助手删旧 exe、把新版改名到位、启动它）。
    if (PortableSelfUpdate.isPortable()) {
      return new PortableSelfUpdate(this.feedUrl, this.onProgress).downloadAndInstall()
    }
    if (!app.isPackaged) return { ok: false, error: '开发模式下不执行安装' }
    if (!this.feedUrl) return { ok: false, error: '未配置更新源' }
    const first = await this.doDownload()
    if (!first.ok) return first
    try {
      const updater = await this.updaterInstance()
      // quitAndInstall(isSilent, isForceRunAfter)：静默安装并重新拉起启动器
      setImmediate(() => updater.quitAndInstall(true, true))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
