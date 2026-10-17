import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * 游戏目录的**展开**与**解析**：这里是把"配置里写的那串字符"变成"这台机器上的真实目录"
 * 的唯一地方。
 *
 * <h2>为什么必须单独一个模块（这是 2026-09-18 那个发布级缺陷的根因所在）</h2>
 * 出厂 `config/launch.json` 里写着 `gameRoot: "F:\\HMCL-3.6.12\\.minecraft"` —— 那是
 * **打包那台机器**上 HMCL 的实例路径，随安装包分发到每一台玩家机器上。于是：
 *
 * - 别人机器上没有 `F:\HMCL-3.6.12\...` ⇒ `resolveProfile()` 原样把这条路径展开进
 *   gameDir/assetsDir 与 94 条 classpath ⇒ 预检必然失败（java/实例目录/assets/classpath/
 *   javaagent 五条）⇒ **装完就永远"预检未通过、不能启动"**；
 * - 面板上还会原样显示 `读不到 mods 目录：F:\HMCL-3.6.12\.minecraft\versions\test\mods`，
 *   玩家看到的是**别的机器的路径**，无从下手。
 *
 * 而当时**没有任何"按机器/按用户展开"的机制**：`${GAME_DIR}` 系列模板只是把同一个
 * 绝对根目录复制到 200 多处，换机器仍然要手改一个绝对路径。修法就是本文件：
 *
 * <h2>解析优先级（顺序是语义的一部分，改动必须先改这里）</h2>
 * ```
 * ① 玩家设置 settings.json.gameRoot —— **玩家在界面上显式选的目录**（「浏览…」按钮写入）
 * ② 环境变量 DELTA_GAME_ROOT        —— 排障/多实例口子（不落盘、不随包分发）
 * ③ 出厂 config/launch.json.gameRoot—— 随包默认（现在是可展开的 ${LAUNCHER_DIR}/game）
 * ④ 候选扫描                          —— 本机常见位置里**确实是我们的整合包**的那个
 * ⑤ 每用户默认目录                    —— <userData>/game（不存在就建）
 * ```
 * ①②③ 的共同规则：**展开后目录真的存在就用它**（老玩家/玩家自己的选择不动）；显式指定了
 * 但不存在**不静默忽略**：记进 `rejected`，由日志/界面明确说"你指定的 X 在本机不存在，
 * 已回落到 Y"。这条规则同时解决了另一个真实场景：运维把自己机器上的绝对路径写进
 * settings.json（那是**这台机器**的文件、不随包分发），启动器照用不误。
 *
 * ① 排在 ② 前面（2026-09-18 运维补充要求："用户显式选择 > 随包默认"）：
 * 玩家刚点完"浏览…"选了目录，却被一个环境变量覆盖掉，是最难解释的一种"设了没生效"。
 * 环境变量的定位因此变成"运维/排障用的机器级默认"，而不是"玩家之上的强制项"。
 *
 * <h2>支持的可展开形式（集中在这里处理，别在别处再抄一份）</h2>
 * - `${LAUNCHER_DIR}` → 启动器数据目录（`%APPDATA%\<产品名>`）
 * - `%APPDATA%` / `%LOCALAPPDATA%` / `%USERPROFILE%` 等 `%NAME%` 形式的 Windows 环境变量
 * - 前导 `~` → 用户主目录
 * - 相对路径 → 相对**启动器数据目录**（不是当前工作目录：启动器的 cwd 完全不可控）
 *
 * 未定义的环境变量**保持原样**（不替换成空串），由 `leftoverTemplates()` 报成"未展开"
 * —— 静默变成空串会拼出 `\versions\test` 这种以反斜杠开头的怪路径，比报错难查得多。
 *
 * ⚠️ `tools/game-root.mjs` 是这套规则的 JS 镜像（探针/校验脚本要用的那份），
 * `tools/check-templates.mjs` 的漂移守卫会核对两边的层名与候选清单，改一边必须改另一边。
 */

/** 显式指定的最高优先级口子。名字进漂移守卫（tools/game-root.mjs 必须一致）。 */
export const GAME_ROOT_ENV = 'DELTA_GAME_ROOT'

/** 每用户默认目录名（relative to userData）。同样进漂移守卫。 */
export const DEFAULT_ROOT_SUBDIR = 'game'

/**
 * 候选根目录：**每台机器各自成立**的常见位置。
 *
 * 只做"采用"，**绝不创建**——扫描的意义是"玩家已经有我们的整合包，直接用它"，
 * 而不是"到处建空目录"。判定必须过 `looksLikeOurInstance()`（含清单重合度），
 * 否则会挑中玩家自己的另一个整合包（本项目真踩过：本机 `versions\ArdaCraft` 有 113 个
 * 模组，比我们的 `test` 的 79 个还多，"按模组最多自动选"直接选错人）。
 */
