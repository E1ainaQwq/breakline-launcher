import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, delimiter } from 'node:path'

/**
 * 枚举本机可用的 Java（片 2）。
 *
 * <h2>为什么要"探测 + 列出"而不是让玩家自己填路径</h2>
 * 玩家填路径的失败方式太多了（填了目录不是 exe、填了 javaw、路径里有空格没引号、
 * 填了个 JRE 8 起不来 1.20.1……），而每一种的外部表现都只是"点了启动没反应"。
 * 列出**能用的**、并显示版本与架构，能把这一整类问题提前消掉。
 *
 * <h2>三条纪律</h2>
 * <ol>
 *   <li><b>只报真的能跑起来的</b>：每个候选都要实际执行 `-version` 并解析输出，
 *       跑不起来的不进列表（宁可列表短，也不要给出一个点了就失败的选择）。</li>
 *   <li><b>架构要说清楚</b>：32 位 Java 起不了现代 MC，而报错信息完全指不到这一点。</li>
 *   <li><b>探测有超时</b>：坏掉的 Java 可能挂住，探测不能把启动器一起拖住。</li>
 * </ol>
 */

export interface JavaCandidate {
  /** java.exe 的完整路径 */
  path: string
  /** 展示用版本，例如 `17.0.12` */
  version: string
  /** 主版本号（17 / 8 …），用于标出"这个太老，起不了 1.20.1" */
  major: number
  /** `64` / `32` / `?` */
  arch: string
  /** 来源：`已下载` / `系统安装` / `PATH` —— 让玩家知道自己选的是什么 */
  from: string
  /** 是否能跑我们这版游戏（>=17 且 64 位） */
  usable: boolean
}

/** 我们自己的 Java 目录（片 3 会把下载来的 JDK 放这里）。 */
export function managedJavaDir(): string {
  return join(app.getPath('userData'), 'java')
}

/** 常见安装位置（够覆盖绝大多数机器，且**不做全盘扫描**——那要几十秒）。 */
function candidatePaths(extraHomes: string[] = []): Array<{ path: string; from: string }> {
  const out: Array<{ path: string; from: string }> = []
  const push = (dir: string, from: string): void => {
    const exe = join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    if (existsSync(exe)) out.push({ path: exe, from })
  }
  for (const home of [process.env.JAVA_HOME, ...extraHomes].filter((v): v is string => !!v)) {
    push(home, '已有运行环境')
    for (const suffix of ['java', 'jdk17', 'runtime/java-runtime-gamma/windows-x64/java-runtime-gamma', 'runtime/java-runtime-gamma/windows-x86_64/java-runtime-gamma'])
      push(join(home, suffix), '游戏包自带')
  }

  // ① 我们自己下载的（可能有多层版本目录）
  const managed = managedJavaDir()
  if (existsSync(managed)) {
    try {
      for (const entry of readdirSync(managed)) {
        if (entry.startsWith('.install-jdk17-')) continue
        push(join(managed, entry), '已下载')
        // Provisioning preserves the publisher's version directory under jdk17.
        if (entry === 'jdk17') {
          for (const version of readdirSync(join(managed, entry))) push(join(managed, entry, version), '已下载')
        }
      }
    } catch {
      // 目录读不了就当没有
    }
    push(managed, '已下载')
  }

  // ② 常见系统安装位置
  for (const base of [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Amazon Corretto',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Java')
  ]) {
    if (!base || !existsSync(base)) continue
    try {
      for (const entry of require('node:fs').readdirSync(base) as string[]) {
        push(join(base, entry), '系统安装')
      }
    } catch {
      // 同上
    }
  }

  // ③ PATH 里的（最后兜底：玩家可能自己配过）
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir.trim()) continue
    const executable = join(dir.trim(), process.platform === 'win32' ? 'java.exe' : 'java')
    if (existsSync(executable)) out.push({ path: executable, from: 'PATH' })
  }
  return out
}

/** 跑 `java -version` 解析出版本与架构；跑不起来返回 null。 */
function probe(exe: string): Promise<{ version: string; major: number; arch: string } | null> {
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { timeout: 4000, windowsHide: true }, (error, stdout, stderr) => {
      // ⚠️ `java -version` 把版本写到 **stderr**（不是 stdout）—— 只读 stdout 会永远解析不到。
      if (error) { resolve(null); return }
      const text = String(stderr || '') + String(stdout || '')
      const m = /version "([^"]+)"/.exec(text)
      if (!m) {
        resolve(null)
        return
      }
      const version = m[1]
      const major = Number.parseInt(version.split('.')[0] === '1' ? version.split('.')[1] : version.split('.')[0], 10)
      const arch = /64-Bit/i.test(text) ? '64' : /32-Bit/i.test(text) ? '32' : '?'
      resolve({ version, major: Number.isFinite(major) ? major : 0, arch })
    })
  })
}

/** 列出所有**真的能跑**的 Java，去重后按"能不能用"和版本排序。 */
export async function listJavas(extraHomes: string[] = []): Promise<JavaCandidate[]> {
  const seen = new Set<string>()
  const out: JavaCandidate[] = []
  const candidates = candidatePaths(extraHomes).filter(cand => {
    const key = cand.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // Four bounded probes at a time; a broken Java must not block every other candidate.
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
   while (cursor < candidates.length) {
    const cand = candidates[cursor++]
    const info = await probe(cand.path)
    if (!info) continue
    out.push({
      path: cand.path,
      version: info.version,
      major: info.major,
      arch: info.arch,
      from: cand.from,
      usable: info.major === 17 && info.arch === '64'
    })
   }
  }))
  out.sort((a, b) => Number(b.usable) - Number(a.usable) || b.major - a.major)
  return out
}

/** 校验一个玩家填/选的 Java 路径：必须是存在的 java.exe，且**真的能跑**。 */
export async function validateJava(path: string): Promise<{ ok: boolean; error?: string; version?: string; major?: number }> {
  const p = (path ?? '').trim()
  if (!p) return { ok: false, error: '路径为空' }
  if (!existsSync(p)) return { ok: false, error: '这个路径上找不到文件' }
  if (!(process.platform === 'win32' ? /java(w)?\.exe$/i : /\/java$/).test(p)) return { ok: false, error: '请选择 Java 可执行文件' }
  const info = await probe(p)
  if (!info) return { ok: false, error: '这个 java 跑不起来（执行 -version 失败）' }
  if (info.major !== 17 || info.arch !== '64') return { ok: false, error: `需要 Java 17（64 位），检测到 ${info.version}（${info.arch} 位）` }
  return { ok: true, version: info.version, major: info.major }
}
