import { createHash } from 'node:crypto'
import { fetchResourceManifest, resourceDownloadUrl } from './ManifestAuth'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadPinnedSources } from './PinnedDownload'

export const RED_RESOURCE_PACK_NAME = 'delta-red-items-3d.zip'
const PACK_ID = `file/${RED_RESOURCE_PACK_NAME}`
const MAX_BYTES = 300 * 1024 * 1024

export interface RedPackResult { ok: boolean; changed: boolean; bytes?: number; error?: string }
export type RedPackProgress = (message: string) => void
type Manifest = { ok?: boolean; name?: string; size?: number; sha256?: string; url?: string; error?: string }

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function cleanRedPartCache(packDir: string): void {
  for (const name of readdirSync(packDir)) {
    if (/^\.delta-red-items-3d\.zip\.[a-f0-9]{64}\.part$/.test(name)) rmSync(join(packDir, name), { force: true })
  }
}

/** Minecraft reads resourcePacks from its instance-local options.txt. Keep every existing selection. */
export function enableRedResourcePack(gameDir: string): boolean {
  const options = join(gameDir, 'options.txt')
  const original = existsSync(options) ? readFileSync(options, 'utf8') : ''
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original ? original.split(/\r?\n/) : []
  const matches = lines.flatMap((line, i) => line.startsWith('resourcePacks:') ? [i] : [])
  if (matches.length > 1) throw new Error('options.txt 有多个 resourcePacks 字段，请手动检查')
  if (matches.length === 1) {
    const index = matches[0]
    let packs: unknown
    try { packs = JSON.parse(lines[index].slice('resourcePacks:'.length)) }
    catch { throw new Error('options.txt 的 resourcePacks 格式无效，请手动检查') }
    if (!Array.isArray(packs) || packs.some((pack) => typeof pack !== 'string')) {
      throw new Error('options.txt 的 resourcePacks 不是字符串列表，请手动检查')
    }
    if (packs.includes(PACK_ID)) return false
    lines[index] = `resourcePacks:${JSON.stringify([...packs, PACK_ID])}`
  } else {
    if (lines.at(-1) === '') lines.pop()
    lines.push(`resourcePacks:${JSON.stringify([PACK_ID])}`)
  }
  const updated = lines.join(newline) + (original.endsWith('\n') || !original ? newline : '')
  const temp = `${options}.delta-red3d-${process.pid}.tmp`
  writeFileSync(temp, updated, 'utf8')
  try {
    renameSync(temp, options)
    return true
  } finally { rmSync(temp, { force: true }) }
}

/** Download only the fixed official pack, verify exact bytes and SHA, then enable it for this instance. */
export async function provisionRedResourcePack(
  apiBase: string,
  gameDir: string,
  onProgress: RedPackProgress = () => {}
): Promise<RedPackResult> {
  try {
    const base = new URL(apiBase)
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('资源包 API 地址无效')
    const m = await fetchResourceManifest(base.href, '/api/client/resourcepack/red3d/manifest') as Manifest
    if (!m.ok) throw new Error(m.error ?? '资源包清单无效')
    if (m.name !== RED_RESOURCE_PACK_NAME || !Number.isSafeInteger(m.size) || m.size! <= 0 || m.size! > MAX_BYTES ||
        !/^[a-f0-9]{64}$/i.test(m.sha256 ?? '') || !m.url) {
      throw new Error('资源包清单格式无效')
    }
    const expected = m.sha256!.toLowerCase()
    const source = resourceDownloadUrl(m.url, apiBase, '/api/client/resourcepack/red3d/file')
    const packDir = join(gameDir, 'resourcepacks')
    const target = join(packDir, RED_RESOURCE_PACK_NAME)
    if (existsSync(target) && statSync(target).size === m.size && await sha256(target) === expected) {
      const enabled = enableRedResourcePack(gameDir)
      cleanRedPartCache(packDir)
      return { ok: true, changed: enabled, bytes: m.size }
    }

    mkdirSync(packDir, { recursive: true })
    const part = join(packDir, `.${RED_RESOURCE_PACK_NAME}.${expected}.part`)
    let reportedMb = -1
    await downloadPinnedSources([source.href, new URL('/api/client/resourcepack/red3d/file', apiBase).href], part, expected, { size: m.size!, onReceived: received => {
      const mb = Math.floor(received / 1048576)
      if (mb !== reportedMb) {
        reportedMb = mb
        onProgress(`下载红色物品 3D 资源 ${mb}/${Math.ceil(m.size! / 1048576)} MB`)
      }
    }, onRetry: (_source, attempt) => onProgress(`正在连接下载线路 ${attempt}，已有进度自动续传`) })
    // The old pack stays outside Minecraft's pack directory while replacement is in progress.
    const backup = join(packDir, `.${RED_RESOURCE_PACK_NAME}.${process.pid}.bak`)
    if (existsSync(target)) renameSync(target, backup)
    try {
      renameSync(part, target)
      enableRedResourcePack(gameDir)
    }
    catch (e) {
      rmSync(target, { force: true })
      if (existsSync(backup)) renameSync(backup, target)
      throw e
    }
    rmSync(backup, { force: true })
    cleanRedPartCache(packDir)
    onProgress('红色物品 3D 资源已校验并启用')
    return { ok: true, changed: true, bytes: m.size }
  } catch (e) {
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) }
  }
}
