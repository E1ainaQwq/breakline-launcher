import { useEffect, useRef, useState } from 'react'

export default function GameImportNotice({ onDismiss, onImported, onInstall }: { onDismiss: () => void; onImported: () => Promise<void>; onInstall: () => void }): React.JSX.Element {
  const [seconds, setSeconds] = useState(5)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const closed = useRef(false)
  const dismiss = (): void => { if (!closed.current) { closed.current = true; onDismiss() } }
  useEffect(() => {
    if (busy) return
    if (seconds <= 0) { dismiss(); return }
    const timer = setTimeout(() => setSeconds(value => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [seconds, busy])
  const importGame = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.delta.config.pick(true)
      if (result.ok && !result.canceled) {
        await onImported()
        setMessage('已记住游戏位置。回到首页点击主按钮，会自动检查并补齐缺少的文件。')
      } else if (!result.canceled) setMessage(result.notes?.join('；') || '没有识别到游戏目录，请选择解压后的游戏文件夹。')
    } catch { setMessage('暂时没有打开文件夹选择窗口，请再点一次“一键导入”。') }
    finally { setSeconds(5); setBusy(false) }
  }
  return <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-5" role="dialog" aria-modal="true" aria-label="导入已有游戏包">
    <div className="panel-raised dialog-surface w-full max-w-lg p-6">
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">已经有游戏包？</h2><span className="text-xs text-delta-muted">{busy ? '选择时暂停计时' : `${seconds} 秒后自动关闭`}</span></div>
      <p className="mt-3 text-sm leading-relaxed">不用再下载一次，点击“一键导入”，选择你解压好的游戏文件夹。</p>
      <ol className="mt-3 list-inside list-decimal space-y-2 text-xs text-delta-muted">
        <li>选择包含 game、.minecraft 或 versions 的文件夹。</li>
        <li>选到 mods 或具体游戏版本也没关系，启动器会识别。</li>
        <li>导入后点击首页主按钮，缺少的内容会自动补齐。</li>
      </ol>
      {message && <p className="mt-3 text-sm text-delta-accent" role="status">{message}</p>}
      <div className="mt-5 flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => void importGame()} className="rounded-lg bg-delta-accent px-5 py-2 text-sm font-semibold text-black disabled:opacity-50">{busy ? '正在识别…' : '一键导入'}</button>
        <button disabled={busy} onClick={() => { dismiss(); onInstall() }} className="rounded-lg border border-delta-accent/30 px-4 py-2 text-sm">没有，自动安装</button>
        <button disabled={busy} onClick={dismiss} className="px-2 text-xs text-delta-muted">稍后再说</button>
      </div>
      <p className="mt-3 text-[11px] text-delta-muted">关闭后也可以在首页点击“导入已有游戏包”。</p>
    </div>
  </div>
}