export const CANDIDATE_ROOTS: { spec: string; note: string }[] = [
  { spec: '%APPDATA%\\.minecraft', note: '官方启动器 / HMCL / PCL 的默认 .minecraft' },
  { spec: '~\\.minecraft', note: '用户主目录下的 .minecraft' },
  {
    spec: '%LOCALAPPDATA%\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\.minecraft',
    note: '微软商店版启动器的 .minecraft'
  },
  { spec: '${LAUNCHER_DIR}\\game', note: '启动器自己的默认目录（曾经装过就复用）' }
]

export interface PathContext {
  /** 启动器数据目录（`app.getPath('userData')`，`%APPDATA%\delta-launcher`） */
  userData: string
  /** `app.getPath('appData')`（`%APPDATA%`，**不含**产品名） */
  appData: string
  /** `%LOCALAPPDATA%` */
  localAppData: string
  /** 用户主目录 */
  home: string
  env: Record<string, string | undefined>
  /** Launcher neighbours and previously selected roots, supplied by the main process only. */
  searchRoots?: string[]
  portableDir?: string
}

/** 解析来源。日志/界面要说清"这条路径是谁给的"——否则排障时无从下手。 */
export type RootSource = 'portable' | 'env' | 'player-settings' | 'factory-config' | 'candidate' | 'default'

export interface RejectedRoot {
  source: RootSource
  /** 该层写的原始值（未展开） */
  raw: string
  /** 展开后的路径（就是这个不存在） */
  expanded: string
}

export interface RootInfo {
  /** 生效的游戏根目录（.minecraft 那一层） */
  root: string
  version?: string
  source: RootSource
  /** 该层的原始值；`default` 层为 null */
  raw: string | null
  /** 解析那一刻根目录是否已存在 */
  existed: boolean
  /** 显式指定过、但本机不存在的那些层（**不许静默**：界面与日志要能说清） */
  rejected: RejectedRoot[]
  /** 给界面/日志用的一句话说明 */
  note: string
}

const SOURCE_LABEL: Record<RootSource, string> = {
  portable: '当前玩家包（自动绑定）',
  env: `环境变量 ${GAME_ROOT_ENV}`,
  'player-settings': '玩家设置 settings.json',
  'factory-config': '出厂配置 config/launch.json',
  candidate: '本机自动发现（已有整合包）',
  default: '每用户默认目录'
}

export function sourceLabel(s: RootSource): string {
  return SOURCE_LABEL[s]
}

/**
 * **只做 token 展开**，不做路径解析：`${LAUNCHER_DIR}` 与 `%NAME%` 就地替换，
 * 仅当前导就是 `~` 时才展开主目录。
 *
 * <h2>为什么必须与 `expandPath()` 分开（2026-09-18 真机"开不了游戏"的事故）</h2>
 * 事故经过：把 `expandPath()` 套在了**每一条** JVM/程序参数上，于是
 * ```
 *  -Dfile.encoding=GB18030              → C:\…\delta-launcher\-Dfile.encoding=GB18030
 *  --username                           → C:\…\delta-launcher\--username
 *  -javaagent:…\authlib…jar=https://…   → C:\…\delta-launcher\-javaagent:…jar=https:\…
 * ```
 * 这些串**不是路径**（`isAbsolute()` 为假），却走进了"相对路径 ⇒ 相对数据目录"的分支，
 * 整条命令行坏掉：JVM 会把第一个"非选项"当成主类，`--gameDir/--launchTarget/--fml.*`
 * 全部丢失 ⇒ Forge 起不来（或直接 NPE）。玩家看到的就是"点了启动没反应/闪退"。
 *
 * 教训：**"展开"与"解释成路径"是两件事**。只有真正表示路径的字段（gameRoot / gameDir /
 * assetsDir / 选中目录 / 候选目录）走 `expandPath()`；参数数组必须走这个函数，
 * 逐字节保留原样。判据在 `--pathtest` 第 ⑮ 节——它断言的是**真的 resolveProfile**，
 * 而不是只测纯函数（当时的缺口正在这里）。
 */
export function expandTokens(raw: string, ctx: PathContext): string {
  let out = String(raw ?? '')
  if (out === '') return out
  out = out.split('${LAUNCHER_DIR}').join(ctx.userData)
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
    const key = Object.keys(ctx.env).find((k) => k.toUpperCase() === name.toUpperCase())
    const v = key ? ctx.env[key] : undefined
    return v && v.trim() !== '' ? v : whole
  })
  // 只有"整串就是一个 ~ 路径"时才展开主目录：`-Dfoo=~/x` 不是路径参数，
  // 动它只会制造出没人认识的 token。
  if (out === '~') out = ctx.home
  else if (/^~[\\/]/.test(out)) out = join(ctx.home, out.slice(2))
  return out
}

