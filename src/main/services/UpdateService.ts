import { createHash } from 'node:crypto'
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { downloadPinnedSources, downloadQueue } from './PinnedDownload'
import { dirname, join } from 'node:path'

/**
 * 整合包自动更新（运维队列第 3 项）。
 *
 * <h2>它补的是哪个洞</h2>
 * 启动器早就会"核对整合包、不一致就拒绝启动"（M2），但**没有补差异的能力**——
 * 于是玩家一旦缺一个 jar，唯一的出路是手工重下整个整合包（1 GB / 4 Mbps ≈ 35 分钟）。
 * 更新器的目标就一句话：**让"不一致"变成可自动修复的状态，而不是一句拒绝**。
 *
 * <h2>信任链（这是整块设计里最要紧的一点）</h2>
 * ```
 * 服务端清单（权威，含 size + sha256 + 下载地址）
 *   → 差量比对（只下缺的/被改的）
 *   → 下载后**独立重算 sha256**，对不上就丢弃重试
 *   → 全部就绪后**原子替换**（先备份，失败则整体回滚）
 * ```
 * 少任何一步都不行：
 * - 不比对 → 每次全量下 316 MB；
 * - 不重算哈希 → 一个坏包/CDN 投毒会**替换掉本来正确的文件**，比不更新更糟；
 * - 不原子 → 下到一半断网，玩家得到一个"半新半旧"的整合包，
 *   而那种状态在游戏里表现为随机崩溃，极难归因。
 *
 * <h2>刻意不做的事</h2>
 * 1. **不删"清单之外"的文件**：它们会移到可恢复备份，既不参与 Forge 握手，
 *    也不会被不可逆地删除。
 * 2. **不碰 `.pre-*` / `.pending-*` 之类的部署留档**：那是运维替换模组时留的备份，
 *    既不该被当成整合包内容，也不该被更新器清掉（清理由 `prune-mods-backups` 单独做）。
 * 3. **不接受"下载地址"是相对路径之外的东西**：地址来自我们自己的清单，
 *    但这里仍然只允许 http(s)，避免清单被改之后把玩家指向 `file://` 之类的怪东西。
 */

export interface ManifestEntry {
  name: string
  sha256: string
  size: number
  url: string
  /** Signed alternate URL; used when the public CDN is unavailable. */
  fallbackUrl?: string
}

export interface PackManifest {
  packVersion: string
  gameVersion: string
  generatedAt?: string
  files: ManifestEntry[]
}

export interface UpdateDiff {
  /** 本地缺失，需要下载 */
  missing: ManifestEntry[]
  /** 本地存在但哈希不符，需要重下 */
  changed: ManifestEntry[]
  /** 本地多出来的 jar（**不自动删**，只报告） */
  extra: string[]
  /** 本地已符合清单 */
  ok: number
  /** 清单里有、但本地文件大小已经一致（可以省一次哈希的统计用，不参与决策） */
  total: number
}

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'applying' | 'done' | 'error'

export interface UpdateProgress {
  phase: UpdatePhase
  /** 0–100（按字节数算，不是按文件数——按文件数会让大 jar 的进度条卡住不动） */
  percent: number
  doneFiles: number
  totalFiles: number
  bytesDone: number
  bytesTotal: number
  /** 当前在下的文件名（界面显示用） */
  current?: string
  message?: string
}

export interface ApplyResult {
  ok: boolean
  applied: string[]
  /** 清单外 jar 已移出 mods/，保存在 backupDir/extras/，可手动恢复。 */
  quarantined?: string[]
  failed?: string
  /** 回滚是否成功执行（失败时必须知道"现在磁盘上是旧的一套还是新的"） */
  rolledBack?: boolean
  backupDir?: string
}

/** Bound simultaneous file downloads without serializing every library. */
const CONCURRENCY = 6
/** 清单条目上限：清单来自服务端，坏了也不能让启动器 OOM。 */
const MAX_FILES = 20000

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Cross-volume transfers commit a verified copy on the destination volume first. */
export function moveVerifiedFile(source: string, destination: string): void {
  try { renameSync(source, destination); return }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error }
  const temporary = destination + '.moving-' + process.pid
  try {
    copyFileSync(source, temporary)
    if (statSync(source).size !== statSync(temporary).size || sha256File(source) !== sha256File(temporary)) {
      throw new Error('跨盘文件复制校验失败，原文件已保留')
    }
    renameSync(temporary, destination)
    rmSync(source)
  } finally { rmSync(temporary, { force: true }) }
}

