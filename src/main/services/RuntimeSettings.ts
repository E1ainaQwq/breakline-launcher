import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { validateJava } from './JavaDetect'

/**
 * 游戏运行参数的读写（片 1 后半：让玩家在界面上真的能改）。
 *
 * <h2>为什么单独一个文件，而不是塞进 index.ts</h2>
 * 这段要做三件**容易做错**的事，放在一起才看得清、也才好测：
 *   ① **白名单**：只接受运行参数的明确白名单键。
 *      绝不能做成"把界面传来的 JSON 合并进 settings.json" —— 那等于开了一条改
 *      `gameRoot` / `java` 的旁路，会把"路径由启动器固定"这条约束**悄悄拆掉**
 *      （设置页当初做成只读就是为了这个）。
 *   ② **范围钳制**：与 `LaunchArgs` 同一套口径。界面给什么都不能让命令行里出现
 *      `-Xmx0M` 或 `--width 99999` 这种把游戏弄起不来的值。
 *   ③ **写完回读**：返回**实际生效**的值。"保存成功但没生效"是这类设置界面的经典坑，
 *      而回读是唯一能当场发现它的办法（比如文件被占用、盘满、或上面两条把值改掉了）。
 */

export interface RuntimeSettings {
  lowMemoryMode?: boolean
  memoryMb?: number
  gcMode?: 'template' | 'tuned'
  memoryCleanupEnabled?: boolean
  memoryCleanupNoticeSeen?: boolean
  gameImportNoticeSeen?: boolean
  /** 玩家选择的 java.exe 路径（片 2）。**必须校验能跑**：选错了要当场说，不许静默回退。 */
  java?: string
  width?: number
  height?: number
  fullscreen?: boolean
}


