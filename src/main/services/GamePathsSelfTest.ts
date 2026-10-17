import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyModsDir,
  describeGameDir,
  ensureGameStructure,
  expandPath,
  interpretPickedDir,
  leftoverEnvTokens,
  looksLikeOurInstance,
  resolveGameRoot,
  type PathContext
} from './GamePaths'
import { mergePathOverride } from './RuntimeSettings'

/** 出厂配置的形状（只取本自测要断言的那几个字段）。 */
export interface RawProfileLike {
  gameRoot: string
  version: string
  jvmArgs: string[]
  classpath: string[]
  programArgs?: string[]
  gameDir: string
  assetsDir: string
  java?: string
}

/**
 * 启动器侧的探针：把**真的** `resolveProfile()` 交给自测。
 *
 * <p>为什么必须这样接：2026-09-18 真机报"开不了游戏"，根因是展开函数被套在了
 * **每一条** JVM/程序参数上 —— `-Dfile.encoding=GB18030`、`-javaagent:…`、`--username`
 * 都不是绝对路径，于是被当成相对路径加了启动器数据目录前缀（`C:\…\delta-launcher\--username`），
 * 命令行整个坏掉。而当时的 `--pathtest` 只测 `GamePaths` 的纯函数、**没测 `resolveProfile`**，
 * 探针又用自己那份展开器（`tools/expand-profile.mjs`）—— 两边都"通过"，游戏却起不来。
 * 这一段补上那个缺口：对**启动器真正会拼出来的参数**做断言。
 */
export interface LauncherProbe {
  raw: RawProfileLike
  userData: string
  /** 传入 `(p) => resolveProfile(p)` */
  resolve: (p: RawProfileLike) => RawProfileLike
}

/**
 * 路径解析的纯函数自测（`--pathtest`）。
 *
 * <h2>为什么必须有它（而不是"我看代码是对的"）</h2>
 * 2026-09-18 那个发布级缺陷（出厂 gameRoot 写死打包机的 `F:\HMCL-3.6.12\.minecraft`）
 * 之所以能一路通过 typecheck / 构建 / 打包 / 界面自检，是因为**所有检查都只问
 * "这台机器上行不行"**，而"别人机器上行不行"从来没被判过。
 * 这个自测把"别人机器"变成可构造的输入：给它一条不存在的显式路径、一个空的
 * `%APPDATA%`，然后断言**解析出来的游戏目录是每用户默认目录**。
 *
 * 关键判据（会失败的判据，不是"跑完没报错"）：
 *   ① 显式指定的路径在本机不存在 ⇒ 生效根目录**必须**是每用户默认目录，
 *      且**绝不能**等于那条不存在的路径（缺陷的原始行为就是原样返回它）；
 *   ② 显式指定且存在 ⇒ 必须原样用它（老玩家不动）；
 *   ③ 候选扫描必须认"我们的整合包"（清单重合度）、拒绝"别人家的整合包"
 *      （本机真踩过：ArdaCraft 113 个模组比我们的 79 个还多，"按模组最多自动选"选错人）。
 *
 * 全部用临时目录，不读也不写真实玩家的游戏目录 —— 自测本身不能有副作用。
 *
 * @param factoryGameRoot 出厂 `config/launch.json` 的 gameRoot 原文（由调用方读，避免这里
 *   再抄一份 configDir 逻辑）；自测会断言"随包分发的那份配置里没有盘符绝对路径"。
 */
let passed = 0
let failed = 0
let skipped = 0

function check(name: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    passed++
    console.log(`    ✓ ${name}`)
  } else {
    failed++
    console.log(`    ✗ ${name}${actual === undefined ? '' : `（实际: ${JSON.stringify(actual)}）`}`)
  }
}

/** 只打印、不计分：用于"这台机器的客观事实"（例如本机就是打包机）。 */
function note(text: string): void {
  skipped++
  console.log(`    … ${text}`)
}

function section(title: string): void {
  console.log()
  console.log(`── ${title}`)
}

function makeJar(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), 'x', 'utf8')
}

