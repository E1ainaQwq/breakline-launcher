import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const flags = { guns2d: true, effects: true, textures8x8: true, collectibles2d: true }
const graphics: Record<string, string> = { graphicsMode: '0', renderDistance: '6', simulationDistance: '5', renderClouds: '"false"', particles: '2', ao: 'false', entityShadows: 'false', entityDistanceScaling: '0.5', biomeBlendRadius: '0', mipmapLevels: '0' }
function object(file: string): Record<string, unknown> { if (!existsSync(file)) return {}; const value: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('低内存设置文件格式不正确'); return value as Record<string, unknown> }
function write(file: string, text: string): void { const temp = file + '.low-memory-next'; writeFileSync(temp, text, 'utf8'); renameSync(temp, file) }
export function lowMemoryHeapMb(memoryMb: number, enabled: boolean): number { return enabled ? Math.min(memoryMb, 3072) : memoryMb }
export function applyLowMemoryMode(gameDir: string, enabled: boolean | undefined): void {
 if (typeof enabled !== 'boolean') return
 const dir = join(gameDir, 'config'), state = join(dir, 'deltaui-launcher-low-memory-before.json'), pref = join(dir, 'deltaui-performance.json'), options = join(gameDir, 'options.txt')
 if (!enabled && !existsSync(state)) return
 if (enabled) {
  const mods = join(gameDir, 'mods')
  const supported = existsSync(mods) && readdirSync(mods).filter(n => /^(breakline|delta)-mod-.*\.jar$/i.test(n)).some(n => readFileSync(join(mods, n)).includes(Buffer.from('cn/zifeng/deltaui/LowSpecStartupPacks.class')))
  if (!supported) throw new Error('请先更新游戏包，再启用低配模式启动')
 }
 const data = object(pref)
 if (data.schemaVersion !== undefined && data.schemaVersion !== 1) throw new Error('游戏性能设置版本不兼容，未覆盖')
 const text = existsSync(options) ? readFileSync(options, 'utf8') : ''
 const original: Record<string, string | null> = {}
 for (const key of Object.keys(graphics)) original[key] = text.split(/\r?\n/).find(line => line.startsWith(key + ':'))?.slice(key.length + 1) ?? null
 mkdirSync(dir, { recursive: true })
 if (enabled && !existsSync(state)) writeFileSync(state, JSON.stringify({ schemaVersion: 1, flags: Object.fromEntries(Object.keys(flags).map(key => [key, data[key] ?? null])), graphics: original }), { encoding: 'utf8', flag: 'wx' })
 const before = object(state) as { schemaVersion?: number; flags?: Record<string, unknown>; graphics?: Record<string, string | null> }
 if (before.schemaVersion !== 1 || !before.flags || !before.graphics) throw new Error('低内存模式还原记录格式不正确，未覆盖')
 data.schemaVersion = 1
 for (const [key, value] of Object.entries(flags)) { if (enabled) data[key] = value; else if (before.flags[key] === null) delete data[key]; else data[key] = before.flags[key] }
 const lines = text.split(/\r?\n/).filter(line => line && !Object.keys(graphics).some(key => line.startsWith(key + ':')))
 for (const key of Object.keys(graphics)) { const value = enabled ? graphics[key] : before.graphics[key]; if (value !== null && value !== undefined) lines.push(key + ':' + value) }
 write(pref, JSON.stringify(data, null, 2)); write(options, lines.join('\n') + '\n')
 if (!enabled) unlinkSync(state)
}
