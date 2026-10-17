import type { AcMonitorSnapshot, AcTask, AcTaskState } from '../../shared/AcMonitor'

/** Only tracks receipts already produced by this launch; never starts a scan. */
export class AcMonitor {
  private events = new Map<string, AcTask>()
  private pack: { ok: boolean; antiCheat: boolean; expected: number } | null = null
  private running = false
  private lastReceiptAt = 0
  private exited = false

  recordPack(pack: { ok: boolean; antiCheat: boolean; expected: number }): void { this.pack = pack }
  recordState(state: string): void {
    if (state === 'starting') { this.events.clear(); this.lastReceiptAt = 0; this.exited = false }
    this.running = state === 'running'
    if (state === 'exited' || state === 'idle') { this.events.clear(); this.lastReceiptAt = 0; this.exited = state === 'exited' }
  }

  receive(frame: string): boolean {
    if (!this.running || frame.length > 4096) return false
    const lines = frame.trim().split('\n')
    if (lines.shift() !== 'MUGEN1' || lines.length !== 10) return false
    const labels: Record<string, string> = { client: '客户端模块', guard: '检测守卫', scan: '检测运行', processes: '进程列表', drivers: '驱动清单', modules: '模块清单', jvm: 'JVM 参数', report: '服务端回传', screenshot: '截图取证', device: '设备标识' }
    const notes: Record<string, string> = { channel: '反作弊通道注册失败', loaded: '客户端模块已加载', assembly: '等待守卫装配', assembled: '守卫已装配', scan_fault: '本轮检测失败', scanning: '正在执行检测', checked: '检查已执行', first_scan: '等待首次检查', disabled: '实际配置已关闭', unsupported: '当前平台不支持此采集', error: '采集失败，请查看游戏日志', waiting: '等待本轮采集', baseline: '模块已采集，正在建立基线', consent: '未授权，本判据未执行', send_failed: '客户端发送失败', ack_timeout: '已发送，超过 30 秒未收到服务端回执', received: '服务端已确认接收', server_ack: '等待服务端接收回执', capture_source: '游戏画面采集源不可用', captured: '已采集，等待上传回执', frame_received: '服务端已确认截图落盘', capture_trigger: '已启用，等待取证触发', capture_failed: '最近一次取证失败' }
    const incoming = new Map<string, AcTask>()
    for (const line of lines) {
      const match = /^([a-z]+) (ok|waiting|error|unknown|disabled|unsupported|working) ([a-z_]+) ([0-9]{1,10})$/.exec(line)
      if (!match) return false
      const [, id, state, code, raw] = match
      const count = Number(raw)
      if (!labels[id] || !notes[code] || incoming.has(id) || count > 1_000_000_000) return false
      const suffix = code === 'checked' && id === 'scan' ? ` · ${count} 项` : code === 'received' ? ` · 第 ${count} 轮` : ['captured', 'frame_received'].includes(code) ? ` · ${count} 帧` : ''
      incoming.set(id, { id, label: labels[id], state: state as AcTaskState, detail: notes[code] + suffix })
    }
    this.events = incoming
    this.lastReceiptAt = Date.now()
    return true
  }
  observe(line: string): void {
    if (this.lastReceiptAt > 0) return
    if (!this.running || !line.includes('[deltaac/client]')) return
    const set = (id: string, label: string, state: AcTaskState, detail: string): void => {
      this.events.set(id, { id, label, state, detail })
    }
    if (/DIAG-REGISTER ok|已加载：探针应答/.test(line)) set('client', '客户端模块', 'ok', '已收到加载回执')
    if (/已在主菜单阶段装配守卫|guard=已装配/.test(line)) set('guard', '检测守卫', 'ok', '已收到装配回执')
    if (/装配失败|通道注册失败/.test(line)) set('guard', '检测守卫', 'error', '装配或通道异常，请查看游戏日志')
    if (/客户端检测 tick 异常|后台扫描异常|后台扫描遇到链接错误/.test(line)) set('scan', '检测运行', 'error', '本次检测异常，请查看游戏日志')
    if (/模块基线已定稿/.test(line)) set('modules', '模块清单', 'ok', '本次会话已建立模块基线')
    if (/模块检查记为采集故障/.test(line)) set('modules', '模块清单', 'error', '模块采集故障')
    if (/上报失败|截图分块发送失败/.test(line)) set('report', '服务端回传', 'error', '客户端回传失败')
  }

  snapshot(accepted: boolean, session: string, lease: { requested: boolean; failed: boolean } | null): AcMonitorSnapshot {
    const tasks: AcTask[] = [
      { id: 'terms', label: '条款确认', state: accepted ? 'ok' : 'waiting', detail: accepted ? '当前版本已确认' : '等待确认当前条款' },
      { id: 'account', label: '玩家身份', state: session === 'ok' ? 'ok' : session === 'none' ? 'waiting' : 'error', detail: session === 'ok' ? '会话验证通过' : session === 'none' ? '等待登录' : '身份验证未通过' },
      { id: 'pack', label: '客户端完整性', state: !this.pack?.expected ? 'waiting' : this.pack.ok ? 'ok' : 'error', detail: !this.pack?.expected ? '尚未完成文件校验' : this.pack.ok ? '文件与权威清单一致' : '请更新或修复客户端' },
      { id: 'acfile', label: '反作弊文件', state: !this.pack?.expected ? 'waiting' : this.pack.antiCheat ? 'ok' : 'error', detail: this.pack?.antiCheat ? '文件校验通过' : '等待有效客户端文件' },
      { id: 'lease', label: '启动凭证与续签', state: lease?.failed ? 'error' : lease?.requested ? 'ok' : 'waiting', detail: lease?.failed ? '凭证续签暂不可用' : lease?.requested ? '已收到客户端凭证请求' : '等待游戏连接验证服务' },
      ...[
        ['client', '客户端模块'], ['guard', '检测守卫'], ['scan', '检测运行'],
        ['processes', '进程列表'], ['drivers', '驱动清单'], ['modules', '模块清单'],
        ['jvm', 'JVM 参数'], ['report', '服务端回传'], ['screenshot', '截图取证'], ['device', '设备标识']
      ].map(([id, label]): AcTask => this.lastReceiptAt > 0 && Date.now() - this.lastReceiptAt > 20_000 ? {
        id, label, state: 'unknown', detail: '超过 20 秒未收到客户端状态，等待恢复'
      } : this.events.get(id) ?? {
        id, label, state: this.running ? 'unknown' : 'waiting',
        detail: this.running ? '尚无本次会话的单项回执' : this.exited ? '游戏已退出' : '等待游戏启动'
      })
    ]
    const status = tasks.some(t => t.state === 'error') ? 'error'
      : this.running && this.lastReceiptAt > 0 && Date.now() - this.lastReceiptAt <= 20_000 && this.events.get('guard')?.state === 'ok' ? 'running'
        : tasks.slice(0, 4).every(t => t.state === 'ok') ? 'ready' : 'idle'
    return { status, updatedAt: Date.now(), tasks }
  }
}
