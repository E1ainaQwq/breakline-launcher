import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

const round1 = (x: number): number => Math.round(x * 10) / 10

/** PCL2 2.13.1.1's four-stage automatic heap formula, in GB. */
export function planHeapGb(availableGb: number, modCount: number): number {
  let avail = round1(Math.max(0, availableGb))
  const n = Math.max(0, Math.floor(modCount))
  const t1 = 1.5 + n / 90
  const t2 = 2.7 + n / 50
  const t3 = 4.5 + n / 25
  const minGb = 0.5 + n / 150

  let give = 0
  give += Math.min(avail, t1)
  avail -= t1
  if (avail >= 0.1) {
    const d = t2 - t1
    give += Math.min(avail * 0.7, d)
    avail -= d / 0.7
  }
  if (avail >= 0.1) {
    const d = t3 - t2
    give += Math.min(avail * 0.4, d)
    avail -= d / 0.4
  }
  if (avail >= 0.1) {
    give += Math.min(avail * 0.15, t3)
  }
  return round1(Math.max(give, minGb))
}

/** JVM -Xmx uses floor(GB * 1024), matching PCL's actual command line. */
export function planHeapMb(availableMb: number, modCount: number): number {
  return Math.floor(planHeapGb(availableMb / 1024, modCount) * 1024)
}

/** A valid player value always wins; zero/invalid means automatic, matching settings semantics. */
export function selectHeapMb(overrideMb: number | undefined, availableMb: number, modCount: number): number {
  return typeof overrideMb === 'number' && Number.isFinite(overrideMb) && overrideMb >= 512
    ? Math.min(32768, Math.round(overrideMb))
    : planHeapMb(availableMb, modCount)
}

/** Count only immediate jar/zip/litemod files, case-insensitively. */
export function countMods(modsDir: string): number {
  const exts = new Set(['.jar', '.zip', '.litemod'])
  try {
    return readdirSync(modsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && exts.has(extname(entry.name).toLowerCase())).length
  } catch {
    return 0
  }
}

export function runMemoryPlanSelfTest(): number {
  let failed = 0
  const check = (label: string, actual: number, expected: number): void => {
    const ok = actual === expected
    console.log(`    ${ok ? '✓' : '✗'} ${label}${ok ? '' : `（${actual} ≠ ${expected}）`}`)
    if (!ok) failed++
  }
  console.log('\n── 自动内存（PCL2 四阶段公式）')
  check('PCL 实测锚点 16.6G/N53', planHeapGb(16.6, 53), 7.4)
  check('PCL 实测锚点 19G/N52', planHeapGb(19, 52), 7.7)
  check('低可用内存保护 4G/N73', planHeapGb(4, 73), 3.5)
  check('高可用内存 32G/N73', planHeapGb(32, 73), 10.3)
  check('极低可用下限', planHeapGb(0.3, 0), 0.5)
  check('高可用阶段封顶', planHeapGb(256, 0), 9)
  check('MB 命令行使用 floor', planHeapMb(16.6 * 1024, 53), 7577)
  check('手动 16G 保持不变', selectHeapMb(16384, 4096, 73), 16384)
  check('未设置时按可用内存和模组数自动分配', selectHeapMb(undefined, 4096, 73), 3584)
  const fixture = mkdtempSync(join(tmpdir(), 'delta-memory-plan-'))
  try {
    writeFileSync(join(fixture, 'a.jar'), '')
    writeFileSync(join(fixture, 'b.ZIP'), '')
    writeFileSync(join(fixture, 'c.litemod'), '')
    writeFileSync(join(fixture, 'ignored.jar.disabled'), '')
    writeFileSync(join(fixture, 'notes.txt'), '')
    mkdirSync(join(fixture, 'nested'))
    writeFileSync(join(fixture, 'nested', 'ignored.jar'), '')
    check('模组统计只认直接子级的三种扩展名', countMods(fixture), 3)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
  return failed === 0 ? 0 : 1
}
