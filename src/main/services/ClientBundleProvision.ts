import { app } from 'electron'
import { fetchResourceManifest, resourceDownloadUrl } from './ManifestAuth'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { downloadPinnedSources, downloadQueue, pinnedHash } from './PinnedDownload'

export interface BundleProgress { phase: 'checking' | 'downloading' | 'extracting' | 'done' | 'error'; percent: number; message: string }
export interface BundleResult { ok: boolean; changed: boolean; bytes?: number; removed?: number; error?: string }
type Manifest = { ok: boolean; name: string; size: number; sha256: string; url: string; error?: string; incremental?: { version: number; files: (BundleFile & { url: string })[] } }
type BundleFile = { path: string; size: number; sha256: string }

function runPowerShell(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const at = args.indexOf('-Command')
    const encoded = at < 0 ? args : [...args.slice(0, at), '-EncodedCommand', Buffer.from(args[at + 1], 'utf16le').toString('base64')]
    const child = spawn('powershell.exe', encoded, { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('资源解压超过 3 分钟，下载文件已保留，再点一次会继续安装')) }, 180_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); resolve(code ?? -1) })
  })
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function cleanBundlePartCache(cache: string): void {
  if (!existsSync(cache)) return
  for (const name of readdirSync(cache)) {
    if (name === 'client-bundle.zip.part' || /^client-bundle\.[a-f0-9]{64}\.zip\.part$/.test(name)) rmSync(join(cache, name), { force: true })
  }
}

function bundlePath(gameDir: string, relative: string): string {
  if (relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('客户端资源路径无效')
  const root = resolve(gameDir), target = resolve(root, relative)
  if (!target.startsWith(root + sep)) throw new Error('客户端资源路径越界')
  for (let p = target; p !== root; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('客户端资源路径不能是链接')
  }
  return target
}

function bundleInventory(gameDir: string): BundleFile[] {
  const files: unknown = JSON.parse(readFileSync(join(gameDir, '.delta-client-files.json'), 'utf8'))
  return validateInventory(files, gameDir)
}

function validateInventory(files: unknown, gameDir: string): BundleFile[] {
  if (!Array.isArray(files) || files.length > 100_000) throw new Error('客户端资源清单无效')
  const seen = new Set<string>()
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !/^(tacz|config|resourcepacks)\//.test(f.path) || !Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('客户端资源清单条目无效')
    bundlePath(gameDir, f.path)
    if (seen.has(f.path.toLowerCase())) throw new Error('客户端资源清单存在重复路径')
    seen.add(f.path.toLowerCase())
  }
  return files as BundleFile[]
}

/** A release marker alone cannot prove that the installed gun packs still exist. */
export function verifyBundleFiles(gameDir: string, reuseDir?: string): boolean {
  try {
    const files = bundleInventory(gameDir)
    return files.length > 0 && files.every(f => {
      const staged = bundlePath(gameDir, f.path)
      const target = !existsSync(staged) && reuseDir ? bundlePath(reuseDir, f.path) : staged
      return statSync(target).isFile() && statSync(target).size === f.size && sha256(target) === f.sha256
    })
  } catch { return false }
}

async function verifyBundleFilesResponsive(gameDir: string, report: (p: BundleProgress) => void, authoritativeFiles?: BundleFile[]): Promise<boolean> {
  try {
    const files = authoritativeFiles ?? bundleInventory(gameDir)
    if (!files.length) return false
    for (let i = 0; i < files.length; i++) {
      const file = files[i], target = bundlePath(gameDir, file.path)
      if (!statSync(target).isFile() || statSync(target).size !== file.size || await pinnedHash(target, 'sha256') !== file.sha256) return false
      if (i % 50 === 0) report({ phase: 'checking', percent: Math.round(i / files.length * 100), message: `检查已有枪械资源 ${i + 1}/${files.length}，无需重新下载` })
    }
    return true
  } catch { return false }
}

