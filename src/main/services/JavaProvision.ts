import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { managedJavaDir } from './JavaDetect'
import { downloadPinnedSources } from './PinnedDownload'

export interface JavaMirror {
  name: string
  url: string
  sha256Url: string
  size: number
  sha256: string
}

// Identical Windows x64 archive, verified against the publisher's checksum.
const official = 'https://download.java.net/java/GA/jdk17.0.2/dfd4a8d0985749f896bed50d7138ee7f/8/GPL/openjdk-17.0.2_windows-x64_bin.zip'
const archive = { size: 186216309, sha256: 'b2208206bda47f2e0c971a39e057a5ec32c40b503d71e486790cb728d926b615' }
export const MIRRORS: JavaMirror[] = [
  { name: '华为云 OpenJDK 17.0.2', url: 'https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip', sha256Url: 'https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip.sha256', ...archive },
  { name: 'OpenJDK 官方备用源', url: official, sha256Url: official + '.sha256', ...archive }
]

export interface ProvisionProgress {
  phase: 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
  percent: number
  message: string
}
export interface ProvisionResult {
  ok: boolean
  javaPath?: string
  mirror?: string
  error?: string
}

export async function fetchExpectedSha256(mirror: JavaMirror): Promise<string> {
  const res = await fetch(mirror.sha256Url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`校验文件不可用（HTTP ${res.status}）`)
  const match = /^\s*([0-9a-fA-F]{64})(?:\s|$)/.exec(await res.text())
  if (!match) throw new Error('校验文件里没有 sha256')
  const expected = match[1].toLowerCase()
  if (expected !== mirror.sha256) throw new Error('镜像校验文件与官方固定校验值不一致')
  return expected
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function extractZip(zipPath: string, intoDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(intoDir, { recursive: true })
    const child = spawn('tar.exe', ['-xf', zipPath, '-C', intoDir], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('解压超时（10 分钟）')) }, 600_000)
    child.on('error', error => { clearTimeout(timer); reject(new Error(`解压失败：${error.message}`)) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`解压失败（tar 退出码 ${code}）`)) })
  })
}

export function findJavaExe(root: string): string | null {
  const direct = join(root, 'bin', 'java.exe')
  if (existsSync(direct)) return direct
  try {
    for (const entry of readdirSync(root)) {
      const nested = join(root, entry, 'bin', 'java.exe')
      if (existsSync(nested)) return nested
    }
  } catch { /* Not yet installed. */ }
  return null
}

function verifyRuntime(exe: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(exe, ['-version'], { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      const output = String(stderr) + String(stdout)
      if (error || !/version "17(?:\.|\")/.test(output) || !/64-Bit/i.test(output)) reject(new Error('下载的 Java 17（64 位）无法正常运行'))
      else resolve()
    })
  })
}

async function installJava(onProgress: (p: ProvisionProgress) => void): Promise<ProvisionResult> {
  if (process.platform !== 'win32') {
    const { listJavas } = await import('./JavaDetect')
    const installed = (await listJavas()).find(candidate => candidate.major === 17 && candidate.usable)
    return installed ? { ok: true, javaPath: installed.path } : { ok: false, error: '请先通过系统软件管理器安装 OpenJDK 17 JDK，再重新修复' }
  }
  const managed = resolve(managedJavaDir())
  mkdirSync(managed, { recursive: true })
  const target = join(managed, 'jdk17')
  const installed = findJavaExe(target)
  if (installed) {
    try { await verifyRuntime(installed); onProgress({ phase: 'done', percent: 100, message: '已有 Java 17 可用，无需下载' }); return { ok: true, javaPath: installed } }
    catch { /* Replace only after a new runtime passes validation. */ }
  }
  const work = mkdtempSync(join(managed, '.install-jdk17-'))
  const backup = join(work, 'previous')
  let preserveBackup = false
  try {
    const mirror = MIRRORS[0]
    try {
        const attempt = mkdtempSync(join(work, 'source-'))
        // The checksum names persistent bytes; failed attempts and restarts resume this file.
        const zipPath = join(managed, `jdk17-${mirror.sha256}.zip.part`)
        const staged = join(attempt, 'runtime')
        onProgress({ phase: 'downloading', percent: 0, message: `正在从${mirror.name}下载 Java…` })
        let lastUpdate = 0
        await downloadPinnedSources(MIRRORS.map(source => source.url), zipPath, mirror.sha256, { size: mirror.size, onReceived: bytes => {
          if (bytes < mirror.size && Date.now() - lastUpdate < 250) return
          lastUpdate = Date.now()
          onProgress({ phase: 'downloading', percent: Math.min(99, Math.floor(bytes / mirror.size * 100)), message: `下载中 ${(bytes / 1024 / 1024).toFixed(1)} / ${(mirror.size / 1024 / 1024).toFixed(1)} MB` })
        }, onRetry: (source, attempt) => onProgress({ phase: 'downloading', percent: 0, message: `正在连接 Java 下载线路 ${attempt}（${new URL(source).hostname}），已下载部分自动续传` }) })
        onProgress({ phase: 'verifying', percent: 99, message: '文件校验通过，正在检查运行环境…' })
        onProgress({ phase: 'extracting', percent: 99, message: '正在解压…' })
        await extractZip(zipPath, staged)
        const javaExe = findJavaExe(staged)
        if (!javaExe) throw new Error('解压后找不到 bin/java.exe')
        await verifyRuntime(javaExe)
        // Replace only after hash, extraction and actual Java execution pass.
        if (existsSync(target)) renameSync(target, backup)
        try { renameSync(staged, target) }
        catch (error) {
          if (existsSync(backup)) {
            try { renameSync(backup, target) }
            catch { preserveBackup = true; throw new Error(`安装失败，旧 Java 已保留在 ${backup}`) }
          }
          throw error
        }
        onProgress({ phase: 'done', percent: 100, message: 'Java 已安装并通过运行验证' })
        return { ok: true, javaPath: join(target, relative(staged, javaExe)), mirror: mirror.name }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        onProgress({ phase: 'error', percent: 0, message: `Java 自动安装暂未完成：${reason}；已下载部分会在下次继续` })
        return { ok: false, error: `Java 暂未安装完成：${reason}。已下载部分保留，点击“继续下载”即可续传。` }
    }
  } finally {
    // Verify resolved scope before recursive cleanup; never remove user Java.
    if (!preserveBackup && resolve(work).startsWith(managed + sep) && relative(managed, work).startsWith('.install-jdk17-')) {
      try { rmSync(work, { recursive: true, force: true }) } catch { /* Antivirus may hold a staging file briefly. */ }
    }
  }
}

let pending: Promise<ProvisionResult> | undefined
let latest: ProvisionProgress | undefined
const listeners = new Set<(p: ProvisionProgress) => void>()

/** Repair and settings share one download and cannot overwrite each other. */
export async function provisionJava(onProgress: (p: ProvisionProgress) => void): Promise<ProvisionResult> {
  listeners.add(onProgress)
  const notify = (progress: ProvisionProgress): void => {
    latest = progress
    for (const listener of listeners) { try { listener(progress) } catch { /* Closed UI must not abort installation. */ } }
  }
  if (!pending) {
    latest = undefined
    pending = installJava(notify).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) })).finally(() => { pending = undefined; latest = undefined })
  } else if (latest) { try { onProgress(latest) } catch { /* Same rule as notify. */ } }
  try { return await pending } finally { listeners.delete(onProgress) }
}
