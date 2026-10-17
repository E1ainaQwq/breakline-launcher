/** Read-only progress events; they never authorize downloads or filesystem writes. */
export type DownloadActivity = {
  id: string
  title: string
  phase: 'working' | 'done' | 'error'
  percent: number | null
  current: string
  remaining?: number
  error?: string
}

export type DownloadSpeed = { bytesPerSecond: number; activeTransfers: number }
