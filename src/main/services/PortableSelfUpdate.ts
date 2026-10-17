import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdtempSync, unlinkSync, writeFileSync, readFileSync, accessSync, constants, statSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { SelfUpdateInfo } from './SelfUpdateService'
import { saveDownload } from './DownloadStream'
import { verifyAuthenticatedManifest } from './ManifestAuth'

type PortableManifest = { version: string; url: string; sha512: string; size: number }

/** Resume only manifest-sized bytes; a completed stream is not a verified update. */
export async function downloadPortableExecutable(manifest: PortableManifest, target: string, onProgress: (p: { percent: number; message: string }) => void = () => {}, options: { retryDelayMs?: number; onRetry?: (attempt: number, bytes: number, error: unknown) => void } = {}): Promise<void> {
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0) throw new Error('更新清单缺少有效文件大小')
  // Discover a locked/unwritable file before waiting for the entire download.
  if (existsSync(target) && !statSync(target).isFile()) throw new Error('更新临时文件的位置被目录占用')
  closeSync(openSync(target, 'a'))
  let lastError: unknown
  const deadline = Date.now() + 15 * 60_000
  for (let attempt = 0; attempt < 3; attempt++) {
    let offset = statSync(target).size
    if (offset === manifest.size && await sha512Base64(target) === manifest.sha512) return
    if (offset >= manifest.size) { safeUnlink(target); closeSync(openSync(target, 'w')); offset = 0 }
    const controller = new AbortController()
    let idle: ReturnType<typeof setTimeout> | undefined
    const resetIdle = (): void => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error('下载连接超过 45 秒没有数据')), 45_000) }
    const totalTimeout = setTimeout(() => controller.abort(new Error('更新下载超过 15 分钟，请重试')), Math.max(1, deadline - Date.now()))
    resetIdle()
    try {
      onProgress({ percent: Math.min(99, Math.floor(offset / manifest.size * 100)), message: attempt ? `连接中断，正在续传（${attempt + 1}/3）` : '正在下载启动器' })
      const response = await fetch(manifest.url, {
        headers: { 'User-Agent': 'BreaklineLauncher', ...(offset ? { Range: `bytes=${offset}-` } : {}) },
        signal: controller.signal
      })
      if ((response.status === 416 && offset > 0) || (response.status === 206 && response.headers.get('content-range') !== `bytes ${offset}-${manifest.size - 1}/${manifest.size}`)) {
        await response.body?.cancel(); safeUnlink(target); closeSync(openSync(target, 'w'))
        throw new Error('更新下载范围不匹配，已清除旧缓存')
      }
      if (![200, 206].includes(response.status) || !response.body) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
      const append = offset > 0 && response.status === 206
      if (!append) offset = 0
      if (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== manifest.size - offset) {
        await response.body.cancel(); safeUnlink(target); closeSync(openSync(target, 'w'))
        throw new Error('更新下载大小与清单不一致')
      }
      let received = offset
      await saveDownload(response, target, append, bytes => {
        resetIdle(); received += bytes
        if (received > manifest.size) throw new Error('更新下载超过清单大小')
        onProgress({ percent: Math.min(99, Math.floor(received / manifest.size * 100)), message: `${(received / 1024 / 1024).toFixed(1)} / ${(manifest.size / 1024 / 1024).toFixed(1)} MB` })
      })
      clearTimeout(idle)
      onProgress({ percent: 99, message: '正在校验更新文件' })
      if (statSync(target).size !== manifest.size || await sha512Base64(target) !== manifest.sha512) {
        safeUnlink(target); closeSync(openSync(target, 'w'))
        throw new Error('更新文件大小或 SHA-512 校验失败')
      }
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException)?.code
      if (['EACCES', 'EPERM', 'ENOSPC', 'EISDIR', 'EROFS'].includes(code ?? '')) throw error
      if (attempt === 2 || Date.now() >= deadline) break
      options.onRetry?.(attempt + 2, existsSync(target) ? statSync(target).size : 0, error)
    } finally { clearTimeout(idle); clearTimeout(totalTimeout) }
    await new Promise(resolveDelay => setTimeout(resolveDelay, options.retryDelayMs ?? 1000 * (attempt + 1)))
    if (!existsSync(target)) closeSync(openSync(target, 'w'))
  }
  if (existsSync(target) && statSync(target).size === 0) safeUnlink(target)
  const error = lastError as Error & { cause?: { code?: string; message?: string } }
  throw new Error(`${error?.message ?? String(lastError)}${error?.cause ? `（${error.cause.code ?? error.cause.message ?? '连接异常'}）` : ''}；自动重试未成功，旧版本保留`)
}

