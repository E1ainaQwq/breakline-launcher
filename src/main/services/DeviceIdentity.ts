import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
export type DevicePayload = { version: 1; signals: { kind: 'hardware' | 'install'; hash: string }[] }
export type DeviceResult = { environment: 'physical' | 'virtual' | 'unavailable'; device?: DevicePayload; detail: string }
export type DeviceRaw = { vendor?: string; model?: string; hardware?: string; install?: string; environmentRead?: boolean }

/** HypervisorPresent alone also describes physical hosts running VBS/WSL. */
export function isVirtualGuest(vendor = '', model = ''): boolean {
  const value = `${vendor} ${model}`.toLowerCase()
  return /vmware|virtualbox|innotek|qemu|\bkvm\b|\bxen\b|bochs|parallels|bhyve|openstack|amazon ec2|google compute engine|apple virtualization/.test(value)
    || /microsoft corporation\s+virtual machine/.test(value)
    || /(^|\s)virtual machine($|\s)/.test(model.toLowerCase())
}

function uniqueId(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase().replace(/[{}-]/g, '')
  // Reject OEM placeholders, zero UUIDs and non-unique descriptive strings.
  if (!/^[0-9a-f]{32}$/.test(value) || /^0+$|^f+$/.test(value)) return null
  return value
}

export function normalizeIdentity(raw: DeviceRaw, platform: string): DeviceResult {
  if (!raw.environmentRead || !raw.vendor?.trim() || !raw.model?.trim()) {
    return { environment: 'unavailable', detail: '无法读取启动环境，检查未完成；这不是作弊判定' }
  }
  if (isVirtualGuest(raw.vendor, raw.model)) return { environment: 'virtual', detail: '已识别虚拟机来宾环境，服务器不允许启动' }
  const signals: DevicePayload['signals'] = []
  for (const kind of ['hardware', 'install'] as const) {
    const id = uniqueId(raw[kind])
    if (id) signals.push({ kind, hash: createHash('sha256').update(`MugenAC/device/v1/${kind}/${kind === 'install' ? platform + '/' : ''}${id}`).digest('hex') })
  }
  if (!signals.length) return { environment: 'unavailable', detail: '未能读取稳定设备标识，请检查系统权限后重试' }
  return { environment: 'physical', device: { version: 1, signals }, detail: '已读取稳定设备标识；原始标识不会上传' }
}

async function readOptional(file: string): Promise<string> {
  try { const data = await readFile(file, 'utf8'); return data.length <= 512 ? data.trim() : '' } catch { return '' }
}

async function collectRaw(): Promise<DeviceRaw> {
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $c=Get-CimInstance -Namespace 'root\\cimv2' -ClassName Win32_ComputerSystem -OperationTimeoutSec 3; $p=$null; try { $p=Get-CimInstance -Namespace 'root\\cimv2' -ClassName Win32_ComputerSystemProduct -OperationTimeoutSec 3 } catch {}; $g=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction SilentlyContinue).MachineGuid; [ordered]@{vendor=$c.Manufacturer;model=$c.Model;hardware=$p.UUID;install=$g;environmentRead=$true}|ConvertTo-Json -Compress`
    const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await run(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024, encoding: 'utf8' })
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as DeviceRaw
  }
  if (process.platform === 'linux') {
    const [vendor, model, hardware, install] = await Promise.all([
      readOptional('/sys/class/dmi/id/sys_vendor'), readOptional('/sys/class/dmi/id/product_name'),
      readOptional('/sys/class/dmi/id/product_uuid'), readOptional('/etc/machine-id')
    ])
    return { vendor, model, hardware, install: install || await readOptional('/var/lib/dbus/machine-id'), environmentRead: !!vendor && !!model }
  }
  if (process.platform === 'darwin') {
    const [platform, model] = await Promise.all([
      run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000, maxBuffer: 32 * 1024, encoding: 'utf8' }),
      run('/usr/sbin/sysctl', ['-n', 'hw.model'], { timeout: 5000, maxBuffer: 1024, encoding: 'utf8' })
    ])
    const hardware = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(platform.stdout)?.[1]
    return { vendor: 'Apple', model: model.stdout.trim(), hardware, environmentRead: true }
  }
  return {}
}

/** One bounded read per launcher process; renewals reuse it without spawning scripts in-game. */
export class DeviceIdentity {
  private pending: Promise<DeviceResult> | null = null
  constructor(private readonly reader: () => Promise<DeviceRaw> = collectRaw, private readonly platform = process.platform) {}
  collect(): Promise<DeviceResult> {
    if (!this.pending) this.pending = this.reader().then(raw => normalizeIdentity(raw, this.platform)).catch((error: { code?: string; killed?: boolean; stderr?: string }) => ({ environment: 'unavailable', detail: /8004100e/i.test(error.stderr ?? '') ? 'Windows 设备信息服务（WMI）缺失或损坏，需要先修复 Windows 系统组件；这不是作弊判定' : error.code === 'ENOENT' ? 'Windows PowerShell 组件缺失，无法完成设备检查，请恢复系统组件后重试' : error.killed ? 'Windows 设备信息读取超时，请重启电脑后再试；这不是作弊判定' : 'Windows 设备信息暂时无法读取，请重启电脑后再试；这不是作弊判定' } as DeviceResult)).then(result => {
      if (result.environment === 'unavailable') this.pending = null
      return result
    })
    return this.pending
  }
}
