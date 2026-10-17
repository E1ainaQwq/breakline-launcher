import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AcTask } from '../../shared/AcMonitor'

const run = promisify(execFile)
export function parseCaptureTicket(ticket: string, name: string, now = Date.now()): { nonce: string; reason: string } {
  const m = /^shot1\|([0-9a-f]{32})\|([A-Za-z0-9_]{1,16})\|(routine|report|manual)\|[A-Za-z0-9_-]{1,64}\|([0-9]{1,12})\|[0-9a-f]{64}$/.exec(ticket)
  if (!m || m[2].toLowerCase() !== name.toLowerCase() || Number(m[4]) * 1000 < now || Number(m[4]) * 1000 > now + 120_000) throw new Error('取证请求无效或已过期')
  return { nonce: m[1], reason: m[3] }
}

/** Own game window only. Enumerates names with zero thumbnails; captures one PID-verified source. */
export async function captureGameWindow(pid: number): Promise<Buffer> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('游戏进程不可用')
  if (process.platform !== 'win32' && (process.platform !== 'linux' || process.env.XDG_SESSION_TYPE === 'wayland')) throw new Error('当前平台无法验证游戏窗口归属')
  const { app, desktopCapturer, BrowserWindow } = await import('electron')
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
  let sourceId = ''
  let ownedWindows = new Set<string>()
  if (process.platform === 'win32') {
    const handles = sources.map(source => /^window:([0-9]+):[0-9]+$/.exec(source.id)?.[1]).filter(Boolean).slice(0, 256)
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MugenWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }'; foreach($gameHandle in @(${handles.join(',')})){ [uint32]$gameOwner=0; [void][MugenWindow]::GetWindowThreadProcessId([IntPtr]$gameHandle,[ref]$gameOwner); if($gameOwner -eq ${pid} -and -not [MugenWindow]::IsIconic([IntPtr]$gameHandle)){ $gameHandle } }`
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 4000, maxBuffer: 4096 })
    ownedWindows = new Set(result.stdout.trim().split(/\s+/))
  }
  for (const source of sources) {
    const id = /^window:([0-9]+):[0-9]+$/.exec(source.id)?.[1]
    if (!id) continue
    let owner = 0
    if (process.platform === 'win32') {
      if (ownedWindows.has(id)) owner = pid
    } else {
      if (!/Minecraft|Breakline|断界行动/i.test(source.name)) continue
      const result = await run('xprop', ['-id', id, '_NET_WM_PID'], { timeout: 3000, maxBuffer: 4096 })
      owner = Number(/=\s*([0-9]+)/.exec(result.stdout)?.[1])
    }
    if (owner === pid) { sourceId = source.id; break }
  }
  if (!sourceId) throw new Error('未找到可采集的游戏窗口；不会回退截取桌面')
  const window = new BrowserWindow({ show: false, width: 16, height: 16, skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: 'mugen-capture-' + pid } })
  const directory = mkdtempSync(join(app.getPath('temp'), 'mugen-window-capture-'))
  const page = join(directory, 'capture.html')
  writeFileSync(page, '<!doctype html><html><body></body></html>', { mode: 0o600 })
  try {
    const captureTimer = setTimeout(() => { if (!window.isDestroyed()) window.destroy() }, 10_000)
    window.once('closed', () => clearTimeout(captureTimer))
    await window.loadFile(page)
    const result = await window.webContents.executeJavaScript(`(async()=>{
      let stream;
      try {
        stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(sourceId)},maxWidth:1280,maxHeight:720}}});
        const video=document.createElement('video');video.muted=true;video.srcObject=stream;await video.play();
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('capture timeout')),5000);video.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve()})});
        const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
        if(canvas.width<16||canvas.height<16||canvas.width>1920||canvas.height>1080)throw new Error('invalid frame');
        const context=canvas.getContext('2d');context.drawImage(video,0,0);
        const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
        let min=255,max=0;for(let i=0;i<pixels.length;i+=64){min=Math.min(min,pixels[i],pixels[i+1],pixels[i+2]);max=Math.max(max,pixels[i],pixels[i+1],pixels[i+2])}
        if(max-min<3)throw new Error('游戏窗口没有有效画面');return canvas.toDataURL('image/png');
      } finally { if(stream)stream.getTracks().forEach(track=>track.stop()) }
    })()`)
    if (typeof result !== 'string' || result.length > 3 * 1024 * 1024 || !result.startsWith('data:image/png;base64,')) throw new Error('游戏画面采集失败')
    const bytes = Buffer.from(result.slice(22), 'base64')
    if (bytes.length > 2 * 1024 * 1024) throw new Error('游戏画面超过上传上限')
    return bytes
  } finally { if (!window.isDestroyed()) window.destroy(); unlinkSync(page); rmdirSync(directory) }
}

export class LauncherCapture {
  private task: AcTask = { id: 'launcherCapture', label: '启动器窗口取证', state: 'waiting', detail: '等待游戏启动' }
  private pending = false
  private lastAttempt = 0
  private lastNonce = ''
  private generation = 0
  constructor(private readonly capture = captureGameWindow) {}
  reset(allowed: boolean): void { this.generation++; this.task = { id: 'launcherCapture', label: '启动器窗口取证', state: allowed ? 'waiting' : 'disabled', detail: allowed ? '已授权，等待服务端取证请求' : '未单独授权，不采集游戏窗口' }; this.lastNonce = ''; this.lastAttempt = 0 }
  snapshot(): AcTask { return { ...this.task } }
  async request(ticket: string, name: string, pid: number | undefined, allowed: boolean, upload: (ticket: string, bytes: Buffer) => Promise<{ requestId: string; sha256: string }>): Promise<void> {
    if (!allowed) { this.reset(false); return }
    const request = parseCaptureTicket(ticket, name)
    if (!pid || this.pending || request.nonce === this.lastNonce || Date.now() - this.lastAttempt < 30_000) return
    this.pending = true; this.lastAttempt = Date.now(); this.lastNonce = request.nonce
    const generation = this.generation
    this.task = { ...this.task, state: 'working', detail: `${request.reason === 'report' ? '举报' : request.reason === 'routine' ? '例行' : '人工'}取证：采集游戏窗口` }
    try {
      const bytes = await this.capture(pid)
      if (generation !== this.generation) return
      // Revocation or process exit between capture and upload must cancel transmission.
      this.task = { ...this.task, state: 'working', detail: '正在上传游戏窗口截图' }
      const receipt = await upload(ticket, bytes)
      if (receipt.requestId !== request.nonce || receipt.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('截图保存回执不匹配')
      if (generation === this.generation) this.task = { ...this.task, state: 'ok', detail: '服务端数据库已确认保存游戏窗口截图' }
    } catch (error) {
      if (generation === this.generation) this.task = { ...this.task, state: error instanceof Error && error.message.includes('平台') ? 'unsupported' : 'error', detail: error instanceof Error ? error.message : '窗口取证失败' }
    } finally { this.pending = false }
  }
}
