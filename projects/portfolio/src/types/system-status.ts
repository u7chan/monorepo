export const SYSTEM_STATUS_REASONS = [
  'ok',
  'not-configured',
  'timeout',
  'connection-failed',
  'schema-check-failed',
  'database-unavailable',
  'healthz-unavailable',
  'login-failed',
  'read-failed',
  'file-server-api-unavailable',
  'public-unavailable',
  'check-failed',
] as const

export type SystemStatusReason = (typeof SYSTEM_STATUS_REASONS)[number]

export type SystemCheckStatus = 'ok' | 'error' | 'not-configured'

export interface SystemCheck {
  status: SystemCheckStatus
  reason: SystemStatusReason
  checkedAt: string
}

export interface DatabaseSystemStatus extends SystemCheck {
  connection: SystemCheck
  schema: SystemCheck
}

export interface FileServerApiSystemStatus extends SystemCheck {
  login: SystemCheck
  read: SystemCheck
}

export interface SystemStatus {
  status: 'ok' | 'degraded'
  checkedAt: string
  checks: {
    database: DatabaseSystemStatus
    fileServerHealth: SystemCheck
    fileServerApi: FileServerApiSystemStatus
    fileServerPublic: SystemCheck
  }
}
