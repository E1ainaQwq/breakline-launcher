import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import type { AcMonitorSnapshot, AcTask } from '../../shared/AcMonitor'

const lights = { idle: 'bg-slate-400', ready: 'bg-amber-500', running: 'bg-delta-ok', error: 'bg-red-500' }
const labels = { idle: '等待验证', ready: '启动验证通过，等待客户端回执', running: '客户端状态回传正常', error: '有项目需要处理' }
const taskLabels = { ok: '已完成', waiting: '等待', error: '异常', unknown: '暂无回执', disabled: '已关闭', unsupported: '不支持', working: '运行中' }

export default function AcMonitorCard({ image }: { image?: string }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AcMonitorSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const next = await window.delta.anticheat.status()
        if (alive) { setSnapshot(next); setError(false) }
      } catch { if (alive) setError(true) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
      if (event.key === 'Tab') {
        const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button, summary, [tabindex="0"]') ?? [])]
        const first = focusable[0], last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [open])
  const state = error ? 'error' : snapshot?.status ?? 'idle'
  const rows = (tasks: AcTask[]): React.JSX.Element => <div className="mt-2 space-y-1.5">{tasks.map(task => (
    <div key={task.id} className="flex items-center gap-3 rounded-lg border border-delta-line/50 px-3 py-2">
      <div className="min-w-0 flex-1"><div className="text-xs font-medium">{task.label}</div><div className="mt-1 text-[11px] text-delta-muted">{task.detail}</div></div>
      <span className={`shrink-0 text-[11px] ${task.state === 'ok' ? 'text-delta-ok' : task.state === 'error' ? 'text-red-600' : 'text-delta-muted'}`}>{taskLabels[task.state]}</span>
    </div>
  ))}</div>
  const tasks = snapshot?.tasks ?? []
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label="打开 Mugen AC 事务监测" className={`panel w-full overflow-hidden text-left transition hover:border-delta-accent/40 ${image ? '' : 'px-3 py-2'}`}>
      {image && <img src={image} alt="" className="h-20 w-full object-cover" />}
      <div className={`flex items-center gap-2 ${image ? 'px-3 py-2.5' : ''}`}>
        <span className="text-sm font-semibold">Mugen AC</span>
        <span role="status" aria-label={error ? '监测暂不可用' : labels[state]} title={error ? '监测暂不可用' : labels[state]} className={`h-2 w-2 rounded-full ${lights[state]}`} />
      </div>
    </button>
    {createPortal(<AnimatePresence>{open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/15 p-5" onClick={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <motion.div ref={dialog} role="dialog" aria-modal="true" aria-label="Mugen AC 事务监测" initial={{ y: 12, scale: .98 }} animate={{ y: 0, scale: 1 }} className="panel-raised dialog-surface max-h-[82vh] w-full max-w-3xl overflow-y-auto p-5">
        <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">Mugen AC</h2><span className={`h-2 w-2 rounded-full ${lights[state]}`} /><button type="button" onClick={() => setOpen(false)} className="ml-auto rounded-lg border border-delta-line px-3 py-1.5 text-xs">关闭</button></div>
        <p className="mt-1 text-xs text-delta-muted">{error ? '暂时无法读取监测状态，请稍后重试' : labels[state]}</p>
        <div className="mt-4 grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          <section><h3 className="text-xs font-semibold">启动验证</h3>{rows(tasks.slice(0, 5))}</section>
          <section><h3 className="text-xs font-semibold">运行监测</h3>{rows(tasks.filter(task => ['client', 'guard', 'scan', 'report'].includes(task.id)))}</section>
        </div>
        <details className="mt-4 rounded-xl border border-delta-line p-3"><summary className="cursor-pointer text-xs font-semibold">采集项目</summary>{rows(tasks.filter(task => ['processes', 'drivers', 'modules', 'jvm', 'screenshot', 'launcherCapture', 'device', 'environment'].includes(task.id)))}<p className="mt-3 text-[11px] text-delta-muted">各项显示实际检查结果；暂无回执不代表已关闭或正常。</p></details>
      </motion.div>
    </motion.div>}</AnimatePresence>, document.body)}
  </>
}
