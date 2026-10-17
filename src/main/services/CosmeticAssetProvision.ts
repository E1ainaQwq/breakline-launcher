import { createHash, randomUUID, verify } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import { TextDecoder } from 'node:util'
import { MANIFEST_KEY_ID, MANIFEST_PUBLIC_KEY, RESOURCE_DOWNLOAD_HEADERS } from './ManifestAuth'
import { downloadQueue } from './PinnedDownload'

const ROUTE = '/api/cosmetics/v1/assets/manifest'
const MAX_TOTAL = 512 * 1048576, MAX_JSON = 4 * 1048576
type Json = Record<string, unknown>
type ObjectRef = { revision?: number; size: number; sha256: string; url: string }
type Pack = { id: string; assetRevision: number; files: (ObjectRef & { path: string })[] }
type Manifest = { schemaVersion: 1; revision: number; definitionSnapshot: ObjectRef & { revision: number }; packs: Pack[]; authentication: Json }
export type CosmeticAssetResult = { status: 'installed' | 'current' | 'unavailable' | 'failed'; changed: boolean; offlineReady: boolean; revision?: number; error?: string }
const pending = new Map<string, Promise<CosmeticAssetResult>>()
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const fail = (reason: string): never => { throw new Error('装扮资源：' + reason) }
function object(value: unknown): Json { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('JSON 对象格式无效'); return value as Json }
function keys(value: unknown, allowed: string[]): Json { const v = object(value); if (Object.keys(v).some(k => !allowed.includes(k))) fail('包含不支持的字段'); return v }
function integer(v: unknown, maximum = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > maximum) return fail('数值超出范围'); return v as number }
function text(v: unknown, max = 256): string { if (typeof v !== 'string' || !v.length || v.length > max || /[\u0000-\u001f]/.test(v)) return fail('文本格式无效'); return v }
function stable(v: unknown): string {
  const s = text(v, 96)
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) || s === '.' || s === '..') fail('目录标识无效')
  return s
}
function array(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max) return fail('数组超出范围'); return v }
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Json)[k])).join(',') + '}'
  return JSON.stringify(v)
}

/** JSON.parse alone silently accepts duplicate keys, including inside the signed envelope. */
export function parseCosmeticJson(bytes: Buffer): unknown {
  if (bytes.length > MAX_JSON) fail('JSON 文件过大')
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let at = 0
  const ws = (): void => { while (/\s/.test(source[at] ?? '') && at < source.length) at++ }
  const string = (): string => {
    const start = at++
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue }
      if (source[at++] === '"') return JSON.parse(source.slice(start, at)) as string
    }
    return fail('JSON 字符串未结束')
  }
  const value = (depth: number): void => {
    if (depth > 32) fail('JSON 嵌套过深')
    ws()
    if (source[at] === '"') { string(); return }
    if (source[at] === '{') {
      at++; ws(); const seen = new Set<string>()
      if (source[at] === '}') { at++; return }
      while (true) {
        ws(); if (source[at] !== '"') fail('JSON 对象键无效')
        const k = string(); if (seen.has(k)) fail('JSON 存在重复字段'); seen.add(k)
        ws(); if (source[at++] !== ':') fail('JSON 缺少冒号'); value(depth + 1); ws()
        const end = source[at++]; if (end === '}') return; if (end !== ',') fail('JSON 对象未结束')
      }
    }
    if (source[at] === '[') {
      at++; ws(); if (source[at] === ']') { at++; return }
      while (true) { value(depth + 1); ws(); const end = source[at++]; if (end === ']') return; if (end !== ',') fail('JSON 数组未结束') }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at))
    if (!match) fail('JSON 值无效')
    if (/^-?\d/.test(match![0]) && (!Number.isFinite(Number(match![0])) || Math.abs(Number(match![0])) > Number.MAX_SAFE_INTEGER)) fail('JSON 数值超出安全范围')
    at += match![0].length
  }
  value(0); ws(); if (at !== source.length) fail('JSON 含多余内容')
  return JSON.parse(source)
}

