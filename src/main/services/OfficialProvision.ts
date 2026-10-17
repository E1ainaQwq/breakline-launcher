import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { downloadPinnedSources, downloadQueue } from './PinnedDownload'
import { FORGE_RUNTIME_FILES, FORGE_GENERATED_PATHS, provisionForgeRuntime } from './ForgeRuntimeProvision'

function runProcess(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? -1))
  })
}

export interface OfficialProfile {
  java: string
  gameRoot: string
  gameDir: string
  assetsDir: string
  assetIndex: string
  version: string
  classpath: string[]
  /** Electron userData；authlib-injector 固定装在这里，与玩家选择的游戏盘符无关。 */
  launcherDataDir: string
  reuseRoots?: string[]
}

export interface OfficialProgress {
  phase: 'metadata' | 'libraries' | 'assets' | 'natives' | 'done' | 'error'
  done: number
  total: number
  current?: string
  message: string
}

export interface OfficialResult {
  ok: boolean
  downloaded: number
  verified: number
  error?: string
}

type Download = { url: string; sha1: string; size?: number; path?: string }
type VersionMeta = {
  assetIndex: Download & { id: string }
  downloads: { client: Download; client_mappings: Download }
  libraries: Array<{
    downloads?: { artifact?: Download; classifiers?: Record<string, Download> }
    rules?: Array<{ action: 'allow' | 'disallow'; os?: { name?: string } }>
  }>
}

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const AUTHLIB_URL = 'https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.8/authlib-injector-1.2.8.jar'
const AUTHLIB_SHA256 = '9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10'

/** Mirrors supply bytes only; the original pinned checksum remains authoritative. */
export function repairDownloadSources(url: string): string[] {
  const source = new URL(url)
  const mirror = 'https://bmclapi2.bangbang93.com'
  if (url === AUTHLIB_URL) return [`${mirror}/mirrors/authlib-injector/artifact/56/authlib-injector-1.2.8.jar`, url]
  if (source.protocol !== 'https:') return [url]
  if (source.hostname === 'resources.download.minecraft.net') return [`${mirror}/assets${source.pathname}`, url]
  if (source.hostname === 'libraries.minecraft.net' || source.hostname === 'maven.minecraftforge.net') return [`${mirror}/maven${source.pathname}`, url]
  if (source.hostname === 'files.minecraftforge.net' && source.pathname.startsWith('/maven/')) return [`${mirror}${source.pathname}`, url]
  if (['piston-data.mojang.com', 'launcher.mojang.com', 'piston-meta.mojang.com', 'launchermeta.mojang.com'].includes(source.hostname)) return [`${mirror}${source.pathname}`, url]
  return [url]
}

/** Login is repaired independently of Forge/assets; portable installs use current userData. */
export async function ensureLoginComponent(dataDir: string, bundledPath?: string): Promise<boolean> {
  const target = join(dataDir, 'runtime', 'authlib-injector-1.2.8.jar')
  if (existsSync(target) && hash(target, 'sha256') === AUTHLIB_SHA256) return false
  if (bundledPath && existsSync(bundledPath) && hash(bundledPath, 'sha256') === AUTHLIB_SHA256) {
    mkdirSync(dirname(target), { recursive: true })
    const part = `${target}.${process.pid}.part`
    try {
      copyFileSync(bundledPath, part)
      if (hash(part, 'sha256') !== AUTHLIB_SHA256) throw new Error('登录组件复制校验失败')
      renameSync(part, target)
    } finally { rmSync(part, { force: true }) }
    return true
  }
  return download(AUTHLIB_URL, target, AUTHLIB_SHA256, 'sha256')
}
const FETCH_TIMEOUT = 8000
const OFFICIAL_LOCK_SHA256 = '5b501ec704cc6ecd0b76b4977e9b28cab95e2f9513457244999ed3ab92707c56'

function hash(path: string, algorithm: 'sha1' | 'sha256'): string {
  return createHash(algorithm).update(readFileSync(path)).digest('hex')
}

