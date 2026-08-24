import type { MiddlewareHandler } from "hono"
import pino from "pino"
import { localIsoTimestamp } from "./logger"

const pad = (value: number, width: number) => String(value).padStart(width, "0")

const localIsoTime = () => `,"time":"${localIsoTimestamp(new Date())}"`

export type AccessLogger = pino.Logger

export interface CreateAccessLoggerOptions {
  // null または空文字でファイル出力を無効化する
  logFile?: string | null
  // テストで stdout の出力先を差し替える
  stdout?: pino.DestinationStream
}

export function dailyAccessLogFileName(date: Date): string {
  return (
    `aiagent-access-${date.getFullYear()}${pad(date.getMonth() + 1, 2)}` +
    `${pad(date.getDate(), 2)}.log`
  )
}

// LOG_ACCESS_FILE の解釈: 未設定=デフォルトパス / 空文字=ファイル出力無効 / 非空=そのパス
export function resolveAccessLogFilePath(
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): string | null {
  if (env.LOG_ACCESS_FILE !== undefined) {
    return env.LOG_ACCESS_FILE === "" ? null : env.LOG_ACCESS_FILE
  }
  return `logs/${dailyAccessLogFileName(now)}`
}

export function createAccessLogger(
  options: CreateAccessLoggerOptions = {},
): AccessLogger {
  const requestedLogFile =
    options.logFile !== undefined
      ? options.logFile
      : resolveAccessLogFilePath(process.env)
  const logFilePath = requestedLogFile === "" ? null : requestedLogFile

  // sync: true で起動直後の終了時にもアクセスログを確実に書き込む
  const streams = [
    {
      level: "trace",
      stream: options.stdout ?? pino.destination({ dest: 1, sync: true }),
    },
    ...(logFilePath === null
      ? []
      : [
          {
            level: "trace",
            stream: pino.destination({
              dest: logFilePath,
              append: true,
              mkdir: true,
              sync: true,
            }),
          },
        ]),
  ]

  return pino(
    {
      level: "info",
      // エージェントログと同じ JSONL 方針だが、アクセスログにはプロセス情報を含めない
      base: {},
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: localIsoTime,
    },
    pino.multistream(streams),
  )
}

export interface AccessLogMiddlewareOptions {
  // 経過時間の検証で差し替えられる時計
  now?: () => number
}

export function accessLogMiddleware(
  accessLogger: AccessLogger,
  options: AccessLogMiddlewareOptions = {},
): MiddlewareHandler {
  const now = options.now ?? Date.now

  return async (c, next) => {
    const startedAt = now()
    const method = c.req.method
    const path = c.req.path

    try {
      await next()
    } finally {
      accessLogger.info({
        method,
        path,
        status: c.res.status,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
      })
    }
  }
}