function trustedUrl(raw: unknown, objectHash?: string): URL {
  const s = text(raw, 256), url = new URL(s)
  const expected = objectHash ? '/api/cosmetics/v1/assets/object/' + objectHash : ROUTE
  if (!['https://api.breakline-ops.lol', 'https://dl.breakline-ops.lol'].includes(url.origin) || url.username || url.password || url.port || url.search || url.hash || url.pathname !== expected || url.href !== s) fail('下载地址不属于受信官方对象源')
  return url
}
function reference(value: unknown, definitions = false): ObjectRef {
  const ref = keys(value, definitions ? ['revision', 'size', 'sha256', 'url'] : ['path', 'size', 'sha256', 'url'])
  integer(ref.size, definitions ? MAX_JSON : 16 * 1048576)
  if (!/^[a-f0-9]{64}$/.test(text(ref.sha256, 64))) fail('SHA-256 无效')
  trustedUrl(ref.url, ref.sha256 as string)
  if (definitions) integer(ref.revision)
  return ref as unknown as ObjectRef
}
function safeFile(raw: unknown): string {
  const p = text(raw, 512)
  if (!/^(?:pack\.mcmeta|assets\/breakline_cosmetics\/textures\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.png|assets\/breakline_cosmetics\/display\/guns\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.json)$/.test(p)) fail('文件路径或类型不允许')
  p.split('/').forEach(stable); return p
}
function safePath(root: string, relative: string): string {
  const base = resolve(root), target = resolve(base, relative)
  if (!target.startsWith(base + sep)) fail('文件越界')
  for (let p = target; ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) fail('禁止符号链接或目录联接')
    if (p === base) break
  }
  return target
}

/** Online freshness is mandatory; an installed offline pin retains its original signature indefinitely. */
export function verifyCosmeticManifest(raw: unknown, online = true, now = Date.now()): Manifest {
  const signed = keys(raw, ['schemaVersion', 'revision', 'definitionSnapshot', 'packs', 'authentication'])
  const auth = keys(signed.authentication, ['algorithm', 'keyId', 'envelope', 'signature'])
  if (auth.algorithm !== 'Ed25519' || auth.keyId !== MANIFEST_KEY_ID) fail('签名密钥不受信')
  const envelopeText = text(auth.envelope, MAX_JSON), signatureText = text(auth.signature, 88)
  const envelope = Buffer.from(envelopeText, 'base64'), signature = Buffer.from(signatureText, 'base64')
  if (signature.length !== 64 || signature.toString('base64') !== signatureText || envelope.toString('base64') !== envelopeText || !verify(null, envelope, MANIFEST_PUBLIC_KEY, signature)) fail('官方签名校验失败')
  const payload = keys(parseCosmeticJson(envelope), ['context', 'purpose', 'path', 'issuedAt', 'expiresAt', 'manifest'])
  const issued = integer(payload.issuedAt), expires = integer(payload.expiresAt), seconds = Math.floor(now / 1000)
  const { authentication: _, ...manifest } = signed
  if (payload.context !== 'breakline-cosmetics-assets-v1' || payload.purpose !== 'cosmetic-assets' || payload.path !== ROUTE || expires - issued !== 600 || (online && (issued > seconds + 120 || expires < seconds - 120)) || canonical(payload.manifest) !== canonical(manifest)) fail('签名用途、时效或内容不符')
  if (manifest.schemaVersion !== 1) fail('清单版本不支持'); integer(manifest.revision)
  const descriptor = reference(manifest.definitionSnapshot, true)
  const ids = new Set<string>(), resources = new Set<string>(), hashes = new Map<string, number>()
  let total = descriptor.size
  const checkHash = (ref: ObjectRef): void => { if (hashes.has(ref.sha256) && hashes.get(ref.sha256) !== ref.size) fail('同一哈希大小冲突'); hashes.set(ref.sha256, ref.size) }
  checkHash(descriptor)
  for (const p of array(manifest.packs, 128)) {
    const pack = keys(p, ['id', 'assetRevision', 'files']), id = stable(pack.id)
    if (ids.has(id.toLowerCase())) fail('包标识重复'); ids.add(id.toLowerCase()); integer(pack.assetRevision)
    const files = array(pack.files, 20000), seen = new Set<string>(); let metadata = false, texture = false
    if (!files.length) fail('空资源包不可安装')
    for (const f of files) {
      const ref = reference(f), path = safeFile(object(f).path)
      if (seen.has(path.toLowerCase()) || (path !== 'pack.mcmeta' && resources.has(path))) fail('资源文件重复或跨包冲突')
      seen.add(path.toLowerCase()); resources.add(path); checkHash(ref); total += ref.size
      metadata ||= path === 'pack.mcmeta'; texture ||= path.endsWith('.png')
    }
    if (!metadata || !texture) fail('资源包缺少元信息或 PNG')
  }
  if (total > MAX_TOTAL) fail('资源集超过 512 MiB')
  return signed as unknown as Manifest
}

