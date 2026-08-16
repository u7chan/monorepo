export type SystemCheckStatus = 'ok' | 'error' | 'not-configured'

export interface SystemCheck {
  status: SystemCheckStatus
  reason: string
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
