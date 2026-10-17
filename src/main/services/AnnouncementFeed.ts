import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { RESOURCE_DOWNLOAD_HEADERS } from './ManifestAuth'
import { fetchPackSnapshot } from './PackManifestFetch'
import type { Announcement, AnnouncementResult } from '../../shared/Announcements'

/** Announcements travel with the existing signed pack manifest, so old launchers keep working. */
export class AnnouncementFeed {
  private pending?: Promise<AnnouncementResult>
  private checkedAt = 0
  private result: AnnouncementResult = { items: [], cached: false }
  constructor(private readonly cacheFile: string, private readonly apiBase: () => string) {}
  get(): Promise<AnnouncementResult> {
    if (this.pending) return this.pending
    if (Date.now() - this.checkedAt < 60_000) return Promise.resolve(this.result)
    this.pending = this.load().finally(() => { this.checkedAt = Date.now(); this.pending = undefined })
    return this.pending
  }
  private async load(): Promise<AnnouncementResult> {
    try {
      const snapshot = await fetchPackSnapshot(this.apiBase(), '/api/pack/manifest', RESOURCE_DOWNLOAD_HEADERS['X-Delta-Launcher-Version'])
      const body = snapshot.raw
      const items = clean(body.announcements)
      if (!items.length && typeof body.packVersion === 'string') items.push({ id: body.packVersion.slice(0, 128), title: '当前服务器客户端版本', body: `服务器使用 ${body.packVersion.slice(0, 128)}。点击首页主按钮即可检查并完成更新。`, date: typeof body.generatedAt === 'string' ? body.generatedAt.slice(0, 10) : '', tag: '版本', tone: 'accent' })
      this.result = { items, cached: false }
      try { writeFileSync(this.cacheFile, JSON.stringify(items), 'utf8') } catch { /* Announcements do not block launch. */ }
    } catch {
      if (!this.result.items.length && existsSync(this.cacheFile)) {
        try { this.result.items = clean(JSON.parse(readFileSync(this.cacheFile, 'utf8'))) } catch { /* Invalid cache. */ }
      }
      this.result = { items: this.result.items, cached: true, error: '公告暂时无法连接，稍后会自动重试' }
    }
    return this.result
  }
}
function clean(value: unknown): Announcement[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 30).flatMap(raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || typeof raw.body !== 'string') return []
    return [{ id: String(raw.id ?? raw.title).slice(0, 128), title: raw.title.slice(0, 120), body: raw.body.slice(0, 6000), date: String(raw.date ?? '').slice(0, 32), version: typeof raw.version === 'string' ? raw.version.slice(0, 64) : undefined, tag: String(raw.tag ?? '更新').slice(0, 8), tone: 'accent' }]
  })
}
