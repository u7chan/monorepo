import { z } from 'zod'

export const SystemStatusReasonSchema = z.enum([
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
])
export const SYSTEM_STATUS_REASONS = SystemStatusReasonSchema.options
export type SystemStatusReason = z.infer<typeof SystemStatusReasonSchema>

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

const systemCheckStatusSchema = z.enum(['ok', 'error', 'not-configured'])
const publicSystemCheckSchema = z.object({
  status: systemCheckStatusSchema,
  reason: SystemStatusReasonSchema,
  checkedAt: z.string(),
})
const publicDatabaseSystemStatusSchema = publicSystemCheckSchema.extend({
  connection: publicSystemCheckSchema,
  schema: publicSystemCheckSchema,
})
const publicFileServerApiSystemStatusSchema = publicSystemCheckSchema.extend({
  login: publicSystemCheckSchema,
  read: publicSystemCheckSchema,
})

export const PublicSystemStatusSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checkedAt: z.string(),
  checks: z.object({
    database: publicDatabaseSystemStatusSchema,
    fileServerHealth: publicSystemCheckSchema,
    fileServerApi: publicFileServerApiSystemStatusSchema,
    fileServerPublic: publicSystemCheckSchema,
  }),
})

export type PublicSystemCheck = z.infer<typeof publicSystemCheckSchema>
export type PublicDatabaseSystemStatus = z.infer<typeof publicDatabaseSystemStatusSchema>
export type PublicFileServerApiSystemStatus = z.infer<typeof publicFileServerApiSystemStatusSchema>
export type PublicSystemStatus = z.infer<typeof PublicSystemStatusSchema>
