import pino from 'pino'
import type { TransportTargetOptions } from 'pino'

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug')
const logFile = process.env.LOG_FILE
const isDev = process.env.NODE_ENV !== 'production'

function buildTransport() {
  const targets: TransportTargetOptions[] = []

  if (isDev) {
    targets.push({
      level,
      target: 'pino-pretty',
      options: { colorize: true }
    })
  } else if (logFile) {
    targets.push({
      level,
      target: 'pino/file',
      options: { destination: 1 }
    })
  }

  if (logFile) {
    targets.push({
      level,
      target: 'pino/file',
      options: { destination: logFile, mkdir: true }
    })
  }

  return targets.length > 0 ? { targets } : undefined
}

const transport = buildTransport()

export const logger = pino({
  level,
  redact: {
    paths: ['req.headers["api-key"]', 'req.headers.authorization'],
    censor: '[REDACTED]',
  },
  ...(transport ? { transport } : {}),
})