export function runGamePathsSelfTest(factoryGameRoot: string | null, launcher?: LauncherProbe): number {
  const sandbox = mkdtempSync(join(tmpdir(), 'delta-paths-'))
  const ctx: PathContext = {
    userData: join(sandbox, 'AppData', 'Roaming', 'delta-launcher'),
    appData: join(sandbox, 'AppData', 'Roaming'),
    localAppData: join(sandbox, 'AppData', 'Local'),
    home: join(sandbox, 'Users', 'player'),
    env: { APPDATA: join(sandbox, 'AppData', 'Roaming'), USERPROFILE: join(sandbox, 'Users', 'player') }
  }
  const defaultRoot = join(ctx.userData, 'game')
  /**
   * 第二台"完全新装的机器"：**连默认目录都不存在**。
   *
   * 为什么必须分开：用例 ③ 会故意把 `<userData>/game` 建出来（验"出厂值存在即用"），
   * 而 ⑤/⑥/⑬ 验的是"没有可用显式目录时怎么挑" —— 用同一个 ctx 的话，出厂层会先命中，
   * 候选扫描与默认回落**根本走不到**（第一版就是这么写错的：测试看着"通过"，
   * 其实测的是另一条分支）。
   */
  const ctxFresh: PathContext = {
    userData: join(sandbox, 'fresh-machine', 'AppData', 'Roaming', 'delta-launcher'),
    appData: join(sandbox, 'fresh-machine', 'AppData', 'Roaming'),
    localAppData: join(sandbox, 'fresh-machine', 'AppData', 'Local'),
    home: join(sandbox, 'fresh-machine', 'Users', 'player'),
    // 真实机器上这几个环境变量一定有（候选清单里的 %APPDATA% 靠它们展开）；
    // 少了它们，候选扫描会静默跳过 —— 这正是"测试环境不真实 ⇒ 测不到东西"的例子。
    env: {
      APPDATA: join(sandbox, 'fresh-machine', 'AppData', 'Roaming'),
      LOCALAPPDATA: join(sandbox, 'fresh-machine', 'AppData', 'Local'),
      USERPROFILE: join(sandbox, 'fresh-machine', 'Users', 'player')
    }
  }
  const defaultRootFresh = join(ctxFresh.userData, 'game')
  // 别人的整合包（本机 ArdaCraft 那一类）：名字与我们的清单毫无交集
  const FOREIGN = ['ArdaCraft-core-1.0.jar', 'waystones-1.0.jar', 'create-1.0.jar']
  // 我们的清单（权威清单里那 79 个的缩样）
  const MANIFEST = [
    'deltaac-client-0.1.0.jar',
    'BTPmod-forge-1.20.1-1.6.1.jar',
    'BetterPingDisplay-1.20.1-1.1.jar',
    'tacz-1.20.1-1.0.jar',
    'jei-1.20.1.jar',
    'xaerominimap-1.20.1.jar'
  ]

  try {
    section('① 别人机器上：显式路径不存在 ⇒ 必须回落到每用户默认目录（本缺陷的核心判据）')
    // **保证不存在**的绝对路径。刻意不用真的 `F:\HMCL-3.6.12\.minecraft`：
    // 打包机（本机）上它真的存在，那种"测试因机器而异"的判据迟早会变成假绿。
    const missingPath = join(sandbox, 'no-such-machine', 'HMCL-3.6.12', '.minecraft')
    const info1 = resolveGameRoot(
      { envRoot: missingPath, version: 'test', manifestNames: MANIFEST },
      ctx
    )
    check('生效根目录 = 每用户默认目录', info1.root === defaultRoot, info1.root)
    check('来源标注为 default', info1.source === 'default', info1.source)
    check('**没有**原样返回那条不存在的路径', info1.root !== missingPath, info1.root)
    check(
      '不存在的路径被记下来（不许静默）',
      info1.rejected.length === 1 && info1.rejected[0].expanded === missingPath,
      info1.rejected
    )
    check('说明里写清"已回落"', /回落/.test(info1.note), info1.note)

    section('①-b 真·打包机路径：存在的显式路径必须被采用（本机是打包机时等价于"老玩家不动"）')
    const machinePath = 'F:\\HMCL-3.6.12\\.minecraft'
    const infoDev = resolveGameRoot({ envRoot: machinePath, version: 'test', manifestNames: MANIFEST }, ctx)
    if (existsSync(machinePath)) {
      note(`本机存在 ${machinePath} ⇒ 断言"显式且存在即采用"（这条机器上测不出回落，回落由 ① 覆盖）`)
      check('存在 ⇒ 采用它', infoDev.root === machinePath, infoDev.root)
      check('来源 = env', infoDev.source === 'env', infoDev.source)
    } else {
      check('不存在 ⇒ 回落到默认目录', infoDev.root === defaultRoot, infoDev.root)
    }

    section('② 老玩家不动：settings.json 显式指定且存在 ⇒ 原样使用')
    const legacyRoot = join(sandbox, 'legacy-root')
    mkdirSync(join(legacyRoot, 'versions', 'test'), { recursive: true })
    const info2 = resolveGameRoot(
      { playerRoot: legacyRoot, factoryRoot: '${LAUNCHER_DIR}/game', version: 'test', manifestNames: MANIFEST },
      ctx
    )
    check('用它（而不是默认目录）', info2.root === legacyRoot, info2.root)
    check('来源 = player-settings', info2.source === 'player-settings', info2.source)
    check('没有 rejected', info2.rejected.length === 0, info2.rejected)

    section('③ 出厂默认必须"每台机器各自成立"：${LAUNCHER_DIR}\\game 展开成用户目录')
    mkdirSync(defaultRoot, { recursive: true })
    const info3 = resolveGameRoot(
      { factoryRoot: '${LAUNCHER_DIR}\\game', version: 'test', manifestNames: MANIFEST },
      ctx
    )
    check('出厂值先被采用（存在即用）', info3.root === defaultRoot, info3.root)
    check('来源 = factory-config', info3.source === 'factory-config', info3.source)
    check('展开后没有残留模板', !/\$\{|%[A-Za-z_]+%/.test(info3.root), info3.root)

    section('④ 可展开形式集中处理：%VAR% / ~ / 相对路径 / 未定义变量')
    check('%APPDATA% 展开', expandPath('%APPDATA%\\.minecraft', ctx) === join(ctx.appData, '.minecraft'))
    check('%appdata% 大小写不敏感', expandPath('%appdata%\\.minecraft', ctx) === join(ctx.appData, '.minecraft'))
    check('~ 展开', expandPath('~/.minecraft', ctx) === join(ctx.home, '.minecraft'))
    check('~\\.minecraft 展开', expandPath('~\\.minecraft', ctx) === join(ctx.home, '.minecraft'))
    check(
      '相对路径相对**启动器数据目录**',
      expandPath('game\\mc', ctx) === join(ctx.userData, 'game', 'mc'),
      expandPath('game\\mc', ctx)
    )
    check('绝对路径不动', expandPath('D:\\mc\\.minecraft', ctx) === 'D:\\mc\\.minecraft')
    check('${LAUNCHER_DIR} 展开', expandPath('${LAUNCHER_DIR}\\game', ctx) === defaultRoot)
    const undef = expandPath('%NOT_DEFINED_HERE%\\x', ctx)
    check('未定义的环境变量**保持原样**（不变成空串）', undef.includes('%NOT_DEFINED_HERE%'), undef)
    check('残留检测能报出来', leftoverEnvTokens(undef).join(',') === '%NOT_DEFINED_HERE%')
    check(
      '不误报普通字符串（base64 / 中文 / 空）',
      leftoverEnvTokens('aGVsbG8=').length === 0 &&
        leftoverEnvTokens('C:\\Program Files\\Java').length === 0 &&
        leftoverEnvTokens(undefined).length === 0
    )

    section('⑤ 候选扫描：认得出"我们的整合包"')
    const appDataMc = join(ctxFresh.appData, '.minecraft')
    const ourMods = join(appDataMc, 'versions', 'test', 'mods')
    for (const n of MANIFEST.slice(0, 4)) makeJar(ourMods, n)
    makeJar(ourMods, 'something-extra.jar') // 玩家自己多装了一个：不该因此否掉
    const info5 = resolveGameRoot(
      { factoryRoot: '${LAUNCHER_DIR}\\game', version: 'test', manifestNames: MANIFEST },
      ctxFresh
    )
    check('采用了 %APPDATA%\\.minecraft 下的实例', info5.root === appDataMc, info5.root)
    check('来源 = candidate', info5.source === 'candidate', info5.source)
    const probe5 = looksLikeOurInstance(appDataMc, 'test', MANIFEST)
    check('重合度 4/6 命中', probe5.overlap === 4, probe5)

    section('⑥ 候选扫描：拒绝"别人家的整合包"（本机 ArdaCraft 陷阱）')
    const foreignRoot = join(ctxFresh.home, '.minecraft')
    const foreignMods = join(foreignRoot, 'versions', 'test', 'mods')
    for (const n of FOREIGN) makeJar(foreignMods, n)
    rmSync(appDataMc, { recursive: true, force: true }) // 只留"别人家"的那份
    const info6 = resolveGameRoot(
      { factoryRoot: '${LAUNCHER_DIR}\\game', version: 'test', manifestNames: MANIFEST },
      ctxFresh
    )
    check('零重合 ⇒ 不采用', info6.root === defaultRootFresh, info6.root)
    check('来源 = default', info6.source === 'default', info6.source)
    const probe6 = looksLikeOurInstance(foreignRoot, 'test', MANIFEST)
    check('判据本身给出 ok=false（不是"没扫到"）', !probe6.ok && probe6.jars === FOREIGN.length, probe6)
    // 边界：只重合 2 个（< 3）也不认，避免"残包"被当成正式实例
    const weakMods = join(foreignRoot, 'versions', 'weak', 'mods')
    for (const n of MANIFEST.slice(0, 2)) makeJar(weakMods, n)
    for (const n of FOREIGN) makeJar(weakMods, n)
    check('重合 2 个 ⇒ 仍不采用', !looksLikeOurInstance(foreignRoot, 'weak', MANIFEST).ok)
    rmSync(foreignRoot, { recursive: true, force: true })

    section('⑦ 首次启动自建结构：versions/<实例>/{mods,config}，且幂等')
    const fresh = join(sandbox, 'fresh-root')
    const ens = ensureGameStructure(fresh, 'test')
    check('建了 mods', existsSync(join(fresh, 'versions', 'test', 'mods')), ens.created)
    check('建了 config', existsSync(join(fresh, 'versions', 'test', 'config')), ens.created)
    check('返回了创建清单（界面要说"建了什么"）', ens.created.length === 5, ens.created)
    const ens2 = ensureGameStructure(fresh, 'test')
    check('第二次调用是空操作（幂等）', ens2.created.length === 0, ens2.created)

    section('⑧ 三态必须分得开：目录不存在 / 目录在但没 mods / 读不到')
    check('不存在 ⇒ missing', classifyModsDir(join(fresh, 'nope', 'mods')).state === 'missing')
    check('空目录 ⇒ empty', classifyModsDir(join(fresh, 'versions', 'test', 'mods')).state === 'empty')
    makeJar(join(fresh, 'versions', 'test', 'mods'), 'deltaac-client-0.1.0.jar')
    const okState = classifyModsDir(join(fresh, 'versions', 'test', 'mods'))
    check('有 jar ⇒ ok 且计数正确', okState.state === 'ok' && okState.jars === 1, okState)
    const asFile = join(fresh, 'not-a-dir')
    writeFileSync(asFile, 'x', 'utf8')
    check('是文件不是目录 ⇒ unreadable', classifyModsDir(asFile).state === 'unreadable')

    section('⑨ 给界面的话必须能区分两种"找不到"')
    const fresh2 = join(sandbox, 'fresh2')
    const missingNotices = describeGameDir({
      rootInfo: info1,
      ensure: ensureGameStructure(fresh2, 'test'),
      mods: classifyModsDir(join(fresh2, 'versions', 'test', 'mods'))
    })
    const emptyNotices = describeGameDir({
      rootInfo: info1,
      ensure: ensureGameStructure(fresh, 'test'),
      mods: classifyModsDir(join(fresh, 'versions', 'test', 'mods'))
    })
    check(
      '新机器：出现"已创建"与"还没有模组"两类提示',
      missingNotices.some((n) => n.code === 'first_run_created') &&
        missingNotices.some((n) => n.code === 'mods_empty'),
      missingNotices.map((n) => n.code)
    )
    check(
      '读不到目录时才说"读不到"（三态文案不同源会在这里露馅）',
      !missingNotices.some((n) => n.code === 'mods_unreadable') &&
        emptyNotices.some((n) => n.code === 'ok'),
      emptyNotices.map((n) => n.code)
    )
    check(
      '显式路径不存在的提示里带着那条路径与回落目标',
      missingNotices.some(
        (n) => n.code === 'explicit_missing' && n.text.includes(missingPath) && (n.detail ?? '').includes(info1.root)
      ),
      missingNotices.filter((n) => n.code === 'explicit_missing' || n.code === 'mods_empty')
    )

    section('⑩ 出厂配置不再有任何"打包机"痕迹（静态判据）')
    // 这条是对**随包分发的那份配置**的断言：缺陷一半在代码、一半在这个 JSON 里。
    check('出厂 gameRoot 不含盘符绝对路径', !/^[A-Za-z]:[\\/]/.test(factoryGameRoot ?? ''), factoryGameRoot)
    check(
      '出厂 gameRoot 用的是可展开形式（${LAUNCHER_DIR}/%VAR%/~）',
      /\$\{LAUNCHER_DIR\}|%[A-Za-z_]+%|^~/.test(factoryGameRoot ?? ''),
      factoryGameRoot
    )

    section('⑪ 玩家「浏览…」选目录：两种形态必须解析出同一个 gameDir')
    const mcRoot = join(sandbox, 'player-mc', '.minecraft')
    const instDir = join(mcRoot, 'versions', 'test')
    for (const n of MANIFEST.slice(0, 3)) makeJar(join(instDir, 'mods'), n)
    const pickRoot = interpretPickedDir(mcRoot, 'nope', MANIFEST)
    const pickInst = interpretPickedDir(instDir, 'nope', MANIFEST)
    check('选 .minecraft ⇒ 形态 root', pickRoot.ok && pickRoot.form === 'root', pickRoot)
    check('选 实例目录 ⇒ 形态 instance', pickInst.ok && pickInst.form === 'instance', pickInst)
    check(
      '两种选法推出同一个 gameRoot',
      pickRoot.gameRoot === pickInst.gameRoot && pickRoot.gameRoot === mcRoot,
      [pickRoot.gameRoot, pickInst.gameRoot]
    )
    check(
      '两种选法推出同一个实例名/gameDir',
      pickRoot.version === 'test' &&
        pickInst.version === 'test' &&
        join(pickRoot.gameRoot, 'versions', pickRoot.version) === join(pickInst.gameRoot, 'versions', pickInst.version),
      [pickRoot.version, pickInst.version]
    )
    check(
      '实例名与旧配置不同时要说出来（versionChanged）',
      pickRoot.versionChanged && pickInst.versionChanged,
      [pickRoot.versionChanged, pickInst.versionChanged]
    )
    // 选中的目录被采纳后，预检看到的 gameDir 必须是它（而不是出厂值/默认值）
    const infoPicked = resolveGameRoot(
      { playerRoot: pickRoot.gameRoot, envRoot: join(sandbox, 'env-should-lose'), factoryRoot: '${LAUNCHER_DIR}/game', version: 'test', manifestNames: MANIFEST },
      ctx
    )
    check('玩家在选择器里选的那层优先级最高（压过环境变量与出厂值）', infoPicked.source === 'player-settings', infoPicked.source)
    check('生效 gameDir = 选区/versions/test', join(infoPicked.root, 'versions', 'test') === instDir)

    section('⑪b 点错一层（选到 mods）：按语义纠偏，不报错')
    // 2026-09-19 运维实机：在「浏览…」里点进了 `.minecraft\mods`，于是根目录被判成 mods 那一层、
    // mods 目录成了 `...\mods\versions\mods`（不存在）⇒ 完整性校验「0/0 个文件」+ 界面一片"读不到"。
    mkdirSync(join(mcRoot, 'mods'), { recursive: true })
    const pickRootMods = interpretPickedDir(join(mcRoot, 'mods'), 'test', MANIFEST)
    const pickInstMods = interpretPickedDir(join(instDir, 'mods'), 'test', MANIFEST)
    check('选 .minecraft\\mods ⇒ 仍然 ok（不是错误）', pickRootMods.ok === true, pickRootMods)
    check(
      '选 .minecraft\\mods ⇒ 游戏根目录纠偏回 .minecraft',
      pickRootMods.gameRoot === mcRoot && pickRootMods.form === 'root',
      [pickRootMods.gameRoot, pickRootMods.form]
    )
    check(
      '选 实例\\mods ⇒ 认成实例目录，根目录仍是 .minecraft',
      pickInstMods.ok && pickInstMods.form === 'instance' && pickInstMods.gameRoot === mcRoot && pickInstMods.version === 'test',
      [pickInstMods.form, pickInstMods.gameRoot, pickInstMods.version]
    )
    check(
      '纠偏这件事要说出来（notes 里必须有人话解释）',
      pickRootMods.notes.some((n) => n.includes('点错一层')) && pickInstMods.notes.some((n) => n.includes('点错一层')),
      [pickRootMods.notes, pickInstMods.notes]
    )
    check(
      '纠偏后 mods 目录必须落在真实存在的那一份上',
      pickInstMods.modsDir === join(instDir, 'mods') && pickInstMods.mods.jars > 0,
      [pickInstMods.modsDir, pickInstMods.mods.jars]
    )

    section('⑫ 持久化：必须写"可写的用户配置"，且保留其它键')
    const before = { memoryMb: 12288, java: 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe', fullscreen: false }
    const merged = mergePathOverride(before, { gameRoot: mcRoot, version: 'test' })
    check('写入了 gameRoot', merged.gameRoot === mcRoot, merged.gameRoot)
    check('写入了 version', merged.version === 'test', merged.version)
    check(
      '没有把内存/Java 等既有键冲掉（合并写，不是覆盖写）',
      merged.memoryMb === 12288 && merged.fullscreen === false && typeof merged.java === 'string',
      merged
    )
    check('空值不写入（清空语义靠专门的 reset）', !('gameRoot' in mergePathOverride({}, { gameRoot: '   ' })))

    section('⑬ 选了不存在的目录：不崩、不采纳、回落到每用户默认')
    const ghost = join(sandbox, 'ghost-dir', '.minecraft')
    const pickGhost = interpretPickedDir(ghost, 'test', MANIFEST)
    check('解释结果是"拒绝"', pickGhost.rejected === true, pickGhost)
    check('说明里明说"这个目录不存在"', pickGhost.notes.some((n) => n.includes('不存在')), pickGhost.notes)
    const infoGhost = resolveGameRoot(
      { playerRoot: ghost, factoryRoot: '${LAUNCHER_DIR}/game', version: 'test', manifestNames: MANIFEST },
      ctxFresh
    )
    check('解析回落到每用户默认目录', infoGhost.root === defaultRootFresh, infoGhost.root)
    check('不存在的路径被记进 rejected', infoGhost.rejected.some((r) => r.expanded === ghost))
    const pickFile = join(sandbox, 'a-file.txt')
    writeFileSync(pickFile, 'x', 'utf8')
    check('选到一个文件也不崩（同样按"不存在"处理）', interpretPickedDir(pickFile, 'test', MANIFEST).rejected === true)

    section('⑭ 选到"没有 mods 也不是实例"的目录：三态里的第②种，明说而不是笼统报错')
    const emptyDir = join(sandbox, 'looks-empty')
    mkdirSync(emptyDir, { recursive: true })
    const pickEmpty = interpretPickedDir(emptyDir, 'test', MANIFEST)
    check('仍然采纳（玩家可能正要往里装整合包）', pickEmpty.ok && !pickEmpty.rejected, pickEmpty)
    check('但明确提示"这里没有 mods 目录"', pickEmpty.notes.some((n) => n.includes('没有 mods 目录')), pickEmpty.notes)
    check('mods 三态 = missing（与"目录不存在"用词不同）', pickEmpty.mods.state === 'missing', pickEmpty.mods)

    // -----------------------------------------------------------------------
    // ⑮ 启动参数完整性：对**启动器真正会拼出来的参数**做断言
    //
    // 这一节是 2026-09-18 真机"开不了游戏"事故的直接产物：
    // 展开函数一度被套在**每一条** JVM/程序参数上，于是
    //   `-Dfile.encoding=GB18030` → `C:\…\delta-launcher\-Dfile.encoding=GB18030`
    //   `--username`              → `C:\…\delta-launcher\--username`
    //   `-javaagent:…jar=https://…` → `C:\…\delta-launcher\-javaagent:…jar=https:\…`
    // 命令行整个坏掉（JVM 会把第一个"非选项"当成主类）。
    // 当时 --pathtest 只测纯函数、探针又用自己那份展开器，**两边都没测到这条路**。
    // -----------------------------------------------------------------------
    if (launcher) {
      section('⑮ 启动器侧参数展开：非路径参数必须原样保留（真机事故的判据）')
      const raw = launcher.raw
      const res = launcher.resolve(raw)
      // ① 不含任何模板/环境变量/`~` 的参数，展开后必须**逐字节相同**。
      const untouched = (s: string): boolean => !/\$\{|%[A-Za-z_][A-Za-z0-9_]*%|^~/.test(s)
      const changed = raw.jvmArgs.filter((a, i) => untouched(a) && !a.startsWith('-DignoreList=') && res.jvmArgs[i] !== a)
      check('jvmArgs 里"无需展开"的参数一个都没被改动', changed.length === 0, changed.slice(0, 3))
      // The resolver deliberately deduplicates this list and adds the selected vanilla version JAR.
      const originalIgnore = raw.jvmArgs.find(a => a.startsWith('-DignoreList='))?.slice('-DignoreList='.length).split(',') ?? []
      const resolvedIgnore = res.jvmArgs.find(a => a.startsWith('-DignoreList='))?.slice('-DignoreList='.length).split(',') ?? []
      const versionJarName = `${raw.version}.jar`
      check('ignoreList 仅去重并纳入当前版本 JAR', resolvedIgnore.includes(versionJarName) &&
        new Set(resolvedIgnore).size === resolvedIgnore.length && originalIgnore.every(a => resolvedIgnore.includes(a)) &&
        resolvedIgnore.every(a => originalIgnore.includes(a) || a === versionJarName))
      // ⚠️ 只能断言"原本以 - 开头的仍然以 - 开头"：jvmArgs 里也有**值**（`-cp` 后面那串
      // 巨型 classpath、`-p` 后面的模块路径、`--add-modules` 后面的 ALL-MODULE-PATH），
      // 它们本来就不以 `-` 开头。第一版断言"每一条都以 - 开头"，结果是自己假阳性
      // （本项目的老规矩：先怀疑工具，再怀疑被测对象）。
      const lostDash = raw.jvmArgs
        .map((a, i) => ({ raw: a, res: res.jvmArgs[i] }))
        .filter((x) => x.raw.startsWith('-') && !x.res.startsWith('-'))
      check('原本以 - 开头的参数没有被加路径前缀', lostDash.length === 0, lostDash.slice(0, 3).map((x) => x.res.slice(0, 80)))
      const agentRaw = raw.jvmArgs.find((a) => a.startsWith('-javaagent:'))
      const agentRes = res.jvmArgs.find((a) => a.startsWith('-javaagent:'))
      check('-javaagent: 参数存在且仍是 -javaagent:', agentRes !== undefined, agentRes?.slice(0, 80))
      if (agentRaw && agentRes) {
        // 分隔符要归一化再比：配置里写的是 `${LAUNCHER_DIR}/runtime/…`（正斜杠），
        // 而 join() 给的是反斜杠 —— 两者是同一个路径，直接 includes 会假阳性。
        const norm = (s: string): string => s.replace(/\//g, '\\')
        check(
          '-javaagent: 的 jar 路径指向启动器数据目录且保留 =<url> 后缀',
          agentRes.startsWith('-javaagent:') &&
            norm(agentRes).includes(norm(join(launcher.userData, 'runtime'))) &&
            agentRes.includes('.jar='),
          agentRes.slice(0, 160)
        )
        const agentFile = agentRes.slice('-javaagent:'.length).split('=')[0]
        check('该 jar 在本机存在（预检会查这一条）', existsSync(agentFile), agentFile)
      }
      // ② 程序参数：`--flag` 必须还是 `--flag`，条数不能变（多了/少了都会让 Forge 起不来）
      const progRaw = raw.programArgs ?? []
      const progRes = res.programArgs ?? []
      check('programArgs 条数不变', progRaw.length === progRes.length, [progRaw.length, progRes.length])
      const flagsRaw = progRaw.filter((a) => a.startsWith('--'))
      const flagsRes = progRes.filter((a) => a.startsWith('--'))
      check('--flag 的数量不变', flagsRaw.length === flagsRes.length, [flagsRaw.length, flagsRes.length])
      check(
        '--flag 本身逐字不变（例如 --gameDir / --launchTarget / --quickPlayMultiplayer）',
        flagsRaw.every((f, i) => f === flagsRes[i]),
        flagsRaw.filter((f, i) => f !== flagsRes[i])
      )
      check(
        '认证占位符仍是字面量（由启动瞬间填值，这里不该展开）',
        progRes.includes('${clientid}') && progRes.includes('${auth_xuid}')
      )
      // ③ classpath：条数与 `;` 分隔的数量必须与配置一致（少了 = Forge 起不来）
      check('classpath 条数不变', raw.classpath.length === res.classpath.length, [
        raw.classpath.length,
        res.classpath.length
      ])
      const cpRaw = raw.jvmArgs.find((a) => a.includes('securejarhandler'))
      const cpRes = res.jvmArgs.find((a) => a.includes('securejarhandler'))
      if (cpRaw && cpRes) {
        check(
          '巨型 -cp 字符串的分号数量不变（展开不能吃掉/增加分隔符）',
          (cpRaw.match(/;/g) ?? []).length === (cpRes.match(/;/g) ?? []).length,
          [(cpRaw.match(/;/g) ?? []).length, (cpRes.match(/;/g) ?? []).length]
        )
      }
      // ④ 路径字段：必须是绝对路径、无残留模板，且指向生效根目录
      check('gameDir 是绝对路径且无残留', /^[A-Za-z]:[\\/]/.test(res.gameDir) && !/\$\{|%[A-Za-z_]+%/.test(res.gameDir), res.gameDir)
      check('assetsDir 是绝对路径且无残留', /^[A-Za-z]:[\\/]/.test(res.assetsDir) && !/\$\{|%[A-Za-z_]+%/.test(res.assetsDir), res.assetsDir)
      check(
        'gameDir = <生效根目录>\\versions\\<实例>',
        res.gameDir === join(raw.gameRoot, 'versions', raw.version),
        [res.gameDir, join(raw.gameRoot, 'versions', raw.version)]
      )
      // ⑤ 若这台机器上该实例真的存在（打包机/玩家机就是这种情形），classpath 必须逐条存在
      if (existsSync(res.gameDir)) {
        const miss = res.classpath.filter((c) => !existsSync(c))
        check('实例存在时，展开后的 classpath 逐条存在', miss.length === 0, miss.slice(0, 3))
        check('版本 jar 存在', existsSync(join(res.gameDir, `${raw.version}.jar`)), join(res.gameDir, `${raw.version}.jar`))
        check('natives 目录存在', existsSync(join(res.gameDir, 'natives-windows-x86_64')))
      } else {
        note(`本机没有 ${res.gameDir}（不是打包机）⇒ 跳过"逐条存在"的检查（那几条由 ⑥ 的回落覆盖）`)
      }
    }

    console.log()
    console.log(`通过 ${passed} / 失败 ${failed}${skipped > 0 ? ` / 只记录不计分 ${skipped}` : ''}`)
    return failed === 0 ? 0 : 1
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不该让自测失败 */
    }
  }
}