/** Install only manifest-owned files; obsolete official resources are removed in the same rollback transaction. */
export function installBundleFiles(staged: string, gameDir: string, digest: string, reuseUnchanged = false): number {
  if (!verifyBundleFiles(staged, reuseUnchanged ? gameDir : undefined)) throw new Error('客户端资源解压后校验失败')
  const files = bundleInventory(staged)
  const previous = existsSync(join(gameDir, '.delta-client-files.json')) ? bundleInventory(gameDir) : []
  const names = new Set(files.map(f => f.path.toLowerCase()))
  const obsolete = previous.filter(f => !names.has(f.path.toLowerCase()) && existsSync(bundlePath(gameDir, f.path)))
    // Player-edited retired configs remain personal files; immutable resource content remains launcher-owned.
    .filter(f => f.path.startsWith('tacz/') || sha256(bundlePath(gameDir, f.path)) === f.sha256)
  writeFileSync(join(staged, '.delta-client-bundle.sha256'), digest + '\n', 'utf8')
  const install = [...files.filter(f => {
    const target = bundlePath(gameDir, f.path)
    return !existsSync(target) || !statSync(target).isFile() || statSync(target).size !== f.size || sha256(target) !== f.sha256
  }).map(f => f.path), '.delta-client-files.json', '.delta-client-bundle.sha256']
  const backup = mkdtempSync(join(resolve(gameDir), '.delta-bundle-rollback-'))
  const saved: string[] = [], applied: string[] = []
  const discardBackup = (): void => {
    if (!resolve(backup).startsWith(resolve(gameDir) + sep)) throw new Error('资源回滚目录越界')
    rmSync(backup, { recursive: true, force: true })
  }
  try {
    for (const name of [...obsolete.map(f => f.path), ...install]) {
      const target = bundlePath(gameDir, name)
      if (!existsSync(target)) continue
      if (!statSync(target).isFile()) throw new Error('客户端资源位置被目录占用：' + name)
      const savedPath = bundlePath(backup, name)
      mkdirSync(dirname(savedPath), { recursive: true }); renameSync(target, savedPath); saved.push(name)
    }
    for (const name of install) {
      const target = bundlePath(gameDir, name)
      mkdirSync(dirname(target), { recursive: true })
      applied.push(name)
      copyFileSync(bundlePath(staged, name), target)
    }
    if (!verifyBundleFiles(gameDir)) throw new Error('客户端资源安装后校验失败')
  } catch (e) {
    try {
      for (const name of applied) rmSync(bundlePath(gameDir, name), { force: true })
      for (const name of saved) renameSync(bundlePath(backup, name), bundlePath(gameDir, name))
      discardBackup()
    } catch { throw new Error('客户端资源安装失败且回滚未完成，原文件保留在：' + backup) }
    throw e
  }
  discardBackup()
  for (const file of obsolete) {
    for (let parent = dirname(file.path).replace(/\\/g, '/'); parent.includes('/'); parent = dirname(parent).replace(/\\/g, '/')) {
      try { rmdirSync(bundlePath(gameDir, parent)) } catch { break } // Never remove directories containing personal files.
    }
  }
  return obsolete.length
}