const crcTable = Array.from({ length: 256 }, (_, byte) => { let crc = byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc >>> 0 })
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}
function validatePng(bytes: Buffer): void {
  if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('贴图不是 PNG')
  let at = 8, width = 0, height = 0, depth = 0, color = 0, ended = false, palette = false
  const compressed: Buffer[] = []
  while (at < bytes.length) {
    if (at + 12 > bytes.length) fail('PNG 数据不完整')
    const n = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8), end = at + 12 + n
    if (end > bytes.length || crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('PNG 块校验失败')
    if (at === 8 && (kind !== 'IHDR' || n !== 13)) fail('PNG 头部无效')
    if (kind === 'IHDR') {
      if (at !== 8) fail('PNG 重复头部')
      width = bytes.readUInt32BE(at + 8); height = bytes.readUInt32BE(at + 12); depth = bytes[at + 16]; color = bytes[at + 17]
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!width || !height || width > 4096 || height > 4096 || !depths[color]?.includes(depth) || bytes[at + 18] !== 0 || bytes[at + 19] !== 0 || bytes[at + 20] !== 0) fail('PNG 尺寸或编码不支持，请导出普通非交错 PNG')
    } else if (kind === 'IDAT') compressed.push(bytes.subarray(at + 8, end - 4))
    else if (kind === 'PLTE') { if (!n || n % 3 || n > 768) fail('PNG 调色板无效'); palette = true }
    else if (kind === 'IEND') { if (n || end !== bytes.length) fail('PNG 结尾无效'); ended = true }
    else if (kind[0] === kind[0].toUpperCase()) fail('PNG 包含未知关键数据块')
    at = end
  }
  if (!ended || !compressed.length || (color === 3 && !palette)) fail('PNG 缺少图像数据')
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const stride = Math.ceil(width * channels[color] * depth / 8) + 1, expected = stride * height
  const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 })
  if (decoded.length !== expected) fail('PNG 解码长度不符')
  for (let row = 0; row < height; row++) if (decoded[row * stride] > 4) fail('PNG 行过滤器无效')
}
function bytesAt(root: string, relative: string, ref: ObjectRef): Buffer {
  const path = safePath(root, relative)
  if (!statSync(path).isFile() || statSync(path).size !== ref.size) return fail('资源长度不符')
  const bytes = readFileSync(path); if (sha256(bytes) !== ref.sha256) fail('资源哈希不符'); return bytes
}
function resourceId(raw: unknown, cosmetic = false): string {
  const s = text(raw)
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(s) || s.split(':')[1].split('/').some(v => v === '.' || v === '..' || !v)) fail('资源标识无效')
  if (cosmetic && !s.startsWith('breakline_cosmetics:')) fail('外观不能覆盖其他命名空间'); return s
}
function validateDefinitions(value: unknown, manifest: Manifest): void {
  const defs = keys(value, ['schemaVersion', 'revision', 'definitions'])
  if (defs.schemaVersion !== 1 || defs.revision !== manifest.definitionSnapshot.revision) fail('定义快照版本不符')
  const packs = new Map(manifest.packs.map(p => [p.id, p])), ids = new Set<string>(), displays = new Set<string>(), usedPacks = new Set<string>()
  for (const entry of array(defs.definitions, 10000)) {
    const d = object(entry), common = ['id', 'kind', 'name', 'targetId', 'packId', 'assetRevision', 'quality', 'poster']
    if (d.quality !== undefined && !['green', 'blue', 'purple', 'gold'].includes(text(d.quality, 16))) fail('外观品质无效')
    const id = stable(d.id), pack = packs.get(stable(d.packId)); text(d.name, 96); resourceId(d.targetId)
    if (!pack) return fail('定义引用未知资源包')
    if (ids.has(id) || pack.assetRevision !== integer(d.assetRevision)) fail('定义重复或包版本不匹配'); ids.add(id); usedPacks.add(pack.id)
    const requireFile = (path: string): void => { if (!pack.files.some(f => f.path === path)) fail('定义引用未固定资源') }
    const texture = (raw: unknown): void => { const r = resourceId(raw, true); const path = 'assets/' + r.replace(':', '/'); safeFile(path); if (!path.endsWith('.png')) fail('材质必须是 PNG'); requireFile(path) }
    if (d.poster !== undefined) texture(d.poster)
    if (d.kind === 'gun_skin') {
      keys(d, [...common, 'displayId', 'attachmentOverrides']); const display = resourceId(d.displayId, true)
      if (displays.has(display)) fail('展示 ID 重复'); displays.add(display); requireFile('assets/breakline_cosmetics/display/guns/' + display.split(':')[1] + '.json')
      const attachments = new Set<string>()
      for (const raw of d.attachmentOverrides === undefined ? [] : array(d.attachmentOverrides, 256)) {
        const a = keys(raw, ['attachmentId', 'texture', 'lodTexture']), id = resourceId(a.attachmentId)
        if (attachments.has(id)) fail('配件映射重复'); attachments.add(id); texture(a.texture); if (a.lodTexture !== undefined) texture(a.lodTexture)
      }
    } else if (d.kind === 'operator_skin') {
      keys(d, [...common, 'texture', 'model']); if (!(d.targetId as string).startsWith('deltaui:operator/') || !['wide', 'slim'].includes(d.model as string)) fail('干员绑定无效'); texture(d.texture)
    } else fail('未知外观类型')
  }
  if (manifest.packs.some(p => !usedPacks.has(p.id))) fail('资源包没有任何兼容定义')
}
function validateSet(manifest: Manifest, setRoot: string): void {
  const definitions = parseCosmeticJson(bytesAt(setRoot, 'definitions.json', manifest.definitionSnapshot))
  validateDefinitions(definitions, manifest)
  for (const pack of manifest.packs) for (const f of pack.files) {
    const bytes = bytesAt(setRoot, pack.id + '/' + pack.assetRevision + '/' + f.path, f)
    if (f.path.endsWith('.png')) validatePng(bytes)
    else if (f.path === 'pack.mcmeta') {
      const metadata = keys(parseCosmeticJson(bytes), ['pack']), p = keys(metadata.pack, ['pack_format', 'description'])
      if (p.pack_format !== 15) fail('资源包版本无效'); text(p.description)
    } else {
      // Native Java bridge performs the exact trusted base-display comparison before publishing an index.
      // Never auto-mount these display JSON files through TaCZ's normal gun-pack scanner.
      const display = object(parseCosmeticJson(bytes))
      for (const key of ['texture', 'hud', 'hud_empty', 'slot']) if (display[key] !== undefined) {
        const id = resourceId(display[key]); if (id.startsWith('breakline_cosmetics:')) {
          const path = 'assets/breakline_cosmetics/textures/' + id.split(':')[1] + '.png'
          if (!pack.files.some(file => file.path === path)) fail('枪械展示引用未固定材质')
        }
      }
    }
  }
}
function atomicJson(root: string, name: string, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > MAX_JSON) fail('启动 pin 超出运行时限制')
  const temporary = safePath(root, name + '.' + randomUUID() + '.tmp'), target = safePath(root, name)
  const fd = openSync(temporary, 'wx')
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temporary, target) } finally { rmSync(temporary, { force: true }) }
}
function durableCopy(source: string, target: string): void {
  copyFileSync(source, target)
  const fd = openSync(target, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function pinFor(m: Manifest): Json {
  return { schemaVersion: 1, revision: m.revision, manifest: m, envelopeSha256: sha256(Buffer.from(m.authentication.envelope as string, 'base64')),
    definitionSnapshot: { revision: m.definitionSnapshot.revision, size: m.definitionSnapshot.size, sha256: m.definitionSnapshot.sha256, path: `sets/${m.revision}/definitions.json` },
    packs: m.packs.map(p => ({ id: p.id, assetRevision: p.assetRevision, path: `sets/${m.revision}/${p.id}/${p.assetRevision}` })) }
}
function readActive(root: string): Manifest | undefined {
  const path = safePath(root, 'active.json'); if (!existsSync(path)) return undefined
  const pin = object(parseCosmeticJson(readFileSync(path))), manifest = verifyCosmeticManifest(pin.manifest, false)
  if (canonical(pin) !== canonical(pinFor(manifest))) fail('启动 pin 字段不一致')
  validateSet(manifest, safePath(root, 'sets/' + manifest.revision)); return manifest
}
async function getBytes(url: URL, limit: number): Promise<{ status: number; bytes: Buffer }> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
  const arm = (ms: number): void => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('装扮资源连接超时')), ms) }
  arm(8000)
  let response: Response | undefined
  try {
    response = await fetch(url, { headers: RESOURCE_DOWNLOAD_HEADERS, redirect: 'manual', signal: controller.signal })
    if (response.status >= 300 && response.status < 400) fail('禁止资源地址重定向')
    if (!response.ok) { await response.body?.cancel(); return { status: response.status, bytes: Buffer.alloc(0) } }
    const size = Number(response.headers.get('content-length')); if (Number.isFinite(size) && size > limit) fail('下载超过清单大小')
    if (!response.body) fail('下载响应为空'); arm(15000)
    const chunks: Buffer[] = []; let total = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length; if (total > limit) fail('下载超过清单大小'); chunks.push(Buffer.from(chunk)); arm(15000)
    }
    return { status: response.status, bytes: Buffer.concat(chunks) }
  } finally { clearTimeout(timer!); try { await response?.body?.cancel() } catch { /* Reader has already finished or failed. */ } }
}
async function cachedObject(root: string, ref: ObjectRef): Promise<string> {
  const path = safePath(root, '.objects/' + ref.sha256); mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path) && statSync(path).isFile() && statSync(path).size === ref.size && sha256(readFileSync(path)) === ref.sha256) return path
  let error: unknown
  for (let attempt = 0; attempt < 2; attempt++) try {
    const response = await getBytes(trustedUrl(ref.url, ref.sha256), ref.size)
    if (response.status !== 200 || response.bytes.length !== ref.size || sha256(response.bytes) !== ref.sha256) fail('对象下载或内容校验失败')
    const part = safePath(root, '.objects/' + ref.sha256 + '.part'), fd = openSync(part, 'w')
    try { writeSync(fd, response.bytes); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(part, path); return path
  } catch (e) { error = e }
  throw error
}
function compareManifest(old: Manifest, incoming: Manifest): void {
  const { authentication: a, ...oldPayload } = old, { authentication: b, ...nextPayload } = incoming
  if (old.revision > incoming.revision || (old.revision === incoming.revision && canonical(oldPayload) !== canonical(nextPayload))) fail('拒绝清单版本回退或同版本变更')
  for (const pack of old.packs) {
    const next = incoming.packs.find(p => p.id === pack.id && p.assetRevision === pack.assetRevision)
    if (next && canonical(pack) !== canonical(next)) fail('已有包版本内容不可变')
  }
}
function checkHistory(root: string, incoming: Manifest, active?: Manifest): void {
  if (active) compareManifest(active, incoming)
  const dir = safePath(root, '.manifests'); mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir)) {
    if (!/^[1-9]\d*\.json$/.test(name)) fail('历史清单目录存在未知文件')
    const file = safePath(root, '.manifests/' + name)
    if (statSync(file).size > MAX_JSON) fail('历史清单过大')
    const old = verifyCosmeticManifest(parseCosmeticJson(readFileSync(file)), false)
    compareManifest(old, incoming)
  }
  atomicJson(root, '.manifests/' + incoming.revision + '.json', incoming)
}
function checkInstalledBindings(root: string, incoming: Manifest, nextDefinitions: unknown): void {
  const binding = (value: unknown, pack: Pack): string => canonical(array(object(value).definitions, 10000)
    .map(object).filter(d => d.packId === pack.id && d.assetRevision === pack.assetRevision)
    .map(({ name: _, ...render }) => render).sort((a, b) => String(a.id).localeCompare(String(b.id))))
  for (const name of readdirSync(safePath(root, '.manifests'))) {
    const old = verifyCosmeticManifest(parseCosmeticJson(readFileSync(safePath(root, '.manifests/' + name))), false)
    const definitionPath = safePath(root, 'sets/' + old.revision + '/definitions.json')
    if (old.revision === incoming.revision || !existsSync(definitionPath)) continue
    const oldDefinitions = parseCosmeticJson(bytesAt(root, 'sets/' + old.revision + '/definitions.json', old.definitionSnapshot))
    for (const pack of incoming.packs) if (old.packs.some(p => p.id === pack.id && p.assetRevision === pack.assetRevision) && binding(oldDefinitions, pack) !== binding(nextDefinitions, pack)) fail('修改渲染绑定必须增加资源包版本')
  }
}

