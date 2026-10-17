import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

type Ticket = { ok: true; token: string; ttlSeconds: number } | { ok: false; error: string }

/** Per-game capability on loopback. No player session or signing key enters the JVM. */
export class LaunchLease {
  private readonly server: Server
  readonly key = randomBytes(32).toString('hex')
  url = ''
  readonly initialToken: string
  private cached: { token: string; expires: number }
  private pending: Promise<void> | null = null
  private closed = false
  private retryAfter = 0
  private requested = false
  private failed = false

  private constructor(initial: Extract<Ticket, { ok: true }>, private readonly renew: () => Promise<Ticket>, private readonly onStatus?: (frame: string) => boolean, private readonly onCapture?: (ticket: string) => void) {
    this.initialToken = initial.token
    this.cached = { token: initial.token, expires: Date.now() + initial.ttlSeconds * 1000 }
    this.server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      const supplied = Buffer.from(req.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${this.key}`)
      const port = new URL(this.url).port
      const statusRequest = req.method === 'POST' && req.url === '/status' && !!this.onStatus
      const captureRequest = req.method === 'POST' && req.url === '/capture' && !!this.onCapture
      if (this.closed || (!statusRequest && !captureRequest && (req.method !== 'GET' || req.url !== '/token')) || req.headers.origin
          || req.headers.host !== `127.0.0.1:${port}`
          || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.writeHead(403).end('forbidden')
        return
      }
      if (statusRequest || captureRequest) {
        req.setTimeout(5000, () => req.destroy())
        try {
          let frame = ''
          for await (const chunk of req) {
            frame += chunk.toString('ascii')
            if (frame.length > (captureRequest ? 300 : 4096)) { res.writeHead(413).end(); req.destroy(); return }
          }
          if (this.closed) { res.writeHead(400).end(); return }
          if (captureRequest) this.onCapture!(frame)
          else if (!this.onStatus!(frame)) { res.writeHead(400).end(); return }
          res.writeHead(204).end()
        } catch { res.writeHead(400).end() }
        return
      }
      try {
        if (this.cached.expires - Date.now() <= 60_000) {
          if (!this.pending && Date.now() >= this.retryAfter) {
            this.retryAfter = Date.now() + 5000
            this.pending = this.refresh().finally(() => { this.pending = null })
          }
          if (this.pending) await this.pending
        }
        if (this.closed || this.cached.expires <= Date.now()) throw new Error('unavailable')
        this.requested = true
        res.end(this.cached.token)
      } catch {
        this.failed = true
        res.writeHead(503).end('verification_unavailable')
      }
    })
    this.server.requestTimeout = 5000
    this.server.headersTimeout = 5000
    this.server.maxConnections = 8
  }

  private async refresh(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        this.renew(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 4000) })
      ])
      if (!result.ok || result.ttlSeconds <= 0) throw new Error('verification_unavailable')
      this.cached = { token: result.token, expires: Date.now() + result.ttlSeconds * 1000 }
      this.failed = false
    } catch (error) {
      this.failed = true
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  static async start(initial: Extract<Ticket, { ok: true }>, renew: () => Promise<Ticket>, onStatus?: (frame: string) => boolean, onCapture?: (ticket: string) => void): Promise<LaunchLease> {
    const lease = new LaunchLease(initial, renew, onStatus, onCapture)
    await new Promise<void>((resolve, reject) => {
      lease.server.once('error', reject)
      lease.server.listen(0, '127.0.0.1', () => {
        const address = lease.server.address()
        if (!address || typeof address === 'string') { reject(new Error('loopback unavailable')); return }
        lease.url = `http://127.0.0.1:${address.port}/token`
        resolve()
      })
    })
    lease.server.unref()
    return lease
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.server.close()
    this.server.closeAllConnections()
  }

  status(): { requested: boolean; failed: boolean } | null {
    return this.closed ? null : { requested: this.requested, failed: this.failed }
  }
}
