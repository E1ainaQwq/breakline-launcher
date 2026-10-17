import { contextBridge, ipcRenderer } from 'electron'

/**
 * 「反作弊启动中」浮层的 preload —— **刻意只暴露两个方法**。
 *
 * 纪律与主 preload 一样：只暴露具体方法，绝不把 `ipcRenderer` 交给渲染层。
 * 这块窗口是"贴在整个屏幕右下角的浮层"，比启动器主界面**更**不该有能力：
 * 它拿不到 `window.delta`（没有 launch / config / player 任何一条通道），
 * 于是即使这块窗口被注入，也做不了任何事 —— 它只能报告"我播到第几秒了"。
 */
contextBridge.exposeInMainWorld('deltaAnim', {
  /**
   * 报告时间轴进度。主进程按它把"读条是否真的在走"记进日志
   * （窗口是被主进程按固定时长关掉的，这里的报告**不**能延长窗口寿命）。
   */
  signal: (payload: string) => ipcRenderer.send('anim:signal', payload)
})