/** Portable update: verify SHA-512, wait for exit, atomically replace, then relaunch.
 * Keeps a recoverable previous binary until the new process starts successfully. */
export class PortableSelfUpdate {
  constructor(
    private readonly feedUrl: string,
    private readonly onProgress: (p: { percent: number; message: string }) => void = () => {}
  ) {}

  /** 当前运行的免安装版 exe 的**真实路径**（用户双击的那一个，不是解压出来的临时副本）。 */
  static exePath(): string {
    return process.env.PORTABLE_EXECUTABLE_FILE ?? ''
  }

  static isPortable(): boolean {
    return !!PortableSelfUpdate.exePath()
  }

  async check(): Promise<SelfUpdateInfo> {
    const currentVersion = app.getVersion()
    if (!app.isPackaged) {
      return { currentVersion, packaged: false, available: false, error: '开发模式（未打包）：自更新不适用' }
    }
    if (!this.feedUrl) {
      return {
        currentVersion,
        packaged: true,
        available: false,
        error: '免安装版：未配置更新源（config/launch.json 的 launcherUpdate.feedUrl 为空）'
      }
    }
    const exe = PortableSelfUpdate.exePath()
    const dir = dirname(exe)
    try {
      accessSync(dir, constants.W_OK)
    } catch {
      // 目录不可写 ⇒ 现在就说清楚。等下载完 80MB 再报错，玩家已经白等了。
      return {
        currentVersion,
        packaged: true,
        available: false,
        error: `免安装版：所在目录不可写（${dir}），无法自动替换。请把 exe 放到有写权限的目录，或手动下载新版`
      }
    }
    try {
      const manifest = await this.manifest()
      const available = versionGreater(manifest.version, currentVersion)
      return {
        currentVersion,
        packaged: true,
        available,
        version: manifest.version,
        notes: available ? `免安装版自替换：下载完成后会关闭本程序、删除旧 exe、只保留新版并重新打开` : undefined
      }
    } catch (e) {
      return {
        currentVersion,
        packaged: true,
        available: false,
        error: `免安装版：检查失败 —— ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  /**
   * 下载 → 验哈希 → 起自替换助手 → 退出。
   *
   * **这个函数返回 true 之后进程就要退出了**（助手在等我们退出才会动文件）。
   */
  async downloadAndInstall(): Promise<{ ok: boolean; error?: string }> {
    if (!app.isPackaged) return { ok: false, error: '开发模式下不执行替换' }
    if (!this.feedUrl) return { ok: false, error: '免安装版：未配置更新源' }
    const exe = PortableSelfUpdate.exePath()
    let manifest
    try {
      manifest = await this.manifest()
    } catch (e) {
      return { ok: false, error: `免安装版：拉取更新清单失败 —— ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!versionGreater(manifest.version, app.getVersion())) {
      return { ok: false, error: `免安装版：当前已是最新（${app.getVersion()}）` }
    }

    const staged = `${exe}.new`
    const stagedHash = `${staged}.sha512`
    const record = (message: string): void => {
      try { appendFileSync(`${exe}.update.log`, `${new Date().toISOString()} ${message}\n`, 'utf8') } catch { /* Logging must not block recovery. */ }
    }
    record(`Downloading launcher ${manifest.version}`)
    try {
      const cacheMatches = existsSync(stagedHash) && readFileSync(stagedHash, 'utf8').trim() === manifest.sha512
      if (!cacheMatches && existsSync(staged) && statSync(staged).isFile()) {
        // Older launchers did not bind partial bytes to a release. Reuse only
        // a fully verified download, otherwise discard it before resuming.
        const complete = statSync(staged).size === manifest.size && await sha512Base64(staged) === manifest.sha512
        if (!complete) unlinkSync(staged)
      }
      writeFileSync(stagedHash, manifest.sha512, 'utf8')
      await downloadPortableExecutable(manifest, staged, this.onProgress, {
        onRetry: (attempt, bytes, error) => {
          const details = error as Error & { cause?: { code?: string } }
          record(`Retry ${attempt}/3 from byte ${bytes}: ${details?.message ?? String(error)}${details?.cause?.code ? ` (${details.cause.code})` : ''}`)
        }
      })
    } catch (e) {
      // The downloader already removes corrupt bytes. Keep matching partial
      // downloads across button clicks so a network failure does not start over.
      record(`Download/verification failed: ${e instanceof Error ? e.message : String(e)}`)
      return { ok: false, error: `免安装版：下载失败 —— ${e instanceof Error ? e.message : String(e)}` }
    }
    record('Download and SHA-512 verification complete')
    // 先验哈希再换（见类注释第 1 条）。
    try {
      const actual = await sha512Base64(staged)
      if (actual !== manifest.sha512) {
        safeUnlink(staged)
        return { ok: false, error: '免安装版：下载文件校验失败（哈希不符），已丢弃，未做任何替换' }
      }
    } catch (e) {
      safeUnlink(staged)
      return { ok: false, error: `免安装版：校验失败 —— ${e instanceof Error ? e.message : String(e)}` }
    }

    try {
      this.onProgress({ percent: 99, message: '校验通过，正在准备替换' })
      const helper = writeSwapHelper(exe, staged, manifest.sha512)
      await startSwapHelper(helper)
      safeUnlink(stagedHash)
      this.onProgress({ percent: 100, message: '更新已就绪，正在重启' })
    } catch (e) {
      record(`Replacement helper failed: ${e instanceof Error ? e.message : String(e)}`)
      return { ok: false, error: `免安装版：无法启动替换助手 —— ${e instanceof Error ? e.message : String(e)}` }
    }
    // 助手在等我们这个 PID 消失。给它一点时间进入等待循环，然后**硬退出**。
    //
    // ⚠️ 这里必须是 app.exit(0)，不能用 app.quit()（2026-09-18 真机踩到）：
    // 启动器有"关闭窗口收进托盘"的行为（`closeToTray` 默认 true），quit 会被那条路吞掉
    // ⇒ 进程根本不退 ⇒ 助手等到超时、放弃替换，而玩家看到的是"下载完了但什么都没发生"。
    // 验证替换机制时我用的是 app.exit（所以当时通了），两条路的差别就是这个。
    setTimeout(() => app.exit(0), 800)
    return { ok: true }
  }

  // ------------------------------------------------------------------ 内部

  /** Signed metadata authenticates the release hash as well as its download URL. */
  private async manifest(): Promise<{ version: string; url: string; sha512: string; size: number }> {
    const route = '/api/launcher-update/manifest'
    const url = new URL(route, this.feedUrl).toString()
    // ⚠️ **必须带超时**（2026-09-18 真机踩到）：没有超时的 fetch 在网络卡住时会一直挂着，
    // 界面永远停在「检查中…」—— 既不报错也不结束，玩家只能以为程序死了。
    // 20 秒对"拉一个 300 字节的清单"足够宽裕；超时后会走 catch 把原因显示出来。
    const res = await fetch(url, {
      headers: { 'User-Agent': `DeltaLauncher/${app.getVersion()}` },
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}（${url}）`)
    const body = await res.json() as PortableManifest
    verifyAuthenticatedManifest(body, route)
    if (!/^\d+\.\d+\.\d+$/.test(body.version) || !/^https?:\/\//.test(body.url) ||
        Buffer.from(body.sha512, 'base64').length !== 64 || !Number.isSafeInteger(body.size) || body.size <= 0) {
      throw new Error('启动器更新清单格式无效')
    }
    return body
  }

}

/**
 * 解析 `latest-portable.yml`。
 *
 * 只认我们需要的四样东西，**不做通用 YAML**（少一个依赖、少一类解析歧义）。
 * 但字段缺失一律抛错：宁可报"清单坏了"，也不能因为少一个字段就当作"没有新版"。
 */
export function parsePortableManifest(
  text: string,
  feedUrl: string
): { version: string; url: string; sha512: string; size: number } {
  const version = /^version:\s*['"]?([0-9][^'"\s]*)['"]?\s*$/m.exec(text)?.[1]
  const url = /^\s*-\s*url:\s*(\S+)\s*$/m.exec(text)?.[1]
  const sha512 = /sha512:\s*([A-Za-z0-9+/=]{40,})/.exec(text)?.[1]
  const size = Number(/size:\s*(\d+)/.exec(text)?.[1] ?? 0)
  if (!version) throw new Error('清单里没有 version')
  if (!url) throw new Error('清单里没有文件 url')
  if (!sha512) throw new Error('清单里没有 sha512')
  // 相对路径要拼成绝对地址：清单里写的是文件名，托管目录由 feedUrl 决定。
  const absolute = /^https?:\/\//.test(url) ? url : `${feedUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
  return { version, url: absolute, sha512, size }
}

/** 版本比较：远端**必须比**本地新。相等或更旧都不算"有新版"（否则会给玩家一个降级按钮）。 */
export function versionGreater(remote: string | undefined, local: string): boolean {
  if (!remote) return false
  const ra = remote.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const la = local.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(ra.length, la.length); i++) {
    const r = ra[i] ?? 0
    const l = la[i] ?? 0
    if (r !== l) return r > l
  }
  return false
}

export async function sha512Base64(path: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

/** Write a hidden PowerShell helper. No executable is deleted before replacement.
 * Hash/exit failures preserve the old binary; startup errors restore its backup. */
export function writeSwapHelper(oldExe: string, newExe: string, expectedSha512?: string): string {
  oldExe = resolve(oldExe)
  newExe = resolve(newExe)
  if (oldExe.toLowerCase() === newExe.toLowerCase() || dirname(oldExe).toLowerCase() !== dirname(newExe).toLowerCase()) throw new Error('替换文件必须位于同一目录且路径不同')
  const dir = mkdtempSync(join(tmpdir(), 'delta-swap-'))
  const helper = join(dir, 'swap.ps1')
  const ready = join(dir, 'swap.ready')
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const expectedHash = expectedSha512 ? Buffer.from(expectedSha512, 'base64').toString('hex') : createHash('sha512').update(readFileSync(newExe)).digest('hex')
  const script = String.raw`$ErrorActionPreference = 'Stop'
$old = ${quote(oldExe)}
$staged = ${quote(newExe)}
$expected = ${quote(expectedHash)}
$launcherPid = ${process.pid}
$backup = $old + '.previous-' + [Guid]::NewGuid().ToString('N')
$log = $old + '.update.log'
$swapped = $false
function Write-UpdateLog([string]$message) { Add-Content -LiteralPath $log -Value $message -Encoding UTF8 -ErrorAction SilentlyContinue }
try {
  [IO.File]::WriteAllText(${quote(ready)}, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Old launcher did not exit; no files changed' }
    Start-Sleep -Milliseconds 250
  }
  $hasher = [Security.Cryptography.SHA512]::Create()
  $stream = [IO.File]::OpenRead($staged)
  try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hasher.Dispose() }
  if ($actual -ne $expected) { throw 'Staged launcher hash mismatch; no files changed' }
  if (-not (Test-Path -LiteralPath $old -PathType Leaf)) { throw 'Old launcher is missing; no files changed' }
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while (-not $swapped) {
    try { [IO.File]::Replace($staged, $old, $backup); $swapped = $true }
    catch { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 500 }
  }
  Write-UpdateLog 'Atomic replacement complete; starting new launcher'
  $next = Start-Process -FilePath $old -WorkingDirectory ([IO.Path]::GetDirectoryName($old)) -WindowStyle Normal -PassThru
  if ($next.WaitForExit(1500) -and $next.ExitCode -ne 0) { throw 'New launcher exited with an error' }
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $backup) { Write-UpdateLog 'Previous binary still locked; retained for recovery' }
  else { Write-UpdateLog 'Update complete; previous binary removed' }
} catch {
  Write-UpdateLog ('Update failed: ' + $_.Exception.Message)
  if ($swapped -and (Test-Path -LiteralPath $backup)) {
    try {
      [IO.File]::Replace($backup, $old, $staged)
      Write-UpdateLog 'Previous launcher restored'
      Start-Process -FilePath $old -WorkingDirectory ([IO.Path]::GetDirectoryName($old)) -WindowStyle Normal
    } catch { Write-UpdateLog ('Recovery incomplete: ' + $_.Exception.Message) }
  }
  exit 1
} finally {
  Remove-Item -LiteralPath ${quote(ready)} -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ${quote(helper)} -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ${quote(dir)} -ErrorAction SilentlyContinue
}
`
  writeFileSync(helper, '\ufeff' + script, 'utf8')
  if (!existsSync(helper)) throw new Error('助手写入失败')
  return helper
}

export function startSwapHelper(helper: string): Promise<void> {
  return new Promise((resolveStarted, reject) => {
    // Node's DETACHED_PROCESS can make PowerShell exit without executing. A
    // short bootstrap creates the hidden worker with its own console instead.
    const fileArg = `'"${helper.replace(/'/g, "''")}"'`
    const command = `$ErrorActionPreference='Stop'; Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${fileArg}) -WindowStyle Hidden`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true })
    const ready = join(dirname(helper), 'swap.ready')
    const deadline = Date.now() + 15000
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.unref()
      reject(error)
    }
    child.once('error', fail)
    child.once('exit', code => { if (code !== 0) fail(new Error(`更新助手未就绪即退出（${code ?? '未知'}），旧版保留`)) })
    const checkReady = (): void => {
      if (settled) return
      if (existsSync(ready)) {
        settled = true
        child.unref()
        resolveStarted()
      } else if (Date.now() >= deadline) fail(new Error('更新助手启动超时，旧版保留'))
      else timer = setTimeout(checkReady, 100)
    }
    child.once('spawn', checkReady)
  })
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // 删不掉就算了：它是 `<exe>.new`，不会影响旧版运行。
  }
}