function allowedOnWindows(rules?: Array<{ action: 'allow' | 'disallow'; os?: { name?: string } }>): boolean {
  if (!rules?.length) return true
  let allowed = false
  for (const rule of rules) {
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
    if (rule.os?.name && rule.os.name !== os) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

async function json<T>(url: string): Promise<T> {
  let last: unknown
  for (const source of repairDownloadSources(url)) {
    try {
      const res = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
      if (!res.ok) { await res.body?.cancel(); throw new Error(`清单 HTTP ${res.status}`) }
      return (await res.json()) as T
    } catch (error) { last = error }
  }
  throw last
}

async function text(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
    return res.ok ? (await res.text()).trim().split(/\s+/)[0].toLowerCase() : null
  } catch {
    return null
  }
}

export async function download(url: string, target: string, expected: string, algorithm: 'sha1' | 'sha256', progress?: (message: string) => void, sources?: string[]): Promise<boolean> {
  if (existsSync(target) && hash(target, algorithm) === expected.toLowerCase()) return false
  mkdirSync(dirname(target), { recursive: true })
  const part = `${target}.${expected.toLowerCase()}.part`
  let notified = 0
  await downloadPinnedSources(sources ?? repairDownloadSources(url), part, expected, { algorithm,
    onReceived: bytes => { if (Date.now() - notified > 700) { notified = Date.now(); progress?.(`已接收 ${(bytes / 1048576).toFixed(1)} MB`) } },
    onRetry: (source, attempt) => progress?.(`自动连接线路 ${attempt}（${new URL(source).hostname}），已有进度将续传`)
  })
  renameSync(part, target)
  return true
}

function mavenCandidates(rel: string): string[] {
  const p = rel.replace(/\\/g, '/')
  return [
    `https://bmclapi2.bangbang93.com/maven/${p}`,
    `https://maven.minecraftforge.net/${p}`,
    `https://libraries.minecraft.net/${p}`,
    `https://repo1.maven.org/maven2/${p}`
  ]
}

async function downloadMaven(rel: string, target: string): Promise<boolean> {
  let last = ''
  for (const url of mavenCandidates(rel)) {
    const sha1 = await text(`${url}.sha1`)
    if (!sha1 || !/^[0-9a-f]{40}$/i.test(sha1)) continue
    try {
      return await download(url, target, sha1, 'sha1')
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(`找不到可校验的依赖源：${rel}${last ? `（${last}）` : ''}`)
}

/**
 * 在启动器自己的 game/ 下安装 Minecraft 1.20.1 + Forge 运行依赖。
 * 不读取 HMCL 配置，也不借用 HMCL 的 libraries/assets；所有下载都以 Mojang SHA-1、
 * Maven SHA-1 或固定 SHA-256 验证后才写入正式路径。
 */
export async function provisionOfficial(
  profile: OfficialProfile,
  onProgress: (p: OfficialProgress) => void = () => {},
  lockFile?: string
): Promise<OfficialResult> {
  let downloaded = 0
  let verified = 0
  let yields = 0
  let stage: OfficialProgress = { phase: 'metadata', done: 0, total: 1, message: '检查已有资源…' }
  const report = (p: OfficialProgress): void => { stage = p; onProgress(p) }
  const get = async (url: string, target: string, expected: string, algorithm: 'sha1' | 'sha256', sources?: string[]): Promise<boolean> => {
    if (++yields % 25 === 0) await new Promise<void>(accept => setImmediate(accept))
    if (!existsSync(target) || hash(target, algorithm) !== expected.toLowerCase()) {
      const relativeFile = relative(profile.gameRoot, target)
      const candidates: string[] = []
      if (!relativeFile.startsWith('..') && !relativeFile.includes(':')) {
        for (const root of profile.reuseRoots ?? []) {
          candidates.push(join(root, relativeFile))
          if (target === join(profile.gameDir, `${profile.version}.jar`)) {
            try { for (const version of readdirSync(join(root, 'versions')).slice(0, 40)) candidates.push(join(root, 'versions', version, `${version}.jar`)) } catch { /* No installed versions. */ }
          }
        }
      }
      for (const source of [...new Set(candidates)]) {
        if (resolve(source) === resolve(target)) continue
        try {
          if (!existsSync(source) || hash(source, algorithm) !== expected.toLowerCase()) continue
          mkdirSync(dirname(target), { recursive: true })
          const part = `${target}.${process.pid}.reuse`
          try { copyFileSync(source, part); if (hash(part, algorithm) !== expected.toLowerCase()) continue; renameSync(part, target) }
          finally { rmSync(part, { force: true }) }
          onProgress({ ...stage, current: basename(target), message: `已复用本机文件：${basename(target)}` })
          return false
        } catch { /* A locked source cannot prevent another source or a verified download. */ }
      }
    }
    return download(url, target, expected, algorithm, message => onProgress({ ...stage, current: `${basename(target)} · ${message}`, message }), sources)
  }
  try {
    report({ phase: 'metadata', done: 0, total: 1, message: '检查运行文件，自动选择下载源…' })
    let locked: { version: string; meta: VersionMeta; libraries: Record<string, string> } | undefined
    if (lockFile && existsSync(lockFile)) {
      if (hash(lockFile, 'sha256') !== OFFICIAL_LOCK_SHA256) throw new Error('官方运行环境清单校验失败，请更新启动器')
      locked = JSON.parse(readFileSync(lockFile, 'utf8'))
      if (locked?.version !== '1.20.1') throw new Error('官方运行环境版本不匹配')
    }
    let meta = locked?.meta
    if (!meta) {
      const versions = await json<{ versions: Array<{ id: string; url: string }> }>(VERSION_MANIFEST)
      const item = versions.versions.find((v) => v.id === '1.20.1')
      if (!item) throw new Error('Mojang 版本清单中没有 1.20.1')
      meta = await json<VersionMeta>(item.url)
    }

    const versionJar = join(profile.gameDir, `${profile.version}.jar`)
    if (await get(meta.downloads.client.url, versionJar, meta.downloads.client.sha1, 'sha1')) downloaded++
    verified++

    const indexTarget = join(profile.assetsDir, 'indexes', `${profile.assetIndex}.json`)
    if (await get(meta.assetIndex.url, indexTarget, meta.assetIndex.sha1, 'sha1')) downloaded++
    verified++

    const vanilla = new Map<string, Download>()
    for (const lib of meta.libraries) {
      if (!allowedOnWindows(lib.rules)) continue
      const artifact = lib.downloads?.artifact
      if (artifact?.path) vanilla.set(artifact.path.replace(/\\/g, '/').toLowerCase(), artifact)
      const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
      const native = lib.downloads?.classifiers?.[`natives-${os}`]
        ?? lib.downloads?.classifiers?.[`natives-${os}-\${arch}`]
      if (native?.path) vanilla.set(native.path.replace(/\\/g, '/').toLowerCase(), native)
    }

    // These files are official processor outputs, not public Maven downloads.
    const classFiles = profile.classpath.filter(p => resolve(p) !== resolve(versionJar) &&
      !FORGE_GENERATED_PATHS.includes(relative(join(profile.gameRoot, 'libraries'), p).replace(/\\/g, '/')))
    let done = 0
    report({ phase: 'libraries', done, total: classFiles.length, message: '安装 Forge 与 Minecraft 依赖…' })
    await downloadQueue([...new Set(classFiles)], 6, async target => {
      const rel = relative(join(profile.gameRoot, 'libraries'), target)
      if (rel.startsWith('..')) throw new Error(`依赖路径越界：${target}`)
      report({ phase: 'libraries', done, total: classFiles.length, current: rel, message: `依赖 ${done}/${classFiles.length}` })
      const known = vanilla.get(rel.replace(/\\/g, '/').toLowerCase())
      const lockedHash = locked?.libraries[rel.replace(/\\/g, '/').toLowerCase()]
      let changed: boolean
      if (known) changed = await get(known.url, target, known.sha1, 'sha1')
      else if (lockedHash && /^[a-f0-9]{64}$/.test(lockedHash)) {
        if (existsSync(target) && hash(target, 'sha256') === lockedHash) changed = false
        else {
          changed = await get(mavenCandidates(rel)[0], target, lockedHash, 'sha256', mavenCandidates(rel))
        }
      } else changed = await downloadMaven(rel, target)
      if (changed) downloaded++
      verified++
      done++
      report({ phase: 'libraries', done, total: classFiles.length, current: rel, message: `依赖 ${done}/${classFiles.length}` })
    })

    await provisionForgeRuntime(profile, meta, get, message => {
      report({ phase: 'libraries', done: 0, total: 1, message })
    })
    verified += FORGE_RUNTIME_FILES

    const assetIndex = JSON.parse(readFileSync(indexTarget, 'utf8')) as { objects: Record<string, { hash: string; size: number }> }
    const objects = [...new Map(Object.values(assetIndex.objects).map(obj => [obj.hash, obj] as const)).entries()]
    done = 0
    report({ phase: 'assets', done, total: objects.length, message: '安装官方声音与材质资源…' })
    let lastAssetProgress = 0
    await downloadQueue(objects, 6, async ([, obj]) => {
        const target = join(profile.assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash)
        if (Date.now() - lastAssetProgress >= 150) {
          lastAssetProgress = Date.now()
          report({ phase: 'assets', done, total: objects.length, current: obj.hash, message: `官方资源 ${done}/${objects.length}` })
        }
        if (await get(`https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`, target, obj.hash, 'sha1')) downloaded++
        verified++
        done++
        if (done % 25 === 0 || done === objects.length) {
          report({ phase: 'assets', done, total: objects.length, current: obj.hash, message: `官方资源 ${done}/${objects.length}` })
        }
    })

    const injector = join(profile.launcherDataDir, 'runtime', 'authlib-injector-1.2.8.jar')
    report({ phase: 'libraries', done: 0, total: 1, current: basename(injector), message: '安装登录组件…' })
    if (await get(AUTHLIB_URL, injector, AUTHLIB_SHA256, 'sha256')) downloaded++
    verified++

    const nativePlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
    const nativesDir = join(profile.gameDir, `natives-${nativePlatform}-x86_64`)
    mkdirSync(nativesDir, { recursive: true })
    const nativeJars = classFiles.filter((p) => new RegExp(`natives-${nativePlatform}[^\\\\/]*\\.jar$`, 'i').test(p))
    const jarExe = join(dirname(profile.java), process.platform === 'win32' ? 'jar.exe' : 'jar')
    report({ phase: 'natives', done: 0, total: nativeJars.length, message: '解压 Windows 原生库…' })
    for (let i = 0; i < nativeJars.length; i++) {
      report({ phase: 'natives', done: i, total: nativeJars.length, current: basename(nativeJars[i]), message: `原生库 ${i}/${nativeJars.length}` })
      const status = existsSync(jarExe) ? await runProcess(jarExe, ['xf', nativeJars[i]], nativesDir)
        : process.platform === 'win32' ? await runProcess('tar.exe', ['-xf', nativeJars[i]], nativesDir)
        : await runProcess('unzip', ['-o', nativeJars[i], '-d', nativesDir], nativesDir)
      if (status !== 0) throw new Error(`原生库解压失败：${basename(nativeJars[i])}`)
      report({ phase: 'natives', done: i + 1, total: nativeJars.length, current: basename(nativeJars[i]), message: `原生库 ${i + 1}/${nativeJars.length}` })
    }

    report({ phase: 'done', done: verified, total: verified, message: `官方运行环境已就绪（校验 ${verified} 项）` })
    return { ok: true, downloaded, verified }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    report({ phase: 'error', done: verified, total: verified, message: error })
    return { ok: false, downloaded, verified, error }
  }
}
