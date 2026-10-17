import { verify } from 'node:crypto'

export const MANIFEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFl7wosZ7OC9TdLLZ4cM2duodMJ+k7gukGdqRvy9Do+c=
-----END PUBLIC KEY-----`
export const MANIFEST_KEY_ID = 'origin-ed25519-20261007'

// Sent only by clients that accept the signed, pinned resource download origin.
export const RESOURCE_DOWNLOAD_HEADERS = { 'X-Delta-Launcher-Version': '0.3.53' }

/** Always revalidate resource definitions; a failed request must not poison later launches. */
export async function fetchResourceManifest(apiBase: string, route: string): Promise<Record<string, unknown>> {
  let failure: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = new URL(route, apiBase)
      url.searchParams.set('_launcher_check', `${Date.now()}-${attempt}`)
      const response = await fetch(url, { headers: { ...RESOURCE_DOWNLOAD_HEADERS, 'Cache-Control': 'no-cache' }, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`资源清单 HTTP ${response.status}`) }
      const manifest = await response.json() as Record<string, unknown>
      verifyAuthenticatedManifest(manifest, route)
      return manifest
    } catch (error) { failure = error }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)))
  }
  throw new Error(`资源清单暂未获取成功：${failure instanceof Error ? failure.message : String(failure)}。无需重启，稍后再点一次即可重试`)
}

/** Call after signature verification; external URLs must use our exact file routes. */
export function resourceDownloadUrl(raw: string, apiBase: string, path: string): URL {
  const source = new URL(raw, apiBase)
  const api = new URL(apiBase)
  const direct = source.origin === 'https://dl.breakline-ops.lol' && source.pathname === path && !source.search && !source.hash
  if (source.username || source.password || !['http:', 'https:'].includes(source.protocol) || (source.origin !== api.origin && !direct)) {
    throw new Error('资源下载地址不是可信的官方来源')
  }
  return source
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Authenticate both file hashes and URLs. Private key never leaves the API host. */
export function verifyAuthenticatedManifest(body: unknown, path: string, now = Date.now(), publicKey = MANIFEST_PUBLIC_KEY): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('更新清单格式无效')
  const { authentication, ...manifest } = body as Record<string, unknown>
  const auth = authentication as { algorithm?: string; keyId?: string; envelope?: string; signature?: string } | undefined
  if (auth?.algorithm !== 'Ed25519' || auth.keyId !== MANIFEST_KEY_ID || typeof auth.envelope !== 'string' ||
      typeof auth.signature !== 'string' || auth.envelope.length > 2_000_000 || auth.signature.length !== 88) {
    throw new Error('更新清单缺少有效的官方签名')
  }
  const envelope = Buffer.from(auth.envelope, 'base64')
  const signature = Buffer.from(auth.signature, 'base64')
  if (signature.length !== 64 || !verify(null, envelope, publicKey, signature)) throw new Error('更新清单签名校验失败，请重试')
  const payload = JSON.parse(envelope.toString('utf8')) as {
    context?: string; path?: string; issuedAt?: number; expiresAt?: number; manifest?: unknown
  }
  const seconds = Math.floor(now / 1000)
  if (payload.context !== 'breakline-manifest-v1' || payload.path !== path ||
      !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt! > seconds + 120 || payload.expiresAt! < seconds - 120 ||
      payload.expiresAt! - payload.issuedAt! !== 600 || canonical(payload.manifest) !== canonical(manifest)) {
    throw new Error('更新清单已过期或内容不一致，请重新检查更新')
  }
}
