export type LaunchCheck = {
  key: string
  title: string
  status: 'waiting' | 'working' | 'ready' | 'error'
  message: string
  repairable?: boolean
}

export type LaunchPreparation = {
  running: boolean
  startedAt: number
  checks: LaunchCheck[]
}