/**
 * 展开一个路径串：模板 → `%NAME%` 环境变量 → `~` → 相对路径 → 归一化。
 *
 * ⚠️ **只能用于路径字段**（gameRoot / gameDir / assetsDir / 选中的目录 / 候选目录）。
 * 参数数组请用 `expandTokens()` —— 把命令行参数丢进来会毁掉整条命令行（见那边的注释）。
 *
 * 顺序有讲究：`%NAME%` 展开出来的值本身可能带 `~` 或相对形式（例如有人把
 * `DELTA_GAME_ROOT` 设成 `%APPDATA%\..\Local\mc`），所以环境变量在前、`~`/相对在后。
 */
export function expandPath(raw: string, ctx: PathContext): string {
  let out = String(raw ?? '').trim()
  if (out === '') return ''
  // ①②③ 与 expandTokens 共用同一套 token 语义（只有这一份实现，避免两处走偏）。
  out = expandTokens(out, ctx)
  // ④ 相对路径 → 相对启动器数据目录。**不用 process.cwd()**：安装版双击启动时 cwd 是
  //    exe 所在目录，开发时是仓库目录，两种形态下同一个相对路径会指向不同的地方。
  // ⑤ 归一化：`${LAUNCHER_DIR}/game` 这种"模板 + 正斜杠"展开后是 `C:\…\delta-launcher/game`。
  //    它和 `C:\…\delta-launcher\game` 是同一个目录，但**字符串不相等** —— 一旦被拿去
  //    做比较/去重（界面显示、候选去重、日志对照）就会出现"看起来不一样"的假差异。
  //    resolve 会统一分隔符、去掉尾随分隔符，对 UNC 路径同样成立。
  return resolve(isAbsolute(out) ? out : resolve(ctx.userData, out))
}

/** 字符串里是否还残留没展开的 `%NAME%`（供 leftoverTemplates 用）。 */
export function leftoverEnvTokens(s: string | undefined): string[] {
  if (!s) return []
  return [...String(s).matchAll(/%[A-Za-z_][A-Za-z0-9_]*%/g)].map((m) => m[0])
}
function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface ModsDirState {
  /** ok = 有 jar；empty = 目录在但一个 jar 都没有；missing = 目录不存在；unreadable = 存在但读不了 */
  state: 'ok' | 'empty' | 'missing' | 'unreadable'
  jars: number
  error?: string
}

/**
 * 分类 mods 目录。**这三态必须分开**（这是运维提的"不要静默失败"那条要求）：
 * - `missing`：目录不存在 —— 新装机器，启动器会创建它 ⇒ 界面说"我会给你建一个"；
 * - `empty`：目录在、里面没有 jar —— 整合包还没下载 ⇒ 界面说"去「模组管理」下载整合包"；
 * - `unreadable`：存在但读不了（权限/盘符掉线）⇒ 界面说"读不到（检查权限/磁盘）"。
 * 原来这三种情况共用一句"读不到 mods 目录：<路径>"，玩家无法区分该做什么。
 */
