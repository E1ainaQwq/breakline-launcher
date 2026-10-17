import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type CleanupResult = { status: 'success' | 'cancelled' | 'failed'; message: string }
export const TRUSTED_MEMORY_CLEANUP_HELPER_SHA256 = '7ADFA369C5101378D4BAA82566D5EEE6D62E14C00B8DB32B32066EBE90202277'

type ElevatedRunner = (helperPath: string) => Promise<number>
type CleanupDependencies = {
  runner?: ElevatedRunner
  readBytes?: (helperPath: string) => Buffer
  expectedSha256?: string
}

/** Fixed invocation only: the helper path is base64 data inside a constant PowerShell program. */
export function runFixedElevatedHelper(helperPath: string): Promise<number> {
  const pathData = Buffer.from(helperPath, 'utf16le').toString('base64')
  const script = `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${pathData}'));try{$r=Start-Process -FilePath $p -Verb RunAs -Wait -PassThru;exit $r.ExitCode}catch{if($_.Exception.NativeErrorCode -eq 1223){exit 1223};exit 1}`
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 120_000 }, error => {
        if (!error) return resolve(0)
        const code = typeof error.code === 'number' ? error.code : 1
        if (code === 1223) return resolve(1223)
        if (code !== 1) return resolve(code)
        reject(error)
      })
  })
}

export async function runMemoryCleanup(helperPath: string, dependencies: CleanupDependencies = {}): Promise<CleanupResult> {
  let helperBytes: Buffer
  try {
    helperBytes = (dependencies.readBytes ?? readFileSync)(helperPath)
  } catch (error) {
    return { status: 'failed', message: `内存回收 helper 无法读取，已拒绝提权；启动器将继续正常启动游戏：${error instanceof Error ? error.message : String(error)}` }
  }
  const actualHash = createHash('sha256').update(helperBytes).digest('hex').toUpperCase()
  const expectedHash = (dependencies.expectedSha256 ?? TRUSTED_MEMORY_CLEANUP_HELPER_SHA256).toUpperCase()
  if (actualHash !== expectedHash) {
    return { status: 'failed', message: '内存回收 helper 完整性校验失败，已拒绝提权；启动器将继续正常启动游戏。' }
  }
  try {
    const code = await (dependencies.runner ?? runFixedElevatedHelper)(helperPath)
    if (code === 0) return { status: 'success', message: '启动前内存回收已完成。' }
    if (code === 1223) return { status: 'cancelled', message: '你取消了管理员授权；启动器将继续正常启动游戏。' }
    if (code === 20) return { status: 'failed', message: '工作集清理失败；启动器将继续正常启动游戏。' }
    if (code === 21) return { status: 'failed', message: '已清理工作集，但刷新修改页失败；启动器将继续正常启动游戏。' }
    if (code === 22) return { status: 'failed', message: '系统拒绝了两项内存回收操作；启动器将继续正常启动游戏。' }
    return { status: 'failed', message: `内存回收未完成（代码 ${code}）；启动器将继续正常启动游戏。` }
  } catch (error) {
    return { status: 'failed', message: `无法运行内存回收 helper：${error instanceof Error ? error.message : String(error)}；启动器将继续正常启动游戏。` }
  }
}

/** Injected runner keeps self-tests from invoking UAC or changing machine memory. */
export async function runMemoryCleanupSelfTest(trustedHelperPath: string): Promise<number> {
  const bytes = readFileSync(trustedHelperPath)
  const fixtureHash = createHash('sha256').update(bytes).digest('hex').toUpperCase()
  let elevatedCalls = 0
  const checks: Array<[string, () => Promise<boolean>]> = [
    ['verified helper reaches injected launcher', async () => (await runMemoryCleanup(trustedHelperPath, {
      readBytes: () => bytes, expectedSha256: fixtureHash, runner: async () => { elevatedCalls++; return 0 }
    })).status === 'success' && elevatedCalls === 1],
    ['cancel continues', async () => (await runMemoryCleanup(trustedHelperPath, {
      readBytes: () => bytes, expectedSha256: fixtureHash, runner: async () => 1223
    })).status === 'cancelled'],
    ['native failure continues', async () => (await runMemoryCleanup(trustedHelperPath, {
      readBytes: () => bytes, expectedSha256: fixtureHash, runner: async () => 22
    })).status === 'failed'],
    ['exception continues', async () => (await runMemoryCleanup(trustedHelperPath, {
      readBytes: () => bytes, expectedSha256: fixtureHash, runner: async () => { throw new Error('denied') }
    })).status === 'failed'],
    ['bad helper never requests elevation', async () => {
      elevatedCalls = 0
      const result = await runMemoryCleanup(trustedHelperPath, {
        readBytes: () => Buffer.from('tampered helper'),
        runner: async () => { elevatedCalls++; return 0 }
      })
      return result.status === 'failed' && result.message.includes('完整性校验失败') && elevatedCalls === 0
    }]
  ]
  for (const [name, check] of checks) {
    if (!(await check())) throw new Error(`Memory cleanup self-test failed: ${name}`)
  }
  return checks.length
}