/** Only call while the game is stopped. No endpoint yet (404/501) is an explicit, non-blocking skip. */
export function provisionCosmeticAssets(gameDir: string, log: (line: string) => void = () => {}): Promise<CosmeticAssetResult> {
  const key = resolve(gameDir)
  const running = pending.get(key); if (running) return running
  const task = provision(key, log).finally(() => pending.delete(key)); pending.set(key, task); return task
}
async function provision(gameDir: string, log: (line: string) => void): Promise<CosmeticAssetResult> {
  let old: Manifest | undefined, stage: string | undefined, root = ''
  try {
    root = safePath(gameDir, 'config/breakline-cosmetics'); mkdirSync(root, { recursive: true })
    try { old = readActive(root) } catch { log('旧装扮资源未通过完整校验，将尝试修复；原有文件保留。') }
    const response = await getBytes(trustedUrl('https://api.breakline-ops.lol' + ROUTE), MAX_JSON)
    if ([404, 501].includes(response.status)) { log('装扮资源目录尚未启用，继续启动。'); return { status: 'unavailable', changed: false, offlineReady: !!old, revision: old?.revision } }
    if (response.status !== 200) fail('清单 HTTP ' + response.status)
    const manifest = verifyCosmeticManifest(parseCosmeticJson(response.bytes))
    checkHistory(root, manifest, old)
    if (old?.revision === manifest.revision && canonical(old.definitionSnapshot) === canonical(manifest.definitionSnapshot) && canonical(old.packs) === canonical(manifest.packs)) return { status: 'current', changed: false, offlineReady: true, revision: old.revision }
    log('正在校验并下载独立装扮资源…')
    const refs = [manifest.definitionSnapshot, ...manifest.packs.flatMap(p => p.files)]
    await downloadQueue([...new Map(refs.map(f => [f.sha256, f])).values()], 4, async ref => { await cachedObject(root, ref) })
    stage = mkdtempSync(safePath(root, '.stage-'))
    durableCopy(safePath(root, '.objects/' + manifest.definitionSnapshot.sha256), safePath(stage, 'definitions.json'))
    for (const pack of manifest.packs) for (const f of pack.files) {
      const target = safePath(stage, pack.id + '/' + pack.assetRevision + '/' + f.path); mkdirSync(dirname(target), { recursive: true }); durableCopy(safePath(root, '.objects/' + f.sha256), target)
    }
    validateSet(manifest, stage)
    checkInstalledBindings(root, manifest, parseCosmeticJson(bytesAt(stage, 'definitions.json', manifest.definitionSnapshot)))
    const final = safePath(root, 'sets/' + manifest.revision); mkdirSync(dirname(final), { recursive: true })
    // Completed sets are immutable; repair a corrupt same-revision set without touching the active pin.
    if (existsSync(final)) { try { validateSet(manifest, final) } catch { renameSync(final, safePath(root, '.invalid-' + manifest.revision + '-' + randomUUID())) } }
    if (!existsSync(final)) { renameSync(stage, final); stage = undefined }
    if (old) atomicJson(root, 'previous.json', pinFor(old))
    atomicJson(root, 'active.json', pinFor(manifest))
    log('独立装扮资源已完整安装。')
    return { status: 'installed', changed: true, offlineReady: true, revision: manifest.revision }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log(error + (old ? '；保留已验证的旧装扮资源，继续启动。' : '；继续使用基础外观启动。'))
    return { status: 'failed', changed: false, offlineReady: !!old, revision: old?.revision, error }
  } finally {
    if (stage && root && resolve(stage).startsWith(resolve(root) + sep) && !lstatSync(stage).isSymbolicLink()) rmSync(stage, { recursive: true, force: true })
  }
}
