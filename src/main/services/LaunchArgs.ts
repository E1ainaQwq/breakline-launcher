import { stripGcFlags, tunedG1Args } from './GcProfile'

/**
 * 启动命令行拼装 —— **纯函数**，所以能被自测钉住。
 *
 * <h2>为什么把它从启动流程里抽出来</h2>
 * 2026-09-18 之前，启动器**根本没有把 `-Xmx` 传给游戏**（全仓 grep 无命中），
 * 79 个模组的整合包跑在默认堆上；而"内存分配 8 GB"那行还是个假下拉框。
 * 补齐这段逻辑时又发现：**dry-run（`--uishot-dry-run`）根本不走启动路径**，
 * 所以"看日志里有没有 -Xmx"这条路验不到东西 —— 只有把拼装抽成纯函数，
 * 才能用自测把这几条行为一条条钉死：
 *
 *   ① 模板里已有的 `-Xmx/-Xms` 必须先摘掉（否则命令行出现两个 -Xmx，
 *      JVM 取最后一个 ⇒ 实际生效的取决于模板写了什么，不可预期）；
 *   ② `--width/--height` 要**替换**而不是追加（追加出两份，谁生效看游戏实现）；
 *   ③ `--fullscreen` 是**开关**（有/没有），不是 `--fullscreen true`；
 *   ④ 打印命令行时 `--accessToken` 后面的值**必须脱敏** —— 那是玩家的登录凭据。
 */
export interface RuntimeArgs {
  memoryMb: number
  gcMode?: 'template' | 'tuned'
  javaMajor?: number
  width: number | null
  height: number | null
  fullscreen: boolean
  /**
   * 启动器来源令牌（D2 加强版）。
   *
   * 通过 **JVM 系统属性** `-Ddelta.launcher.token=` 传给游戏 —— 模组侧一行
   * `System.getProperty(...)` 就能读到，不用碰游戏启动参数的解析。
   * 为 null 表示"没拿到令牌"：这时**不加这个参数**，由服务端的准入闸门去拦
   * （绝不能伪造一个空令牌，那会让"看起来有机制"变成实际全放行）。
   */
  launcherToken?: string | null
  leaseUrl?: string
  leaseKey?: string
}

/** Forge must not discover the vanilla version JAR as a second mod module. */
export function versionJarIgnoreList(args: string[], version: string): string[] {
  const prefix = '-DignoreList='
  const actual = `${version}.jar`
  const found = args.some(arg => arg.startsWith(prefix))
  const resolved = args.map(arg => arg.startsWith(prefix)
    ? prefix + [...new Set([...arg.slice(prefix.length).split(','), actual])].join(',')
    : arg)
  return found ? resolved : [...resolved, prefix + actual]
}