export function classifyModsDir(modsDir: string): ModsDirState {
  if (!existsSync(modsDir)) return { state: 'missing', jars: 0 }
  if (!isDir(modsDir)) return { state: 'unreadable', jars: 0, error: '路径存在但不是目录' }
  try {
    const jars = readdirSync(modsDir).filter((n) => n.toLowerCase().endsWith('.jar')).length
    return { state: jars > 0 ? 'ok' : 'empty', jars }
  } catch (e) {
    return { state: 'unreadable', jars: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 这个根目录看起来是不是**我们的**整合包实例？
 *
 * 判据是"清单重合度"而不是"模组多不多"：清单（79 个文件名）是启动器持有的权威依据，
 * 别人的整合包与它几乎零重合。宁可漏认（回落到默认目录 + 明确提示），也不认错
 * （把玩家的另一个整合包当成我们的 ⇒ 启动起来一堆陌生模组，比"进不去"更糟）。
 */
export function looksLikeOurInstance(
  root: string,
  version: string,
  manifestNames: string[] | null
): { ok: boolean; modsDir: string; jars: number; overlap: number } {
  const modsDir = join(root, 'versions', version, 'mods')
  const st = classifyModsDir(modsDir)
  if (st.state !== 'ok') return { ok: false, modsDir, jars: 0, overlap: 0 }
  let names: string[] = []
  try {
    names = readdirSync(modsDir).filter((n) => n.toLowerCase().endsWith('.jar'))
  } catch {
    return { ok: false, modsDir, jars: 0, overlap: 0 }
  }
  if (!manifestNames || manifestNames.length === 0) {
    // 没有清单（不该发生：清单随包分发）⇒ 不做"猜"，不采用候选。
    return { ok: false, modsDir, jars: names.length, overlap: 0 }
  }
  const want = new Set(manifestNames)
  const overlap = names.filter((n) => want.has(n)).length
  // 阈值：至少 3 个命中，且达到清单的 1/3。装了一半/版本旧一点的整合包仍会被认出来，
  // 而别人家的整合包（0 个命中）绝不会。
  const ok = overlap >= 3 && overlap / manifestNames.length >= 1 / 3
  return { ok, modsDir, jars: names.length, overlap }
}

export interface ResolveGameRootInput {
  /** ① 环境变量（可能未设） */
  envRoot?: string
  /** ② settings.json 的 gameRoot（可能未设） */
  playerRoot?: string
  /** ③ 出厂 config/launch.json 的 gameRoot */
  factoryRoot?: string
  /** 实例名（= 配置里的 version），候选扫描要按它找 `versions\<name>` */
  version: string
  /** 授权清单里的文件名；null = 拿不到清单（此时不采用候选） */
  manifestNames: string[] | null
}

/**
 * 解析生效的游戏根目录。**所有消费点都必须走这里**（预检 / 整合包校验 / 启动 / 界面），
 * 否则又会出现"界面显示的是一套、启动用的是另一套"。
 */
export function resolveGameRoot(input: ResolveGameRootInput, ctx: PathContext): RootInfo {
  const rejected: RejectedRoot[] = []
  // A full player bundle explicitly owns its adjacent game folder. Resolve it
  // afresh after each move instead of copying the pack author's absolute path.
  if (ctx.portableDir) {
    try {
      const descriptor = join(ctx.portableDir, 'breakline-package.json')
      if (statSync(descriptor).size <= 4096) {
        const data = JSON.parse(readFileSync(descriptor, 'utf8').replace(/^\uFEFF/, ''))
        if (data.schema === 1 && data.gameRoot === 'game' && data.version === 'BREAKLine OPs Beta') {
          const root = resolve(ctx.portableDir, 'game')
          if (looksLikeOurInstance(root, data.version, input.manifestNames).ok)
            return { root, version: data.version, source: 'portable', raw: 'game', existed: true, rejected, note: '已自动绑定启动器旁的游戏包，无需选择目录' }
        }
      }
    } catch { /* Standalone launcher and incomplete packages use the normal resolver. */ }
  }
  const layers: { source: RootSource; raw: string | undefined }[] = [
    // ① 玩家在界面上显式选的（「浏览…」→ settings.json）优先于一切：
    //    玩家刚点完就"没生效"是最难解释的故障。见文件头的优先级说明。
    { source: 'player-settings', raw: input.playerRoot },
    { source: 'env', raw: input.envRoot },
    { source: 'factory-config', raw: input.factoryRoot }
  ]
  let factoryFallback: RootInfo | undefined
  for (const layer of layers) {
    const raw = (layer.raw ?? '').trim()
    if (raw === '') continue
    const expanded = expandPath(raw, ctx)
    if (isDir(expanded)) {
      const result: RootInfo = {
        root: expanded,
        source: layer.source,
        raw,
        existed: true,
        rejected,
        note: `${sourceLabel(layer.source)}指定：${raw}`
      }
      if (layer.source !== 'factory-config' || looksLikeOurInstance(expanded, input.version, input.manifestNames).ok) return result
      factoryFallback = result
      continue
    }
    // 显式指定但不存在：不静默。记下来，继续往下找。
    rejected.push({ source: layer.source, raw, expanded })
  }

  // ④ 候选扫描：只在"没有任何一层给出可用目录"时才跑，代价是几次 existsSync。
  for (const c of [...CANDIDATE_ROOTS, ...(ctx.searchRoots ?? []).map(spec => ({ spec, note: '启动器附近或曾经使用的游戏目录' }))]) {
    const root = expandPath(c.spec, ctx)
    // 展开后还留着 `%NAME%` / `${...}` = 这台机器上根本没有那个环境变量（例如非 Windows
    // 或某些精简系统没有 %LOCALAPPDATA%）。**跳过**：不能拿一个字面量路径去 resolve，
    // 那会变成 `<cwd>\%LOCALAPPDATA%\...` 这种"看起来是绝对路径"的假路径。
    if (/%[A-Za-z_][A-Za-z0-9_]*%|\$\{/.test(root)) continue
    const probe = looksLikeOurInstance(root, input.version, input.manifestNames)
    if (probe.ok) {
      return {
        root,
        source: 'candidate',
        raw: c.spec,
        existed: true,
        rejected,
        note: `自动发现本机已有整合包：${c.note}（${probe.modsDir}）`
      }
    }
  }

  // ⑤ 每用户默认目录。**不创建**（创建由 ensureGameStructure 做，且只在真正需要时做
  //    —— 解析函数保持只读，"看一眼"不该有副作用）。
  //    路径用 resolve 归一化，与 expandPath 的输出形式一致（否则同一个目录会有两种写法）。
  if (factoryFallback) return factoryFallback
  const def = resolve(join(ctx.userData, DEFAULT_ROOT_SUBDIR))
  return {
    root: def,
    source: 'default',
    raw: null,
    existed: isDir(def),
    rejected,
    note: `每用户默认目录：${def}${
      rejected.length > 0 ? `（配置里指定的 ${rejected[0].expanded} 在本机不存在，已回落）` : ''
    }`
  }
}

/**
 * 在**本机常见位置**里找"我们的整合包"（供「一键修复」用）。
 *
 * 与 `resolveGameRoot()` 里的候选扫描是同一批评据（`looksLikeOurInstance`），
 * 区别只在调用时机：那里是"没别的可用就用它"，这里是"玩家点了修复，主动去找"。
 * `exclude` 用来跳过当前（坏的）目录，避免"发现的就是原来那个"。
 */
export function discoverCandidateRoot(
  version: string,
  manifestNames: string[] | null,
  ctx: PathContext,
  exclude: string[] = []
): { root: string; version: string; note: string; modsDir: string; overlap: number } | null {
  const skip = new Set(exclude.map((e) => resolve(e).toLowerCase()))
  for (const root of discoverLocalRoots(ctx)) {
    if (/%[A-Za-z_][A-Za-z0-9_]*%|\$\{/.test(root)) continue
    if (skip.has(resolve(root).toLowerCase())) continue
    const selected = pickVersionDir(root, version, manifestNames).version
    const probe = looksLikeOurInstance(root, selected, manifestNames)
    if (probe.ok) return { root, version: selected, note: '已按服务器模组清单识别', modsDir: probe.modsDir, overlap: probe.overlap }
  }
  return null
}

/** Bounded local search, called during explicit preparation, never a full-disk crawl. */
export function discoverLocalRoots(ctx: PathContext): string[] {
  const seeds = [...CANDIDATE_ROOTS.map(c => expandPath(c.spec, ctx)), ...(ctx.searchRoots ?? [])]
  return searchRootTree(seeds)
}

function searchRootTree(seeds: string[]): string[] {
  const result: string[] = [], seen = new Set<string>()
  const queue = seeds.map(root => ({ root, depth: 0 }))
  const deadline = Date.now() + 1200
  const ignored = /^(?:node_modules|windows|appdata|libraries|assets|mods|config|logs|versions|runtime|java|cache|\.git|\$recycle\.bin|system volume information)$/i
  while (queue.length && result.length < 256 && Date.now() < deadline) {
    const { root, depth } = queue.shift()!
    if (!root || /^\\\\/.test(root) || /%[A-Za-z_][A-Za-z0-9_]*%|\$\{/.test(root)) continue
    const normalized = resolve(root), key = normalized.toLowerCase()
    if (seen.has(key) || !isDir(normalized)) continue
    seen.add(key); result.push(normalized)
    // The root itself can be a .minecraft sibling under a launcher/game-package folder.
    if (depth >= 3 || isDir(join(normalized, 'versions'))) continue
    try {
      for (const entry of readdirSync(normalized, { withFileTypes: true }))
        if (entry.isDirectory() && !ignored.test(entry.name)) queue.push({ root: join(normalized, entry.name), depth: depth + 1 })
    } catch { /* Unreadable locations are skipped; selected destination is validated separately. */ }
  }
  return result
}

export interface EnsureResult {  root: string
  versionDir: string
  modsDir: string
  configDir: string
  /** 本次真正创建出来的目录（幂等：第二次调用是空数组） */
  created: string[]
  error?: string
}

/**
 * 首次启动自建目录结构：`<root>/versions/<version>/{mods,config}`。
 *
 * 为什么要有：默认目录是"每台机器各自成立"的新目录，**必须能自己长出来**，
 * 否则新玩家的 mods 目录永远不存在（预检与整合包校验都会说"读不到"），
 * 而唯一的补救办法是让他手建目录——那等于没修。
 *
 * 刻意**不建** `assets/` 与 `libraries/`：那两样是 Minecraft 官方内容，启动器目前
 * 拿不到（M3 待做，见 LAUNCHER.md 第十二节）。建两个空目录只会让预检"看起来通过"、
 * 游戏却起不来——那正是本项目最反对的"假绿灯"。缺就是缺，报出来。
 */
export function ensureGameStructure(root: string, version: string): EnsureResult {
  const versionDir = join(root, 'versions', version)
  const modsDir = join(versionDir, 'mods')
  const configDir = join(versionDir, 'config')
  const created: string[] = []
  try {
    // 顺序：浅 → 深（recursive 会一次建齐，这里仍逐个记录，界面与日志要说清"建了什么"）
    for (const p of [root, join(root, 'versions'), versionDir, modsDir, configDir]) {
      if (!existsSync(p)) {
        mkdirSync(p, { recursive: true })
        created.push(p)
      }
    }
  } catch (e) {
    return {
      root,
      versionDir,
      modsDir,
      configDir,
      created,
      error: e instanceof Error ? e.message : String(e)
    }
  }
  return { root, versionDir, modsDir, configDir, created }
}

/** 给界面/日志用的"目录状态"提示。**代码与文案都在这里**，界面只负责渲染。 */
export type DirNoticeCode =
  | 'mods_missing'
  | 'mods_empty'
  | 'mods_unreadable'
  | 'first_run_created'
  | 'explicit_missing'
  | 'candidate_adopted'
  | 'ok'

export interface DirNotice {
  code: DirNoticeCode
  /** 一句话结论（界面显示给玩家） */
  text: string
  /** 详情（路径等；日志与排障用） */
  detail?: string
}

/**
 * 把"解析结果 + 自动建目录结果 + mods 目录分类"翻译成人话。
 *
 * 为什么值得单独一个纯函数：运维要的是**界面能区分**"这个目录不存在（我会给你建一个）"
 * 与"读到了目录但里面没有 mods"，而这两句话必须和主进程的判断同源——
 * 散在 JSX 里拼字符串，早晚会和实际行为对不上（本项目已经吃过"界面说 A、启动用 B"的亏）。
 */
export function describeGameDir(input: {
  rootInfo: RootInfo
  ensure: EnsureResult
  mods: ModsDirState
}): DirNotice[] {
  const out: DirNotice[] = []
  const { rootInfo, ensure, mods } = input
  for (const r of rootInfo.rejected) {
    out.push({
      code: 'explicit_missing',
      text: `${sourceLabel(r.source)}指定的游戏目录在本机不存在：${r.expanded}`,
      detail: `原始值：${r.raw}；已回落到 ${rootInfo.root}（${sourceLabel(rootInfo.source)}）`
    })
  }
  if (rootInfo.source === 'candidate') {
    out.push({ code: 'candidate_adopted', text: `已采用本机已有的整合包目录：${rootInfo.root}`, detail: rootInfo.note })
  }
  if (ensure.created.length > 0) {
    out.push({
      code: 'first_run_created',
      text: `首次运行：已创建游戏目录 ${ensure.root}（${ensure.created.length} 层）`,
      detail: ensure.created.join('；')
    })
  }
  if (mods.state === 'missing') {
    out.push({
      code: 'mods_missing',
      text: `mods 目录还不存在（启动器会创建）：${ensure.modsDir}`,
      detail: ensure.error
    })
  } else if (mods.state === 'empty') {
    out.push({
      code: 'mods_empty',
      text: `游戏目录已就绪，但里面还没有模组（整合包未下载）：${ensure.modsDir}`,
      detail: '点击“准备并启动”，启动器会自动补齐缺少的文件。'
    })
  } else if (mods.state === 'unreadable') {
    out.push({
      code: 'mods_unreadable',
      text: `读不到 mods 目录（权限或磁盘问题）：${ensure.modsDir}`,
      detail: mods.error
    })
  } else {
    out.push({ code: 'ok', text: `整合包目录正常：${ensure.modsDir}（${mods.jars} 个 jar）` })
  }
  return out
}

// ---------------------------------------------------------------------------
// 玩家「浏览…」选目录：把"玩家点中的那个目录"翻译成 gameRoot + 实例名
// ---------------------------------------------------------------------------

/**
 * 玩家可能选中的两种形态（**两种都必须能用**，这是运维 2026-09-18 明确要求的）：
 *
 * | 玩家选的是 | 形态 | 推出 gameRoot | 推出实例名 version |
 * | --- | --- | --- | --- |
 * | `…\.minecraft` | `root` | 就是它 | `<root>\versions\` 下最合适的那个实例 |
 * | `…\.minecraft\versions\test` | `instance` | 上两级（`.minecraft`） | 目录名 `test` |
 *
 * 后者如果不识别，玩家会看到"目录不存在：…\versions\test\versions\test"——
 * 一个由我们自己的模板拼出来的、谁也没见过的路径（这类"听起来能跑但明显不对"的
 * 结果正是要避免的）。所以判定规则写在一处，并由 `--pathtest` 断言
 * "选 .minecraft 与选实例目录必须解析出**同一个** gameDir"。
 */
export type PickedDirForm = 'root' | 'instance' | 'unknown'

export interface PickedDirResult {
  /** 玩家选中的目录（已规范化） */
  dir: string
  /** 目录本身存在与否：不存在时 `ok=false`，界面要说"这个目录不存在"，而不是崩或静默 */
  ok: boolean
  form: PickedDirForm
  /** 推出的游戏根目录（.minecraft 那一层） */
  gameRoot: string
  /** 推出的实例名（写进 settings.json 的 version） */
  version: string
  /** 实例名是否与当前配置不同（界面要显式提示"实例名也跟着改了"） */
  versionChanged: boolean
  /** 最终会被启动器使用的实例目录 = gameRoot/versions/version */
  versionDir: string
  /** 最终会被使用的 mods 目录 */
  modsDir: string
  mods: ModsDirState
  /** 采纳说明 / 拒绝原因（**三态文案**：不存在 / 没有 mods 目录 / 正常） */
  notes: string[]
  /** 该拒绝的（连目录都不是）——界面不该把它写进配置 */
  rejected: boolean
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function jarNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.jar'))
  } catch {
    return []
  }
}

/**
 * 在 `<root>/versions/` 下挑一个实例名。排序依据刻意是"清单重合度"而不是"模组多"：
 * 本机实测 `ArdaCraft`（113 个模组）比我们的 `test`（79 个）还多，按数量选一定选错人。
 * 当前实例名可用时**一律保留当前值**（"没让改就别改"）。
 */
export function pickVersionDir(
  root: string,
  currentVersion: string,
  manifestNames: string[] | null
): { version: string; reason: string } {
  const versionsDir = join(root, 'versions')
  if (!existsSync(versionsDir)) return { version: currentVersion, reason: '没有 versions 目录，保留当前实例名' }
  const names = subdirs(versionsDir)
  if (names.length === 0) return { version: currentVersion, reason: 'versions 目录是空的，保留当前实例名' }
  if (names.includes(currentVersion) && looksLikeOurInstance(root, currentVersion, manifestNames).ok) {
    return { version: currentVersion, reason: `实例 ${currentVersion} 存在，按原配置使用` }
  }
  const want = new Set(manifestNames ?? [])
  const ranked = names
    .map((n) => {
      const jars = jarNames(join(versionsDir, n, 'mods'))
      const overlap = want.size > 0 ? jars.filter((j) => want.has(j)).length : 0
      return { n, jars: jars.length, overlap }
    })
    .sort((a, b) => b.overlap - a.overlap || b.jars - a.jars || a.n.localeCompare(b.n))
  const best = ranked[0]
  if (!best || best.overlap < 3 || best.overlap / Math.max(1, want.size) < 1 / 3) {
    return { version: currentVersion, reason: `versions 下没有任何带模组的实例，保留当前实例名 ${currentVersion}` }
  }
  return {
    version: best.n,
    reason: `当前实例名 ${currentVersion} 不在 versions 下；已按清单重合度改用 ${best.n}（命中 ${best.overlap} 个清单文件）`
  }
}

/**
 * 解析玩家选中的目录。**纯函数**（只读文件系统），由 `--pathtest` 直接断言，
 * 也是「浏览…」按钮落地时唯一的解释器。
 */
export function interpretPickedDir(
  rawDir: string,
  currentVersion: string,
  manifestNames: string[] | null
): PickedDirResult {
  // 去掉资源管理器/终端可能带上的引号与尾随分隔符（`"D:\mc\.minecraft\"` 这种），
  // 并统一分隔符（玩家手输/别的工具给出的可能是正斜杠）。
  const cleaned = String(rawDir ?? '')
    .trim()
    .replace(/^"+|"+$/g, '')
  const dir = cleaned === '' ? '' : resolve(cleaned)
  const base = {
    dir,
    ok: false,
    form: 'unknown' as PickedDirForm,
    gameRoot: dir,
    version: currentVersion,
    versionChanged: false,
    versionDir: join(dir, 'versions', currentVersion),
    modsDir: join(dir, 'versions', currentVersion, 'mods'),
    mods: { state: 'missing' as const, jars: 0 },
    notes: [] as string[],
    rejected: true
  }
  if (dir === '' || !isDir(dir)) {
    // 状态①：目录不存在。**不崩、也不写进配置**，由界面明说"这个目录不存在"。
    return { ...base, notes: [`这个目录不存在：${dir || '(空)'}`], rejected: true }
  }

  const name = basename(dir)
  // ---- 纠偏：选到 `mods`（或 `versions`）这一层不算错，往上找到真正的目录再判形态 ----
  // 2026-09-19 运维实机踩到：在「浏览…」里点进了 `...\.minecraft\mods`，于是游戏根目录被判成
  // `...\.minecraft\mods`、实例目录成了 `...\mods\versions\`、mods 目录成了
  // `...\mods\versions\mods`（根本不存在）⇒ 完整性校验显示「0/0 个文件」，界面上一片"读不到"，
  // 而玩家其实只是**多点了一层**。现在按语义纠偏而不是报错。
  let effective = dir
  const climbed: string[] = []
  const lowerName = name.toLowerCase()
  if (lowerName === 'mods' || lowerName === 'versions') {
    const up = dirname(dir)
    if (isDir(up)) {
      effective = up
      climbed.push(name)
      if (basename(effective).toLowerCase() === 'versions') {
        const root = dirname(effective)
        if (isDir(root)) {
          effective = root
          climbed.push('versions')
        }
      }
    }
  }
  // Accept a game-package wrapper; only adopt children matching our manifest.
  if (!isDir(join(effective, 'versions')) && !isDir(join(effective, 'mods'))) {
    for (const child of searchRootTree([effective]).slice(1)) {
      const selected = pickVersionDir(child, currentVersion, manifestNames).version
      if (!looksLikeOurInstance(child, selected, manifestNames).ok) continue
      const picked = interpretPickedDir(join(child, 'versions', selected), currentVersion, manifestNames)
      return { ...picked, dir, notes: ['已在所选文件夹内找到游戏包，无需重新下载', ...picked.notes] }
    }
  }
  const effectiveParent = dirname(effective)
  const effectiveName = basename(effective)
  const climbNote =
    climbed.length > 0
      ? [`你选的是 ${climbed.join('\\')} 这一层，已按 ${effective} 处理（点错一层不算错）`]
      : []
  // ---- 形态判定 ----
  // ① 实例目录：父目录名为 versions（HMCL/PCL 的标准布局），
  //    或者目录里带 `<目录名>.jar` + `mods/`（有些启动器的实例不带 versions 前缀但同构）。
  const looksLikeInstance =
    basename(effectiveParent).toLowerCase() === 'versions' ||
    (existsSync(join(effective, `${effectiveName}.jar`)) && existsSync(join(effective, 'mods')))
  if (looksLikeInstance) {
    const gameRoot = dirname(effectiveParent)
    const versionDir = effective
    const modsDir = join(effective, 'mods')
    const mods = classifyModsDir(modsDir)
    if (mods.state === 'ok' && manifestNames?.length && !looksLikeOurInstance(gameRoot, effectiveName, manifestNames).ok)
      return { ...base, notes: ['这里是其他游戏包，请选择断界行动游戏包；如果没有，请使用“自动安装”。'], rejected: true }
    return {
      dir,
      ok: true,
      form: 'instance',
      gameRoot,
      version: effectiveName,
      versionChanged: effectiveName !== currentVersion,
      versionDir,
      modsDir,
      mods,
      notes: [
        ...climbNote,
        `识别为**实例目录**：游戏根目录 = ${gameRoot}，实例名 = ${effectiveName}`,
        ...(effectiveName !== currentVersion ? [`实例名从 ${currentVersion} 改为 ${effectiveName}`] : [])
      ],
      rejected: false
    }
  }

  // ② 游戏根目录（.minecraft）：挑 instances；没有 versions 时按根 mods 处理
  const pick = pickVersionDir(effective, currentVersion, manifestNames)
  const versionDir = join(effective, 'versions', pick.version)
  const isolatedMods = join(versionDir, 'mods')
  const rootMods = join(effective, 'mods')
  // 1.20.1 整合包几乎都是版本隔离：真正被加载的是 versions/<实例>/mods。
  // 但玩家选的可能是"根目录 + 根 mods"的布局，那种情况下也要如实报出来。
  const modsDir = existsSync(isolatedMods) ? isolatedMods : existsSync(rootMods) ? rootMods : isolatedMods
  const mods = classifyModsDir(modsDir)
  const notes: string[] = [
    ...climbNote,
    `识别为**游戏根目录**：${effective}（实例名 ${pick.version}）`,
    pick.reason
  ]
  if (mods.state === 'missing') {
    // 状态②：目录在，但没有 mods（也不是实例）。**这不是"读不到"，是"可能选错了"**。
    notes.push(
      `这里没有 mods 目录（也没有 versions/ 下的实例），可能不是 Minecraft 目录；` +
        `启动器仍会采用它，并在首次启动时创建 ${isolatedMods}`
    )
  } else if (mods.state === 'empty') {
    notes.push(`mods 目录是空的（整合包还没下载）：${modsDir}`)
  }
  return {
    dir,
    ok: true,
    form: 'root',
    gameRoot: effective,
    version: pick.version,
    versionChanged: pick.version !== currentVersion,
    versionDir,
    modsDir,
    mods,
    notes,
    rejected: false
  }
}
