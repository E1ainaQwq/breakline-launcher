import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync, rmSync } from 'node:fs'
import { saveDownload } from './DownloadStream'

const unavailableUntil = new Map<string, number>()
export async function pinnedHash(file: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  const digest = createHash(algorithm)
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

/** Every source supplies the same pinned bytes; partial files survive retries and restarts. */
export async function downloadPinnedSources(sources: string[], part: string, expected: string,
  options: { algorithm?: 'sha1' | 'sha256'; size?: number; connectTimeoutMs?: number; idleTimeoutMs?: number;
    onReceived?: (bytes: number) => void; onRetry?: (source: string, attempt: number) => void } = {}): Promise<void> {
  const algorithm = options.algorithm ?? 'sha256'
  if (!new RegExp(`^[a-f0-9]{${algorithm === 'sha1' ? 40 : 64}}$`, 'i').test(expected)) throw new Error('下载校验值无效')
  const urls = [...new Set(sources)].map(source => new URL(source))
  if (!urls.length || urls.some(url => !['http:', 'https:'].includes(url.protocol) || url.username || url.password)) throw new Error('下载源无效')
  let last: unknown
  let attempt = 0
  for (let round = 0; round < 2; round++) {
    const ordered = [...urls].sort((a, b) => Number((unavailableUntil.get(a.origin) ?? 0) > Date.now()) - Number((unavailableUntil.get(b.origin) ?? 0) > Date.now()))
    for (const url of ordered) {
      let offset = existsSync(part) ? statSync(part).size : 0
      if (offset && (options.size === undefined || offset === options.size) && await pinnedHash(part, algorithm) === expected.toLowerCase()) {
        options.onReceived?.(offset); return
      }
      if (options.size !== undefined && offset >= options.size) { rmSync(part, { force: true }); offset = 0 }
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      const arm = (ms: number): void => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('下载连接无响应')), ms) }
      arm(options.connectTimeoutMs ?? 8000)
      let response: Response | undefined
      let slowTimer: ReturnType<typeof setInterval> | undefined
      try {
        options.onRetry?.(url.href, ++attempt)
        response = await fetch(url, { headers: { 'User-Agent': 'BreaklineLauncher', ...(offset ? { Range: `bytes=${offset}-` } : {}) }, signal: controller.signal })
        arm(options.idleTimeoutMs ?? 15_000)
        if (url.protocol === 'https:' && new URL(response.url || url.href).protocol !== 'https:') throw new Error('下载源重定向到不安全地址')
        if (response.status === 416) { rmSync(part, { force: true }); throw new Error('下载范围失效，重新下载') }
        if (![200, 206].includes(response.status) || !response.body) throw new Error(`下载 HTTP ${response.status}`)
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
        if (response.status === 206 && (!range || Number(range[1]) !== offset || Number(range[2]) !== Number(range[3]) - 1 ||
          (options.size !== undefined && Number(range[3]) !== options.size))) {
          rmSync(part, { force: true }); throw new Error('下载范围与清单不一致')
        }
        const append = offset > 0 && response.status === 206
        let received = append ? offset : 0
        let windowBytes = received
        slowTimer = setInterval(() => {
          if (received - windowBytes < 32 * 1024) controller.abort(new Error('下载速度持续过低，自动切换线路'))
          windowBytes = received
        }, 30_000)
        options.onReceived?.(received)
        await saveDownload(response, part, append, bytes => {
          arm(options.idleTimeoutMs ?? 15_000)
          received += bytes
          if (options.size !== undefined && received > options.size) throw new Error('下载超过清单大小')
          options.onReceived?.(received)
        })
        clearTimeout(timer!)
        if (options.size !== undefined && statSync(part).size !== options.size) throw new Error('下载连接提前结束')
        if (await pinnedHash(part, algorithm) !== expected.toLowerCase()) {
          rmSync(part, { force: true }); throw new Error('下载文件校验失败')
        }
        unavailableUntil.delete(url.origin)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOSPC') throw new Error('安装磁盘空间不足，请清理空间或在设置中更换安装位置；已下载进度保留')
        if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new Error('游戏文件被占用或无法写入，请先关闭游戏后再点一次；已下载进度保留')
        last = error
        if (!response || controller.signal.aborted || response.status >= 500) unavailableUntil.set(url.origin, Date.now() + 60_000)
        if (options.size !== undefined && existsSync(part) && statSync(part).size > options.size) rmSync(part, { force: true })
        try { await response?.body?.cancel() } catch { /* pipeline already closed its reader */ }
      } finally { clearTimeout(timer!); clearInterval(slowTimer) }
    }
  }
  throw new Error(`所有下载源均未完成，进度已保留：${last instanceof Error ? last.message : String(last)}`)
}

/** Wait for active writes to finish before returning an error. */
export async function downloadQueue<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  let failed = false
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (!failed && queue.length) {
      const item = queue.shift()!
      try { await action(item) } catch (error) { failed = true; throw error }
    }
  })
  const results = await Promise.allSettled(workers)
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
}