/** 从模板 jvmArgs 里摘掉 `-Xmx…` / `-Xms…`（大小写不敏感，`-Xmx8G` 与 `-Xmx 8G` 两种写法都认）。 */
export function stripHeapFlags(jvmArgs: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < jvmArgs.length; i++) {
    const a = jvmArgs[i]
    if (/^-Xm[sx]/i.test(a)) {
      // `-Xmx 8G` 这种"标志与值分开"的写法：连后面的值一起吃掉。
      if (/^-Xm[sx]$/i.test(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

/** 把 `--name value` 形式的参数设成 value（已有就替换，没有就追加）。 */
function setPair(args: string[], name: string, value: string): void {
  const at = args.indexOf(name)
  if (at >= 0) args[at + 1] = value
  else args.push(name, value)
}

/** 把开关型参数（`--fullscreen`）设成"有/没有"。 */
function setFlag(args: string[], name: string, on: boolean): void {
  const at = args.indexOf(name)
  if (on && at < 0) args.push(name)
  if (!on && at >= 0) args.splice(at, 1)
}

/** 拼装最终命令行：`java <jvmArgs> <程序参数>`。 */
export function buildLaunchArgs(
  templateJvmArgs: string[],
  programArgs: string[],
  runtime: RuntimeArgs
): string[] {
  let jvm = stripHeapFlags(templateJvmArgs ?? []).filter(a =>
    !a.startsWith('-Ddelta.launcher.') && !/^-XX:[+-](EnableDynamicAgentLoading|DisableAttachMechanism)$/.test(a))
  if (runtime.gcMode !== 'template') jvm = [...tunedG1Args(runtime.javaMajor ?? 17), ...stripGcFlags(jvm)]
  // ⚠️ **必须放在最前面**：系统属性只有在"主类之前"才会被 JVM 当成 JVM 参数，
  // 放到后面会被当成**游戏的程序参数**（游戏不认识，直接启动失败或参数被忽略）。
  // 模板的 jvmArgs 里包含 `-cp … 主类 …`，所以只能插在开头。
  if (runtime.launcherToken) jvm.unshift(`-Ddelta.launcher.token=${runtime.launcherToken}`)
  if (runtime.leaseUrl && runtime.leaseKey) {
    jvm.unshift(`-Ddelta.launcher.leaseUrl=${runtime.leaseUrl}`, `-Ddelta.launcher.leaseKey=${runtime.leaseKey}`)
  }
  // HotSpot 17: 关闭运行中 Attach；官方登录 Agent 仍在启动时加载。
  // 堆大小也必须放在主类前，否则模板带主类时 -Xmx 会变成游戏参数。
  jvm.unshift('-XX:+DisableAttachMechanism', '-XX:-EnableDynamicAgentLoading', `-Xmx${runtime.memoryMb}M`)

  const prog = [...(programArgs ?? [])]
  if (runtime.width) setPair(prog, '--width', String(runtime.width))
  if (runtime.height) setPair(prog, '--height', String(runtime.height))
  setFlag(prog, '--fullscreen', runtime.fullscreen)

  return [...jvm, ...prog]
}

/**
 * 打日志用的命令行（**脱敏**）。
 *
 * `--accessToken` 后面那个值是玩家的登录凭据：日志会被玩家复制发给我们排障，
 * 也会被写进 uishot 产物，所以它绝不能原样出现。
 */
export function redactCommandLine(java: string, args: string[]): string {
  const shown = args.map((a, i) => {
    if (i > 0 && args[i - 1] === '--accessToken') return '***'
    if (/^-Ddelta\.launcher\.(token|leaseKey)=/.test(a)) return a.slice(0, a.indexOf('=') + 1) + '***'
    return a
  })
  return `${java} ${shown.join(' ')}`
}

// ---------------------------------------------------------------------------
// 自测（`--launchargstest`，与其它自测同一套输出格式）
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function check(name: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    passed++
    console.log(`    ✓ ${name}`)
  } else {
    failed++
    console.log(`    ✗ ${name}${actual === undefined ? '' : `（实际: ${String(actual)}）`}`)
  }
}

function section(title: string): void {
  console.log()
  console.log(`── ${title}`)
}

export function runLaunchArgsSelfTest(): number {
  const base = ['-Djava.library.path=natives', '-cp', 'a;b', '-Xmx2G', '-Xms512M', '-Dfile.encoding=UTF-8']
  const program = ['--username', 'Steve', '--width', '854', '--height', '480', '--accessToken', 'SECRET', '--version', '1.20.1']
  const runtime: RuntimeArgs = { memoryMb: 6144, width: 1600, height: 900, fullscreen: true }

  section('内存：模板里的 -Xmx/-Xms 必须被摘掉，只留我们这一个')
  const args = buildLaunchArgs(base, program, runtime)
  const heap = args.filter((a) => /^-Xm/i.test(a))
  check('命令行里只有一个 -Xm* 参数', heap.length === 1, heap)
  check('就是我们的 -Xmx6144M', heap[0] === '-Xmx6144M', heap[0])
  check('其它 jvm 参数原样保留', args.includes('-Dfile.encoding=UTF-8') && args.includes('-cp'))

  section('分辨率的两种写法都要摘干净')
  check('-Xmx8G 形式', !buildLaunchArgs(['-Xmx8G'], [], runtime).includes('-Xmx8G'))
  const spaced = buildLaunchArgs(['-Xmx', '8G'], [], runtime)
  check('"-Xmx 8G" 形式：值也要一起摘掉（不留孤立的 8G）', !spaced.includes('8G'), spaced)

  section('--width/--height 是**替换**不是追加')
  const w = args.filter((a) => a === '--width')
  check('--width 只出现一次', w.length === 1, w.length)
  check('值是玩家设置的 1600', args[args.indexOf('--width') + 1] === '1600', args[args.indexOf('--width') + 1])
  check('--height 同理', args[args.indexOf('--height') + 1] === '900')

  section('--fullscreen 是开关')
  check('true ⇒ 有 --fullscreen', args.includes('--fullscreen'))
  const off = buildLaunchArgs(base, program, { ...runtime, fullscreen: false })
  check('false ⇒ 没有 --fullscreen', !off.includes('--fullscreen'))

  section('没设分辨率时不乱动模板')
  const untouched = buildLaunchArgs(base, program, { ...runtime, width: null, height: null })
  check('模板里的 --width=854 保持原值', untouched[untouched.indexOf('--width') + 1] === '854')

  section('启动器来源令牌：必须在主类之前（否则会被当成游戏参数）')
  const withToken = buildLaunchArgs(base, program, { ...runtime, launcherToken: 'Alex|123|abc' })
  check('令牌确实在命令行里', withToken.includes('-Ddelta.launcher.token=Alex|123|abc'))
  const cpAt = withToken.indexOf('-cp')
  const tokAt = withToken.indexOf('-Ddelta.launcher.token=Alex|123|abc')
  check('它排在 -cp（主类之前）的前面', tokAt >= 0 && cpAt >= 0 && tokAt < cpAt, `${tokAt} vs ${cpAt}`)
  const noToken = buildLaunchArgs(base, program, { ...runtime, launcherToken: null })
  check('没拿到令牌时**不伪造**该参数', !noToken.some((a) => a.startsWith('-Ddelta.launcher.token=')))
  check('令牌不影响其它参数', noToken.filter((a) => /^-Xm/.test(a)).length === 1)

  section('动态 Agent 加载与外部 Attach 关闭，官方登录 Agent 仍可用')
  const hardened = buildLaunchArgs([
    '-XX:+EnableDynamicAgentLoading', '-XX:-EnableDynamicAgentLoading',
    '-javaagent:authlib.jar=login-endpoint', '-cp', 'a;b', 'net.example.Main'
  ], [], runtime)
  check('动态加载开关仅一个且关闭', hardened.filter(a => a.includes('EnableDynamicAgentLoading')).join() === '-XX:-EnableDynamicAgentLoading')
  check('安全开关位于主类前', hardened.indexOf('-XX:-EnableDynamicAgentLoading') < hardened.indexOf('net.example.Main'))
  check('内存参数位于主类前', hardened.indexOf('-Xmx6144M') < hardened.indexOf('net.example.Main'))
  check('保留启动时登录 Agent', hardened.includes('-javaagent:authlib.jar=login-endpoint'))
  check('关闭外部 Attach，启动时登录 Agent 仍保留', hardened.includes('-XX:+DisableAttachMechanism'))

  section('GC 配置：模板原样保留，调优档只留一套并放在 -cp 前')
  const gcTemplate = ['-XX:+UseG1GC', '-XX:G1ReservePercent=15', '-XX:MaxGCPauseMillis=50', '-XX:MaxMetaspaceSize=1G', '-javaagent:auth.jar', '-cp', 'a;b', 'net.example.Main']
  const templateMode = buildLaunchArgs(gcTemplate, [], { ...runtime, gcMode: 'template', javaMajor: 17 })
  check('template 模式保留模板 GC 参数', templateMode.includes('-XX:G1ReservePercent=15') && templateMode.includes('-XX:+UseG1GC'))
  const tunedMode = buildLaunchArgs(gcTemplate, [], { ...runtime, gcMode: 'tuned', javaMajor: 17 })
  check('tuned 模式使用 reserve=20 且删除模板 reserve=15', tunedMode.includes('-XX:G1ReservePercent=20') && !tunedMode.includes('-XX:G1ReservePercent=15'))
  check('Unlock 在 -cp 前，登录 agent 与 attach 硬化保留', tunedMode.indexOf('-XX:+UnlockExperimentalVMOptions') < tunedMode.indexOf('-cp') && tunedMode.includes('-javaagent:auth.jar') && tunedMode.includes('-XX:+DisableAttachMechanism'))

  section('脱敏：玩家凭据绝不能进日志')
  const line = redactCommandLine('C:\\java\\bin\\java.exe', args)
  check('日志里没有 SECRET', !line.includes('SECRET'), line.slice(0, 80))
  check('用 *** 顶替', line.includes('--accessToken ***'))
  check('命令里仍然**带着**真 token（脱敏只影响日志）', args.includes('SECRET'))

  console.log()
  console.log(`通过 ${passed} / 失败 ${failed}`)
  return failed === 0 ? 0 : 1
}
