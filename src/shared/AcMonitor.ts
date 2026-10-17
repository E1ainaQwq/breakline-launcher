export type AcTaskState = 'ok' | 'waiting' | 'error' | 'unknown' | 'disabled' | 'unsupported' | 'working'
export type AcTask = { id: string; label: string; state: AcTaskState; detail: string }
export type AcMonitorSnapshot = {
  status: 'idle' | 'ready' | 'running' | 'error'
  updatedAt: number
  tasks: AcTask[]
}
