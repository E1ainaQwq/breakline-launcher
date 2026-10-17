import { createWriteStream, createReadStream, existsSync, statSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DownloadSpeed } from '../../shared/DownloadActivity'

const transfers = new Set<symbol>()
let recentBytes: { at: number; bytes: number }[] = []
let transferStartedAt = 0
export function watchDownloadSpeed(receive: (speed: DownloadSpeed) => void): () => void {
  const timer = setInterval(() => {
    const now = Date.now()
    recentBytes = recentBytes.filter(sample => sample.at > now - 2000)
    const elapsed = Math.max(500, Math.min(2000, now - transferStartedAt))
    try { receive({ activeTransfers: transfers.size, bytesPerSecond: transfers.size ? Math.round(recentBytes.reduce((sum, sample) => sum + sample.bytes, 0) * 1000 / elapsed) : 0 }) } catch { /* A closed progress window cannot stop downloads. */ }
  }, 500)
  timer.unref()
  return () => clearInterval(timer)
}

/** Attach error handling before opening the file and respect disk backpressure. */
export async function saveDownload(response: Response, target: string, append = false, onBytes: (bytes: number) => void = () => {}): Promise<void> {
  if (!response.body) throw new Error('下载响应没有内容')
  const transfer = Symbol(target)
  if (!transfers.size) { transferStartedAt = Date.now(); recentBytes = [] }
  transfers.add(transfer)
  try { await pipeline(
    Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    new Transform({ transform(chunk: Buffer, _encoding, done) {
      try { recentBytes.push({ at: Date.now(), bytes: chunk.length }); onBytes(chunk.length); done(null, chunk) }
      catch (e) { done(e instanceof Error ? e : new Error(String(e))) }
    } }),
    createWriteStream(target, { flags: append ? 'a' : 'w' })
  )
  } finally { transfers.delete(transfer) }
}

/** A partial download is usable only for the exact manifest bytes. */
export async function downloadVerifiedResource(url: URL, part: string, size: number, expected: string, onReceived: (bytes: number) => void = () => {}, options: { retryDelayMs?: number; idleTimeoutMs?: number; onRetry?: (attempt: number, bytes: number) => void } = {}): Promise<void> {
  const digest = async (): Promise<string> => {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(part)) hash.update(chunk)
    return hash.digest('hex')
  }
  const attempts = 4
  for (let attempt = 0; attempt < attempts; attempt++) {
    let offset = existsSync(part) ? statSync(part).size : 0
    if (offset === size && await digest() === expected.toLowerCase()) return
    if (offset >= size) { rmSync(part, { force: true }); offset = 0 }
    let retryable = false
    const controller = new AbortController()
    const idleTimeout = options.idleTimeoutMs ?? 15_000
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const receivedData = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(new DOMException('资源下载连接超时', 'TimeoutError')), idleTimeout)
    }
    receivedData()
    try {
      const res = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : undefined, signal: controller.signal })
      receivedData()
      if (new URL(res.url).origin !== url.origin) { await res.body?.cancel(); throw new Error('资源下载发生跨站重定向') }
      const validRange = res.headers.get('content-range') === `bytes ${offset}-${size - 1}/${size}`
      if ((res.status === 416 && offset > 0) || (res.status === 206 && !validRange)) {
        await res.body?.cancel()
        rmSync(part, { force: true }); offset = 0
        retryable = true
        throw new Error('资源下载返回的范围与清单不一致')
      }
      if (![200, 206].includes(res.status) || !res.body) {
        await res.body?.cancel()
        retryable = [408, 425, 429, 500, 502, 503, 504].includes(res.status)
        throw new Error(`资源下载 HTTP ${res.status}`)
      }
      const append = offset > 0 && res.status === 206
      if (!append) offset = 0
      let received = offset
      try {
        await saveDownload(res, part, append, bytes => {
          receivedData()
          received += bytes
          if (received > size) throw new Error('资源下载超过清单大小')
          onReceived(received)
        })
      } catch (e) { if (received > size) rmSync(part, { force: true }); throw e }
      clearTimeout(idleTimer)
      if (statSync(part).size < size) {
        retryable = true
        throw new Error('资源下载连接提前结束')
      }
      if (statSync(part).size !== size || await digest() !== expected.toLowerCase()) {
        rmSync(part, { force: true })
        throw new Error('资源下载大小或 SHA-256 校验失败')
      }
      return
    } catch (error) {
      clearTimeout(idleTimer)
      const details = error as { name?: string; code?: string; cause?: { code?: string } }
      const code = details?.code ?? details?.cause?.code ?? ''
      const timedOut = controller.signal.aborted && controller.signal.reason?.name === 'TimeoutError'
      retryable ||= ['TimeoutError', 'AbortError'].includes(details?.name ?? '') ||
        /^(UND_ERR_|ECONNRESET$|ECONNREFUSED$|ETIMEDOUT$|EAI_AGAIN$|ENETUNREACH$|EHOSTUNREACH$|EPIPE$|ERR_STREAM_PREMATURE_CLOSE$)/.test(code)
      if (!retryable || attempt === attempts - 1) {
        if (timedOut) throw new Error('下载连接超时，已保留下载进度；请稍后重试，将继续下载')
        throw error
      }
      const retained = existsSync(part) ? statSync(part).size : 0
      options.onRetry?.(attempt + 2, retained)
      await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? Math.min(8000, 1000 * 2 ** attempt)))
    } finally { clearTimeout(idleTimer) }
  }
}
