import { verifyAuthenticatedManifest } from './ManifestAuth'
import { validateManifest, type PackManifest } from './UpdateService'

type Snapshot = { manifest: PackManifest; raw: Record<string, unknown>; expiresAt: number; fetchedAt: number }
const cached = new Map<string, Snapshot>()
const pending = new Map<string, Promise<Snapshot>>()

/** Checks and launch share one request. A failed refresh never clears an authenticated, unexpired snapshot. */
export function fetchPackSnapshot(apiBase: string, path: string, version: string, force = false): Promise<Snapshot> {
  const key = `${apiBase.replace(/\/$/, '')}${path}\n${version}`
  const running = pending.get(key)
  if (running) return running
  const previous = cached.get(key)
  if (!force && previous && Date.now() - previous.fetchedAt < 30_000 && previous.expiresAt > Date.now() + 10_000) return Promise.resolve(previous)
  const request = (async (): Promise<Snapshot> => {
    let failure = '暂时无法连接服务器'
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = new URL(`${apiBase.replace(/\/$/, '')}${path}`)
        url.searchParams.set('_launcher_check', `${Date.now()}-${attempt}`)
        const response = await fetch(url, { headers: { 'X-Delta-Launcher-Version': version, 'Cache-Control': 'no-cache' }, cache: 'no-store', signal: AbortSignal.timeout(6500) })
        if (!response.ok) { await response.body?.cancel(); throw new Error(`服务器暂时未返回清单（${response.status}）`) }
        const raw = await response.json() as Record<string, unknown>
        try { verifyAuthenticatedManifest(raw, path) }
        catch (error) {
          const serverTime = Date.parse(response.headers.get('date') ?? '')
          if (Number.isFinite(serverTime) && Math.abs(serverTime - Date.now()) > 120_000) throw new Error('电脑日期时间不准确，请在 Windows 设置中开启自动设置时间并点击“立即同步”，然后再点一次主按钮')
          throw error
        }
        const result = validateManifest(raw)
        if (!result.ok || result.manifest.files.length === 0) throw new Error('服务器返回的模组清单不完整，正在重新获取')
        const auth = raw.authentication as { envelope: string }
        const expiresAt = JSON.parse(Buffer.from(auth.envelope, 'base64').toString('utf8')).expiresAt * 1000
        if (expiresAt <= Date.now() + 10_000) throw new Error('清单即将过期，正在获取新清单')
        const snapshot = { manifest: result.manifest, raw, expiresAt, fetchedAt: Date.now() }
        if (cached.size > 8) cached.clear()
        cached.set(key, snapshot)
        return snapshot
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        if (failure.startsWith('电脑日期时间')) break
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)))
      }
    }
    if (previous && previous.expiresAt > Date.now() + 10_000) return previous
    throw new Error(`官方模组清单暂未获取成功：${failure}。无需重启，稍后再点一次会自动重新连接`)
  })().finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}