function clampInt(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === 'number' ? v : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

export function settingsFile(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

function readAll(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 写入运行参数并**回读生效值**。
 *
 * @param patch 只认那四个键；非法值被忽略（不是抛错）—— 界面上的一个笔误不该让保存整体失败。
 * @returns 写入后**文件里真实存在**的值
 */
export async function setRuntimeSettings(patch: RuntimeSettings): Promise<RuntimeSettings> {
  const current = readAll()
  if (typeof patch.lowMemoryMode === 'boolean') current.lowMemoryMode = patch.lowMemoryMode

  const memoryMb = clampInt(patch.memoryMb, 512, 32768)
  if (memoryMb !== undefined) current.memoryMb = memoryMb
  if (patch.gcMode === 'template' || patch.gcMode === 'tuned') current.gcMode = patch.gcMode
  if (typeof patch.memoryCleanupEnabled === 'boolean') current.memoryCleanupEnabled = patch.memoryCleanupEnabled
  if (typeof patch.memoryCleanupNoticeSeen === 'boolean') current.memoryCleanupNoticeSeen = patch.memoryCleanupNoticeSeen
  if (typeof patch.gameImportNoticeSeen === 'boolean') current.gameImportNoticeSeen = patch.gameImportNoticeSeen

  const width = clampInt(patch.width, 320, 7680)
  if (width !== undefined) current.width = width
  const height = clampInt(patch.height, 240, 4320)
  if (height !== undefined) current.height = height

  if (typeof patch.fullscreen === 'boolean') current.fullscreen = patch.fullscreen
  // java 路径：**先校验再写**（片 2 的验收条件：选到不存在的路径要明确报错，不许静默回退）。
  if (typeof patch.java === 'string') {
    if (patch.java.trim() === '') {
      delete current.java          // 传空 = 回到自动探测
    } else {
      const check = await validateJava(patch.java)
      if (!check.ok) throw new Error(`Java 不可用：${check.error}`)
      current.java = patch.java.trim()
    }
  }

  // 「清空」语义：显式传 0 / 空字符串表示回到默认——否则界面上没有"恢复默认"的出口。
  if (patch.memoryMb === 0) delete current.memoryMb
  if (patch.width === 0) delete current.width
  if (patch.height === 0) delete current.height

  writeFileSync(settingsFile(), JSON.stringify(current, null, 2), 'utf8')

  // 回读：拿文件里的真实值，而不是"我以为写进去的值"。
  const after = readAll()
  const out: RuntimeSettings = {}
  if (typeof after.lowMemoryMode === 'boolean') out.lowMemoryMode = after.lowMemoryMode
  const m = clampInt(after.memoryMb, 512, 32768)
  if (m !== undefined) out.memoryMb = m
  if (after.gcMode === 'template' || after.gcMode === 'tuned') out.gcMode = after.gcMode
  if (typeof after.memoryCleanupEnabled === 'boolean') out.memoryCleanupEnabled = after.memoryCleanupEnabled
  if (typeof after.memoryCleanupNoticeSeen === 'boolean') out.memoryCleanupNoticeSeen = after.memoryCleanupNoticeSeen
  if (typeof after.gameImportNoticeSeen === 'boolean') out.gameImportNoticeSeen = after.gameImportNoticeSeen
  const w = clampInt(after.width, 320, 7680)
  if (w !== undefined) out.width = w
  const h = clampInt(after.height, 240, 4320)
  if (h !== undefined) out.height = h
  if (typeof after.fullscreen === 'boolean') out.fullscreen = after.fullscreen
  return out
}

/** 读当前生效值（界面初始化用）。 */
export function getRuntimeSettings(): RuntimeSettings {
  const all = readAll()
  const out: RuntimeSettings = {}
  if (typeof all.lowMemoryMode === 'boolean') out.lowMemoryMode = all.lowMemoryMode
  const m = clampInt(all.memoryMb, 512, 32768)
  if (m !== undefined) out.memoryMb = m
  if (all.gcMode === 'template' || all.gcMode === 'tuned') out.gcMode = all.gcMode
  if (typeof all.memoryCleanupEnabled === 'boolean') out.memoryCleanupEnabled = all.memoryCleanupEnabled
  if (typeof all.memoryCleanupNoticeSeen === 'boolean') out.memoryCleanupNoticeSeen = all.memoryCleanupNoticeSeen
  if (typeof all.gameImportNoticeSeen === 'boolean') out.gameImportNoticeSeen = all.gameImportNoticeSeen
  const w = clampInt(all.width, 320, 7680)
  if (w !== undefined) out.width = w
  const h = clampInt(all.height, 240, 4320)
  if (h !== undefined) out.height = h
  if (typeof all.fullscreen === 'boolean') out.fullscreen = all.fullscreen
  return out
}

/**
 * 路径覆盖（游戏根目录 / 实例名）的**纯合并**：给自测直接断言"选择真的进了配置文件"，
 * 而不必去碰真实的玩家文件。
 *
 * 为什么路径也要走 settings.json（2026-09-18 运维要求"必须让玩家能自己选目录"）：
 * `config/` 是 electron-builder 的 extraResources —— 它在**安装目录**下、随包分发、
 * 更新时整体替换。往那里写玩家选择，就是本项目修过一次的发布级缺陷（见 index.ts 里
 * `overridesFile()` 的注释）：更新一次就被打回打包机的路径，而且 Program Files 下还写不进去。
 * 可写的用户配置只有一处：`%APPDATA%\<产品名>\settings.json`。
 */
export function mergePathOverride(
  current: Record<string, unknown>,
  patch: { gameRoot?: string; version?: string }
): Record<string, unknown> {
  const next = { ...current }
  const root = typeof patch.gameRoot === 'string' ? patch.gameRoot.trim() : ''
  if (root !== '') {
    const history = Array.isArray(current.gameRootHistory) ? current.gameRootHistory.filter((p): p is string => typeof p === 'string') : []
    next.gameRootHistory = [...new Set([root, ...(typeof current.gameRoot === 'string' ? [current.gameRoot] : []), ...history])].slice(0, 8)
    next.gameRoot = root
  }
  const version = typeof patch.version === 'string' ? patch.version.trim() : ''
  if (version !== '') next.version = version
  return next
}

/**
 * 落盘玩家选择的游戏目录并**回读**（与 setRuntimeSettings 同一纪律：返回文件里的真实值，
 * 而不是"我以为写进去的值"）。合并写：保留内存/分辨率/Java 等既有键。
 */
export function setPathOverride(patch: { gameRoot?: string; version?: string }): {
  gameRoot: string | null
  version: string | null
  file: string
} {
  const next = mergePathOverride(readAll(), patch)
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
  const after = readAll()
  return {
    gameRoot: typeof after.gameRoot === 'string' ? after.gameRoot : null,
    version: typeof after.version === 'string' ? after.version : null,
    file: settingsFile()
  }
}

/**
 * 清掉路径覆盖（回到出厂默认）。界面上的"恢复默认目录"用它——
 * 没有出口的"设置"会把玩家困在一个自己选错的目录上。
 */
export function clearPathOverride(): { file: string } {
  const current = readAll()
  delete current.gameRoot
  delete current.version
  writeFileSync(settingsFile(), JSON.stringify(current, null, 2), 'utf8')
  return { file: settingsFile() }
}