/**
 * 部署留档：**不算整合包内容**。
 *
 * Forge 只加载以 `.jar` 结尾的文件，所以 `xxx.jar.pre-20260917` 这类留档
 * 对游戏没有任何影响 —— 但它们会污染"多出"的统计，让玩家以为自己装错了东西。
 * （2026-09-17 就因为这个把留档数成了"有两个 deltaac"。）
 */
function isDeploymentLeftover(name: string): boolean {
  return /\.(pre|pending|bak|old|orig)[-._]/i.test(name)
}

export class UpdateService {
  constructor(
    /** 整合包（mods）目录 */
    private readonly modsDir: string,
    /** 本次更新的暂存目录（`<userData>/update-staging`） */
    private readonly stagingDir: string,
    /** 备份目录（`<userData>/update-backup`） */
    private readonly backupDir: string,
    /** 进度回调（节流由调用方决定） */
    private readonly onProgress: (p: UpdateProgress) => void = () => {}
  ) {}

  /** 本地现状：只统计真正的模组 jar，跳过部署留档。 */
  localHashes(): Record<string, string> {
    const out: Record<string, string> = {}
    if (!existsSync(this.modsDir)) return out
    for (const name of readdirSync(this.modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue
      if (isDeploymentLeftover(name)) continue
      try {
        out[name] = sha256File(join(this.modsDir, name))
      } catch {
        // 读不到就当它不存在：更新器会把它当"缺失"重下，比整轮失败好
      }
    }
    return out
  }

  /**
   * 差量比对。**纯读，不改任何文件**——界面可以在"检查更新"时放心调用。
   *
   * 为什么先比 size 再算哈希：清单里带 size 是有用的——大小都不一样就没必要
   * 读整个文件算哈希（79 个 jar、316 MB，全算一遍在机械盘上要好几秒）。
   * 注意这只是**加速**，size 相同仍然要算哈希。
   */
  diff(manifest: PackManifest): UpdateDiff {
    const entries = (manifest.files ?? []).filter((f) => f && typeof f.name === 'string')
    const expected = new Map(entries.map((f) => [f.name, f]))
    const localNames = existsSync(this.modsDir)
      ? readdirSync(this.modsDir).filter(
          (n) => n.toLowerCase().endsWith('.jar') && !isDeploymentLeftover(n)
        )
      : []

    const missing: ManifestEntry[] = []
    const changed: ManifestEntry[] = []
    let ok = 0
    for (const e of entries) {
      const p = join(this.modsDir, e.name)
      if (!existsSync(p)) {
        missing.push(e)
        continue
      }
      let same = false
      try {
        if (typeof e.size === 'number' && statSync(p).size === e.size) {
          // size 相同只是"值得算一次哈希"，不是判据本身
          same = sha256File(p) === e.sha256
        }
      } catch {
        same = false
      }
      if (same) ok++
      else changed.push(e)
    }
    const extra = localNames.filter((n) => !expected.has(n))
    return { missing, changed, extra, ok, total: entries.length }
  }

  /** 下载 + 校验 + 原子替换。清单外 jar 会可恢复地移出 mods/。任何一步失败 → 回滚。 */
  async apply(manifest: PackManifest): Promise<ApplyResult> {
    const d = this.diff(manifest)
    const todo = [...d.missing, ...d.changed]
    const bytesTotal = todo.reduce((s, e) => s + (e.size || 0), 0)
    const progress: UpdateProgress = {
      phase: 'downloading',
      percent: 0,
      doneFiles: 0,
      totalFiles: todo.length,
      bytesDone: 0,
      bytesTotal
    }
    const emit = (): void => this.onProgress({ ...progress })
    emit()

    if (todo.length === 0 && d.extra.length === 0) {
      try { this.writeBaseline(manifest) }
      catch (err) { return { ok: false, applied: [], failed: String(err) } }
      this.onProgress({ ...progress, phase: 'done', percent: 100, message: '已是最新' })
      return { ok: true, applied: [] }
    }

    const runDir = join(this.stagingDir, createHash('sha256').update(JSON.stringify(todo.map(e => [e.name, e.sha256]))).digest('hex'))
    mkdirSync(runDir, { recursive: true })
    let bytesDone = 0

    // ---- 1) 并发下载到暂存目录，每个文件**下完即校验** ----
    const queue = [...todo]
    const downloaded: string[] = []
    const worker = async (): Promise<void> => {
      for (;;) {
        const e = queue.shift()
        if (!e) return
        progress.current = e.name
        emit()
        const dst = join(runDir, e.name)
        await this.downloadOne(e, dst, (n) => {
          bytesDone += n
          progress.bytesDone = bytesDone
          progress.percent = bytesTotal > 0 ? Math.min(99, Math.floor((bytesDone / bytesTotal) * 100)) : 0
          emit()
        }, () => { progress.message = '连接中断，自动切源并续传…'; emit() })
        downloaded.push(e.name)
        progress.message = undefined
        progress.doneFiles++
        emit()
      }
    }
    try {
      await downloadQueue(Array.from({ length: Math.min(CONCURRENCY, queue.length) }), CONCURRENCY, worker)
    } catch (err) {
      // 下载阶段失败：**磁盘上的 mods/ 一个字节都没动**，清掉暂存即可
      // Preserve verified downloads and checksum-bound partial files for the next click.
      const message = err instanceof Error ? err.message : String(err)
      this.onProgress({ ...progress, phase: 'error', message })
      return { ok: false, applied: [], failed: message }
    }

    // ---- 2) 原子替换（先全部备份，再全部换入；失败则整体回滚）----
    progress.phase = 'applying'
    progress.percent = 99
    emit()
    const backupRunDir = join(this.backupDir, String(Date.now()))
    const applied: string[] = []
    const affected: string[] = []
    const originallyPresent = new Set<string>()
    const quarantined: string[] = []
    try {
      mkdirSync(this.modsDir, { recursive: true })
      for (const name of d.extra) {
        mkdirSync(join(backupRunDir, 'extras'), { recursive: true })
        quarantined.push(name)
        moveVerifiedFile(join(this.modsDir, name), join(backupRunDir, 'extras', name))
      }
      for (const name of downloaded) {
        const target = join(this.modsDir, name)
        affected.push(name)
        if (existsSync(target)) {
          originallyPresent.add(name)
          mkdirSync(backupRunDir, { recursive: true })
          // 备份可能位于另一块磁盘，复制校验成功后才移除原文件。
          moveVerifiedFile(target, join(backupRunDir, name))
        }
        // 跨盘时先写目标盘临时文件，再改名，mods 中不会出现半个 jar。
        moveVerifiedFile(join(runDir, name), target)
        applied.push(name)
      }
      this.writeBaseline(manifest)
    } catch (err) {
      const failed = err instanceof Error ? err.message : String(err)
      let rolledBack = false
      try {
        for (const name of affected) {
          const bak = join(backupRunDir, name)
          const target = join(this.modsDir, name)
          if (existsSync(bak)) {
            if (existsSync(target)) rmSync(target, { force: true })
            moveVerifiedFile(bak, target)
          } else {
            // 原本不存在（新增文件）→ 回滚就是删掉它
            if (!originallyPresent.has(name) && existsSync(target)) rmSync(target, { force: true })
          }
        }
        for (const name of quarantined) {
          const saved = join(backupRunDir, 'extras', name)
          if (existsSync(saved)) {
            const target = join(this.modsDir, name)
            if (existsSync(target)) rmSync(target, { force: true })
            moveVerifiedFile(saved, target)
          }
        }
        rolledBack = true
      } catch {
        rolledBack = false
      }
      this.rmQuiet(runDir)
      this.onProgress({ ...progress, phase: 'error', message: failed })
      return {
        ok: false,
        applied,
        failed,
        rolledBack,
        backupDir: existsSync(backupRunDir) ? backupRunDir : undefined
      }
    }
    this.rmQuiet(runDir)
    this.onProgress({ ...progress, phase: 'done', percent: 100, message: `已更新 ${applied.length} 个文件；已隔离 ${quarantined.length} 个清单外文件` })
    return { ok: true, applied, quarantined, backupDir: existsSync(backupRunDir) ? backupRunDir : undefined }
  }

  /** Use the verified release manifest, including on an otherwise unchanged install. */
  private writeBaseline(manifest: PackManifest): void {
    const config = join(dirname(this.modsDir), 'config')
    mkdirSync(config, { recursive: true })
    const target = join(config, 'deltaac-mods-baseline.properties')
    const text = '# Launcher verified release: ' + manifest.packVersion + '\n' +
      [...manifest.files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        .map(f => `${f.name}=${f.sha256}`).join('\n') + '\n'
    if (existsSync(target) && readFileSync(target, 'utf8') === text) return
    const temp = target + '.tmp'
    try { writeFileSync(temp, text, 'utf8'); renameSync(temp, target) }
    finally { rmSync(temp, { force: true }) }
  }

  /**
   * 单个文件下载：**带重试与断点续传**，下完必须校验哈希。
   *
   * 为什么每一处都必要：
   * - 重试：家庭宽带下 316 MB 里断一次是常态；失败即整轮重来会让人永远升不完。
   * - 续传：`.part` 文件在下次尝试时用 `Range` 接着下。服务器不支持 Range（返回 200）
   *   就从头下 —— **不能假设 CDN 一定支持**。
   * - 校验：这是唯一的"内容可信"环节。哈希对不上就删掉重下，**绝不把坏文件换进 mods/**。
   */
  private async downloadOne(
    e: ManifestEntry,
    dst: string,
    onBytes: (n: number) => void,
    onRetry: () => void = () => {}
  ): Promise<void> {
    const sources = [...new Set([e.url, ...(e.fallbackUrl ? [e.fallbackUrl] : [])])]
    if (existsSync(dst) && statSync(dst).size === e.size && sha256File(dst) === e.sha256) {
      onBytes(e.size); return
    }
    let counted = 0
    await downloadPinnedSources(sources, `${dst}.part`, e.sha256, {
      size: e.size,
      onReceived: bytes => { onBytes(bytes - counted); counted = bytes },
      onRetry: (_, attempt) => { if (attempt > 1) onRetry() }
    })
    renameSync(`${dst}.part`, dst)
  }

  private rmQuiet(p: string): void {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {
      /* 尽力而为 */
    }
  }
}

/**
 * 清单校验：**在信任它的内容之前先检查形状**。
 *
 * 清单来自网络。一份 `files: null` 或 sha256 缺失的清单，会让比对逻辑
 * 把"所有文件都不一致"当成结论 —— 于是玩家被引导去重下整个整合包。
 * 这类"看起来在工作"的错误最难发现，所以宁可直接拒绝。
 */
export function validateManifest(raw: unknown): { ok: true; manifest: PackManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'manifest 不是对象' }
  const m = raw as Partial<PackManifest>
  if (!Array.isArray(m.files)) return { ok: false, error: 'manifest.files 不是数组' }
  if (m.files.length > MAX_FILES) return { ok: false, error: `manifest 条目过多（${m.files.length}）` }
  const seen = new Set<string>()
  for (const f of m.files) {
    if (!f || typeof f.name !== 'string' || !f.name) return { ok: false, error: '有条目缺少 name' }
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
      return { ok: false, error: `${f.name} 的 sha256 不是 64 位十六进制` }
    }
    if (typeof f.url !== 'string' || !/^https?:\/\//i.test(f.url)) {
      return { ok: false, error: `${f.name} 的 url 不合法` }
    }
    if (f.fallbackUrl !== undefined && (typeof f.fallbackUrl !== 'string' || !/^https:\/\//i.test(f.fallbackUrl))) {
      return { ok: false, error: `${f.name} 的备用下载地址不合法` }
    }
    if (typeof f.size !== 'number' || f.size < 0) return { ok: false, error: `${f.name} 的 size 不合法` }
    if (seen.has(f.name)) return { ok: false, error: `清单里有重名条目：${f.name}` }
    seen.add(f.name)
  }
  return {
    ok: true,
    manifest: {
      packVersion: typeof m.packVersion === 'string' ? m.packVersion : 'unknown',
      gameVersion: typeof m.gameVersion === 'string' ? m.gameVersion : 'unknown',
      generatedAt: m.generatedAt,
      files: m.files as ManifestEntry[]
    }
  }
}