/** 下载并安装 config/tacz/resourcepacks 等客户端资源，不依赖 HMCL。 */
export async function provisionClientBundle(
  apiBase: string,
  gameDir: string,
  onProgress: (p: BundleProgress) => void = () => {}
): Promise<BundleResult> {
  try {
    onProgress({ phase: 'checking', percent: 0, message: '检查客户端资源包…' })
    const m = await fetchResourceManifest(apiBase, '/api/client/bundle/manifest') as Partial<Manifest>
    if (!m.ok || !m.url || !m.sha256 || !m.size) throw new Error(m.error ?? '客户端资源清单无效')
    if (!/^[a-f0-9]{64}$/i.test(m.sha256) || !Number.isSafeInteger(m.size) || m.size < 1) throw new Error('客户端资源清单无效')
    const source = resourceDownloadUrl(m.url, apiBase, '/api/client/bundle/file')
    const totalBytes = m.size
    const marker = join(gameDir, '.delta-client-bundle.sha256')
    const cache = join(app.getPath('userData'), 'downloads')
    const authoritativeFiles = m.incremental?.version === 1 ? validateInventory(m.incremental.files, gameDir) : undefined
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim().toLowerCase() === m.sha256.toLowerCase() && await verifyBundleFilesResponsive(gameDir, onProgress, authoritativeFiles)) {
      cleanBundlePartCache(cache)
      onProgress({ phase: 'done', percent: 100, message: '客户端资源完整' })
      return { ok: true, changed: false, bytes: m.size }
    }
    mkdirSync(cache, { recursive: true })
    if (m.incremental?.version === 1) {
      const files = validateInventory(m.incremental.files, gameDir)
      if (!files.length) throw new Error('客户端资源增量清单为空')
      const urls = new Map<string, string>()
      for (const f of m.incremental.files) {
        const route = '/api/client/bundle/object/' + f.sha256
        const url = resourceDownloadUrl(f.url, apiBase, route)
        if (url.pathname !== route || url.search || url.hash) throw new Error('客户端资源对象地址无效')
        urls.set(f.path, url.href)
      }
      const changed = files.filter(f => {
        const target = bundlePath(gameDir, f.path)
        return !existsSync(target) || !statSync(target).isFile() || statSync(target).size !== f.size || sha256(target) !== f.sha256
      })
      const bytes = changed.reduce((n, f) => n + f.size, 0)
      // A fresh installation is cheaper as a compressed archive, while small updates use objects.
      if (changed.length <= 512 && bytes <= m.size * 0.7) {
        const staged = mkdtempSync(join(cache, 'client-bundle-install-'))
        const objects = join(cache, 'client-objects')
        mkdirSync(objects, { recursive: true })
        let removed = 0
        let unavailable = false
        try {
          writeFileSync(join(staged, '.delta-client-files.json'), JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))))
          const received = new Map<string, number>()
          // Duplicate content uses one cache writer, even if installed at multiple paths.
          const unique = [...new Map(changed.map(f => [f.sha256, f])).values()]
          await downloadQueue(unique, 6, async f => {
            const part = join(objects, f.sha256 + '.part')
            await downloadPinnedSources([urls.get(f.path)!, new URL('/api/client/bundle/object/' + f.sha256, apiBase).href], part, f.sha256, { size: f.size, onReceived: n => {
              received.set(f.sha256, n)
              const done = [...received.values()].reduce((a, b) => a + b, 0)
              onProgress({ phase: 'downloading', percent: Math.min(99, Math.floor(done / Math.max(1, bytes) * 100)), message: `更新变化的资源 ${Math.round(done / 1048576)}/${Math.round(bytes / 1048576)} MB` })
            } })
          })
          for (const f of changed) {
            const target = bundlePath(staged, f.path)
            mkdirSync(dirname(target), { recursive: true })
            copyFileSync(join(objects, f.sha256 + '.part'), target)
          }
          mkdirSync(gameDir, { recursive: true })
          removed = installBundleFiles(staged, gameDir, m.sha256.toLowerCase(), true)
        } catch (error) {
          if (!(error instanceof Error) || !/下载 HTTP (404|501)\b/.test(error.message)) throw error
          unavailable = true
        } finally {
          if (!resolve(staged).startsWith(resolve(cache) + sep)) throw new Error('资源暂存目录越界')
          rmSync(staged, { recursive: true, force: true })
        }
        if (!unavailable) {
          onProgress({ phase: 'done', percent: 100, message: `资源更新完成，仅补齐 ${changed.length} 个文件` })
          return { ok: true, changed: true, bytes, removed }
        }
        onProgress({ phase: 'checking', percent: 0, message: '增量资源暂不可用，改用完整资源包…' })
      }
    }
    const zip = join(cache, 'client-bundle.zip')
    const part = join(cache, `client-bundle.${m.sha256.toLowerCase()}.zip.part`)
    // Older versions did not bind this cache to a release; never resume it.
    rmSync(`${zip}.part`, { force: true })
    const cached = existsSync(zip) && statSync(zip).size === m.size && sha256(zip) === m.sha256.toLowerCase()
    if (!cached) {
      await downloadPinnedSources([source.href, new URL('/api/client/bundle/file', apiBase).href], part, m.sha256, { size: totalBytes, onReceived: received => {
        onProgress({ phase: 'downloading', percent: Math.min(99, Math.floor(received / totalBytes * 100)), message: `下载客户端资源 ${Math.round(received / 1048576)}/${Math.round(totalBytes / 1048576)} MB` })
      }, onRetry: (_source, attempt) => onProgress({ phase: 'downloading', percent: Math.min(99, Math.floor((existsSync(part) ? statSync(part).size : 0) / totalBytes * 100)), message: `正在连接下载线路 ${attempt}，已有进度自动续传` }) })
      rmSync(zip, { force: true }); renameSync(part, zip)
    }
    cleanBundlePartCache(cache)
    mkdirSync(gameDir, { recursive: true })
    onProgress({ phase: 'extracting', percent: 99, message: '校验新资源并清理过期官方资源…' })
    const staged = mkdtempSync(join(cache, 'client-bundle-install-'))
    let removed = 0
    try {
      const command = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${staged.replace(/'/g, "''")}' -Force`
      const unpackStatus = process.platform === 'win32'
        ? await runPowerShell(['-NoProfile', '-NonInteractive', '-Command', command])
        : await new Promise<number>((resolve, reject) => {
          const child = spawn('unzip', ['-q', '-o', zip, '-d', staged], { stdio: 'ignore' })
          child.once('error', reject)
          child.once('close', code => resolve(code ?? -1))
        })
      if (unpackStatus !== 0) throw new Error(`客户端资源解压失败（${unpackStatus}）`)
      removed = installBundleFiles(staged, gameDir, m.sha256.toLowerCase())
    } finally {
      if (!resolve(staged).startsWith(resolve(cache) + sep)) throw new Error('资源暂存目录越界')
      rmSync(staged, { recursive: true, force: true })
    }
    onProgress({ phase: 'done', percent: 100, message: `客户端资源已校验；已删除 ${removed} 个过期官方资源文件` })
    return { ok: true, changed: true, bytes: m.size, removed }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    onProgress({ phase: 'error', percent: 0, message: error })
    return { ok: false, changed: false, error }
  }
}
