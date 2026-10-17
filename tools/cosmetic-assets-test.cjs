// Real HTTP fixtures use ephemeral Ed25519 keys only in a temporary source copy.
// The separately bundled production verifier must reject every fixture signature.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const crypto = require('node:crypto'), http = require('node:http'), zlib = require('node:zlib'), assert = require('node:assert/strict')
const esbuild = require('../node_modules/esbuild')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'breakline-cosmetics-test-'))
const services = path.resolve(__dirname, '../src/main/services'), signing = crypto.generateKeyPairSync('ed25519')
const publicKey = signing.publicKey.export({ type: 'spki', format: 'pem' }).trim()
const copied = path.join(root, 'services'); fs.cpSync(services, copied, { recursive: true })
const auth = path.join(copied, 'ManifestAuth.ts')
fs.writeFileSync(auth, fs.readFileSync(auth, 'utf8').replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/, publicKey))
function bundle(entry, name) { const output = path.join(root, name + '.cjs'); esbuild.buildSync({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'cjs' }); return require(output) }
const test = bundle(path.join(copied, 'CosmeticAssetProvision.ts'), 'fixture-service')
const production = bundle(path.join(services, 'CosmeticAssetProvision.ts'), 'production-service')
const route = '/api/cosmetics/v1/assets/manifest', game = path.join(root, 'game'), originals = path.join(root, 'game', 'config', 'breakline-cosmetics')
fs.mkdirSync(game); fs.writeFileSync(path.join(game, 'options.txt'), 'personal player configuration')
let checks = 0
function check(label, action) { action(); checks++; console.log('PASS ' + label) }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) } return (crc ^ 0xffffffff) >>> 0 }
function chunk(kind, data) { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(kind, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, b.length - 4)), b.length - 4); return b }
function png(color) { const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.from([0, ...color]))), chunk('IEND', Buffer.alloc(0))]) }
const objects = new Map()
function ref(bytes, extra = {}) { const sha256 = hash(bytes); objects.set(sha256, bytes); return { ...extra, size: bytes.length, sha256, url: 'https://dl.breakline-ops.lol/api/cosmetics/v1/assets/object/' + sha256 } }
const texture = png([255, 130, 20, 255]), metadata = Buffer.from(JSON.stringify({ pack: { pack_format: 15, description: 'isolated test only' } }))
function fixture(revision, extra = {}) {
  const definitions = { schemaVersion: 1, revision, definitions: [
    { id: 'fixture_operator', kind: 'operator_skin', name: 'Fixture ' + revision, targetId: 'deltaui:operator/luna', packId: 'fixture_pack', assetRevision: 1, texture: 'breakline_cosmetics:textures/fixture/body.png', model: 'wide' }
  ] }
  return { schemaVersion: 1, revision, definitionSnapshot: ref(Buffer.from(JSON.stringify(definitions)), { revision }), packs: [
    { id: 'fixture_pack', assetRevision: 1, files: [ref(metadata, { path: 'pack.mcmeta' }), ref(texture, { path: 'assets/breakline_cosmetics/textures/fixture/body.png' }), ref(texture, { path: 'assets/breakline_cosmetics/textures/fixture/duplicate.png' })] }
  ], ...extra }
}
function signed(manifest, overrides = {}) { const now = Math.floor(Date.now() / 1000), envelope = Buffer.from(JSON.stringify({ context: 'breakline-cosmetics-assets-v1', purpose: 'cosmetic-assets', path: route, issuedAt: now, expiresAt: now + 600, manifest, ...overrides })); return { ...manifest, authentication: { algorithm: 'Ed25519', keyId: 'origin-ed25519-20261007', envelope: envelope.toString('base64'), signature: crypto.sign(null, envelope, signing.privateKey).toString('base64') } } }
const clone = value => structuredClone(value)
let current = signed(fixture(1)), mode = 'normal', objectRequests = 0, localBase
const server = http.createServer((req, res) => {
  if (req.url === route) {
    if (mode === 'absent') { res.writeHead(404); return res.end() }
    if (mode === 'manifest-redirect') { res.writeHead(302, { Location: 'https://evil.invalid/' }); return res.end() }
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(current))
  }
  objectRequests++
  if (mode === 'disconnect') return req.socket.destroy()
  if (mode === 'object-redirect') { res.writeHead(302, { Location: 'https://evil.invalid/' }); return res.end() }
  const bytes = objects.get(req.url.split('/').pop())
  if (!bytes) { res.writeHead(404); return res.end() }
  if (mode === 'bad-hash') return res.end(Buffer.alloc(bytes.length))
  res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes)
})
const nativeFetch = global.fetch
global.fetch = (url, options) => {
  assert.equal(options.redirect, 'manual', 'cosmetic service must never follow redirects')
  const incoming = new URL(url), local = new URL(localBase + incoming.pathname)
  assert(['https://api.breakline-ops.lol', 'https://dl.breakline-ops.lol'].includes(incoming.origin))
  return nativeFetch(local, options)
}
const activeBytes = () => fs.readFileSync(path.join(originals, 'active.json'))
async function preserves(label, next, nextMode = 'normal') {
  const before = activeBytes(); current = next; mode = nextMode
  const result = await test.provisionCosmeticAssets(game)
  check(label, () => { assert.equal(result.status, 'failed', result.error); assert.equal(result.offlineReady, true); assert(activeBytes().equals(before)) })
  return result
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); localBase = 'http://127.0.0.1:' + server.address().port
  check('production signing key refuses ephemeral fixture', () => assert.throws(() => production.verifyCosmeticManifest(current), /签名/))
  check('fresh dedicated signature succeeds with temporary trust copy', () => assert.equal(test.verifyCosmeticManifest(current).revision, 1))
  for (const [label, overrides] of [ ['wrong context', { context: 'breakline-manifest-v1' }], ['wrong purpose', { purpose: 'client-bundle' }], ['wrong path', { path: '/api/client/bundle/manifest' }], ['expired network envelope', { issuedAt: 1, expiresAt: 601 }], ['future network envelope', { issuedAt: 9000000000, expiresAt: 9000000600 }] ]) check(label + ' is refused', () => assert.throws(() => test.verifyCosmeticManifest(signed(fixture(1), overrides))))
  check('offline signature survives transport expiry', () => assert.equal(test.verifyCosmeticManifest(signed(fixture(1), { issuedAt: 1, expiresAt: 601 }), false).revision, 1))
  check('duplicate JSON keys rejected', () => assert.throws(() => test.parseCosmeticJson(Buffer.from('{"a":1,"a":2}')), /重复/))
  check('escaped duplicate JSON keys rejected', () => assert.throws(() => test.parseCosmeticJson(Buffer.from('{"a":1,"\\u0061":2}')), /重复/))
  check('non-finite JSON numbers rejected', () => assert.throws(() => test.parseCosmeticJson(Buffer.from('{"n":1e999}')), /安全范围/))
  const first = await test.provisionCosmeticAssets(game)
  check('signed definitions, metadata and actual PNG installed together', () => { assert.equal(first.status, 'installed', first.error); assert.equal(first.offlineReady, true); assert.equal(first.revision, 1); assert.equal(JSON.parse(activeBytes()).definitionSnapshot.path, 'sets/1/definitions.json') })
  check('same-content textures share one HTTP object writer', () => assert.equal(objectRequests, 3))
  const firstPin = activeBytes(), count = objectRequests
  const second = await test.provisionCosmeticAssets(game)
  check('complete pin validates without downloading objects again', () => { assert.equal(second.status, 'current'); assert.equal(objectRequests, count); assert(activeBytes().equals(firstPin)) })
  for (const [label, mutate] of [
    ['path traversal', m => m.packs[0].files[1].path = '../mods/evil.jar'],
    ['foreign namespace', m => m.packs[0].files[1].path = 'assets/tacz/textures/gun.png'],
    ['executable extension', m => m.packs[0].files[1].path = 'assets/breakline_cosmetics/textures/a.class'],
    ['Windows reserved filename', m => m.packs[0].files[1].path = 'assets/breakline_cosmetics/textures/con.png'],
    ['Windows reserved pack', m => m.packs[0].id = 'com1'],
    ['duplicate file', m => m.packs[0].files.push(clone(m.packs[0].files[1]))],
    ['unsigned draft', m => m.definitionSnapshot = null],
    ['cross-origin URL', m => m.definitionSnapshot.url = 'https://evil.invalid/api/cosmetics/v1/assets/object/' + m.definitionSnapshot.sha256],
    ['URL query', m => m.definitionSnapshot.url += '?token=evil'],
    ['URL port', m => m.definitionSnapshot.url = m.definitionSnapshot.url.replace('.lol/', '.lol:443/')],
    ['URL path normalization', m => m.definitionSnapshot.url = m.definitionSnapshot.url.replace('/assets/', '/assets/../assets/')],
    ['same hash size conflict', m => m.packs[0].files[2].size++],
    ['oversized object', m => m.packs[0].files[1].size = 16 * 1048576 + 1]
  ]) { const m = fixture(2); mutate(m); await preserves(label + ' keeps old active pin', signed(m)) }
  await preserves('bad object hash keeps old active pin', signed(fixture(2)), 'bad-hash')
  await preserves('real socket disconnect keeps old active pin', signed(fixture(2)), 'disconnect')
  await preserves('HTTP object redirect keeps old active pin', signed(fixture(2)), 'object-redirect')
  await preserves('HTTP manifest redirect keeps old active pin', signed(fixture(2)), 'manifest-redirect')
  const badDefinition = fixture(3), d = JSON.parse(objects.get(badDefinition.definitionSnapshot.sha256)); d.definitions[0].texture = 'breakline_cosmetics:textures/absent.png'; badDefinition.definitionSnapshot = ref(Buffer.from(JSON.stringify(d)), { revision: 3 })
  await preserves('signed missing definition resource keeps old active pin', signed(badDefinition))
  const badPng = fixture(4), invalidPng = png([1, 2, 3, 4]); invalidPng[invalidPng.length - 1] ^= 1
  badPng.packs[0].assetRevision = 2
  const bd = JSON.parse(objects.get(badPng.definitionSnapshot.sha256)); bd.definitions[0].assetRevision = 2; badPng.definitionSnapshot = ref(Buffer.from(JSON.stringify(bd)), { revision: 4 }); badPng.packs[0].files[1] = ref(invalidPng, { path: badPng.packs[0].files[1].path })
  await preserves('hash-correct malformed PNG is rejected before commit', signed(badPng))
  const next = fixture(5); current = signed(next); mode = 'normal'
  const install = await test.provisionCosmeticAssets(game)
  check('later valid revision commits atomically', () => { assert.equal(install.status, 'installed', install.error); assert.equal(JSON.parse(activeBytes()).revision, 5); assert(fs.readFileSync(path.join(originals, 'previous.json')).equals(firstPin)) })
  await preserves('signed revision rollback rejected', signed(fixture(1)))
  const changed = fixture(5); changed.definitionSnapshot = ref(Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 5, definitions: [] })), { revision: 5 }); await preserves('same revision different content rejected', signed(changed))
  const immutable = fixture(6); immutable.packs[0].files[1] = ref(png([1, 2, 3, 4]), { path: immutable.packs[0].files[1].path }); await preserves('pack identity plus revision cannot change its bytes', signed(immutable))
  const rebound = fixture(7), reboundDefinitions = JSON.parse(objects.get(rebound.definitionSnapshot.sha256)); reboundDefinitions.definitions[0].texture = 'breakline_cosmetics:textures/fixture/duplicate.png'; rebound.definitionSnapshot = ref(Buffer.from(JSON.stringify(reboundDefinitions)), { revision: 7 })
  await preserves('changing render binding needs a new asset revision even with identical PNG bytes', signed(rebound))
  current = signed(fixture(5)); mode = 'absent'
  const absent = await test.provisionCosmeticAssets(game)
  check('404 absent manifest does not block valid old pin', () => { assert.equal(absent.status, 'unavailable'); assert.equal(absent.offlineReady, true) })
  const freshGame = path.join(root, 'fresh-game'); fs.mkdirSync(freshGame)
  const firstAbsent = await test.provisionCosmeticAssets(freshGame)
  check('first-run absent catalog does not create an active pin', () => { assert.equal(firstAbsent.status, 'unavailable'); assert.equal(firstAbsent.offlineReady, false); assert(!fs.existsSync(path.join(freshGame, 'config/breakline-cosmetics/active.json'))) })
  const old = JSON.parse(activeBytes()), offlineManifest = signed(next, { issuedAt: 1, expiresAt: 601 }); old.manifest = offlineManifest; old.envelopeSha256 = hash(Buffer.from(offlineManifest.authentication.envelope, 'base64')); fs.writeFileSync(path.join(originals, 'active.json'), JSON.stringify(old))
  await new Promise(resolve => server.close(resolve)); localBase = 'http://127.0.0.1:1'
  const offline = await test.provisionCosmeticAssets(game)
  check('real network failure keeps expired but valid offline pin', () => { assert.equal(offline.status, 'failed'); assert.equal(offline.offlineReady, true); assert.equal(offline.revision, 5) })
  check('personal game configuration remains unchanged', () => assert.equal(fs.readFileSync(path.join(game, 'options.txt'), 'utf8'), 'personal player configuration'))
  const source = fs.readFileSync(path.resolve(__dirname, '../src/main/index.ts'), 'utf8')
  check('one shared launch path invokes installer before issuing admission token', () => { assert.equal((source.match(/await provisionCosmeticAssets\(/g) || []).length, 1); assert(source.indexOf('await provisionCosmeticAssets(') < source.indexOf('issued = await player.launcherToken')); assert(source.indexOf('if (!dryRun) {', source.indexOf('const launchChecked')) < source.indexOf('await provisionCosmeticAssets(')) })
  const evidence = { checks, result: 'PASS', fixtureKeyOnly: true, productionFixtureRejected: true, game, pin: path.join(originals, 'active.json'), publicKeyDerBase64: signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), activeSha256: hash(activeBytes()) }
  if (process.env.COSMETIC_TEST_EVIDENCE) { fs.mkdirSync(path.dirname(process.env.COSMETIC_TEST_EVIDENCE), { recursive: true }); fs.writeFileSync(process.env.COSMETIC_TEST_EVIDENCE, JSON.stringify(evidence, null, 2)) }
  console.log(JSON.stringify(evidence, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { global.fetch = nativeFetch; server.closeAllConnections(); server.close(); if (!process.env.COSMETIC_TEST_EVIDENCE) fs.rmSync(root, { recursive: true, force: true }) })
