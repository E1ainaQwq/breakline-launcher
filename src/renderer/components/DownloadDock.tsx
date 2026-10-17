import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import type { DownloadActivity, DownloadSpeed } from '../../shared/DownloadActivity'

/** Mounted once above page navigation, so progress stays visible when switching tabs. */
export default function DownloadDock(): React.JSX.Element {
  const [tasks, setTasks] = useState<Record<string, DownloadActivity>>({})
  const [speed, setSpeed] = useState<DownloadSpeed>({ activeTransfers: 0, bytesPerSecond: 0 })
  const receiveRetryFailure = (id: string, task: DownloadActivity, error: string): void => setTasks(previous => ({ ...previous, [id]: { ...task, phase: 'error', error } }))
  useEffect(() => window.delta.update.onDownloadSpeed(setSpeed), [])
  useEffect(() => {
    document.body.dataset.downloadActive = String(Object.keys(tasks).length > 0)
    return () => { delete document.body.dataset.downloadActive }
  }, [tasks])
  useEffect(() => {
    const expiry = new Map<string, ReturnType<typeof setTimeout>>()
    const receive = (task: DownloadActivity): void => {
      clearTimeout(expiry.get(task.id))
      expiry.delete(task.id)
      setTasks(previous => ({ ...previous, [task.id]: task }))
      if (task.phase === 'done') {
        expiry.set(task.id, setTimeout(() => {
          setTasks(previous => {
            const next = { ...previous }
            delete next[task.id]
            return next
          })
          expiry.delete(task.id)
        }, 3500))
      }
    }
    const offUpdate = window.delta.update.onProgress(p => receive({
      id: 'mods', title: '客户端模组',
      phase: p.phase === 'error' ? 'error' : p.phase === 'done' ? 'done' : 'working',
      percent: p.bytesTotal > 0 || p.phase === 'done' ? p.percent : null,
      current: p.current ?? (p.phase === 'applying' ? '安装文件' : '准备下载'),
      remaining: Math.max(0, p.totalFiles - p.doneFiles), error: p.phase === 'error' ? p.message : undefined
    }))
    const offJava = window.delta.config.onJavaProgress(p => receive({
      id: 'java', title: 'Java 运行环境',
      phase: p.phase === 'error' ? 'error' : p.phase === 'done' ? 'done' : 'working',
      percent: p.percent, current: p.message,
      remaining: p.phase === 'done' ? 0 : 1, error: p.phase === 'error' ? p.message : undefined
    }))
    const offSelf = window.delta.update.onSelfProgress(p => receive({
      id: 'launcher', title: '启动器更新', phase: 'working', percent: p.percent,
      current: p.percent >= 100 ? '安装并重启启动器' : '启动器程序', remaining: p.percent >= 100 ? 0 : 1
    }))
    const offResources = window.delta.update.onDownloadActivity(receive)
    return () => {
      offUpdate(); offJava(); offSelf(); offResources()
      expiry.forEach(clearTimeout)
    }
  }, [])

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex max-h-[55vh] w-[248px] flex-col gap-2 overflow-y-auto" aria-live="polite" aria-label="下载状态">
      <AnimatePresence initial={false}>
        {Object.values(tasks).map(task => (
          <motion.div key={task.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="panel-raised pointer-events-auto p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              {task.phase === 'working' ? <span className="download-spinner h-3.5 w-3.5 shrink-0 rounded-full border-2 border-delta-accent/20 border-t-delta-accent" /> : <span className={task.phase === 'error' ? 'text-delta-accent' : 'text-delta-ok'}>{task.phase === 'error' ? '!' : '✓'}</span>}
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              {task.phase !== 'working' && <button type="button" aria-label={`关闭${task.title}状态`} className="text-delta-muted" onClick={() => setTasks(previous => { const next = { ...previous }; delete next[task.id]; return next })}>×</button>}
            </div>
            <div role="progressbar" aria-label={task.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.percent ?? undefined} className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
              <motion.div animate={{ width: task.percent === null ? '35%' : `${Math.min(100, Math.max(0, task.percent))}%` }} className={`h-full rounded-full bg-delta-accent ${task.percent === null ? 'download-indeterminate' : ''}`} />
            </div>
            <div className="mt-2 break-words text-[11px] text-delta-muted" title={task.current}>当前：{task.phase === 'done' ? '已完成' : task.current}</div>
            <div className="mt-0.5 text-[11px] text-delta-muted">{task.remaining === undefined ? '剩余：正在计算' : `剩余：${task.remaining} 项`}</div>
            {task.phase === 'error' && <div className="mt-2 text-[11px] text-delta-accent"><div className="break-words">{task.error ?? '下载暂未完成，进度已保留'}</div><button className="mt-2 rounded bg-delta-accent px-3 py-1.5 font-semibold text-black" onClick={() => {
              setTasks(previous => ({ ...previous, [task.id]: { ...task, phase: 'working', current: '正在继续已有进度…' } }))
              const retry = task.id === 'launcher' ? window.delta.update.selfApply() : window.delta.config.repair()
              void retry.then(result => { if (!result.ok) receiveRetryFailure(task.id, task, 'remaining' in result ? result.remaining.join('；') : result.error ?? '暂未完成，请稍后再试') }).catch(error => receiveRetryFailure(task.id, task, String(error)))
            }}>继续下载</button></div>}
          </motion.div>
        ))}
      </AnimatePresence>
      {Object.values(tasks).some(task => task.phase === 'working') && <div className="panel px-3 py-2 text-[11px] text-delta-muted" aria-live="off">
        {speed.activeTransfers ? `实时下载：${speed.bytesPerSecond >= 1048576 ? (speed.bytesPerSecond / 1048576).toFixed(1) + ' MB/s' : Math.round(speed.bytesPerSecond / 1024) + ' KB/s'}` : '正在连接、校验或安装文件…'}
      </div>}
    </div>, document.body
  )
}
