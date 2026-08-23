// エージェント進行状況の構造化ロギング (pino)。
// 障害調査の読み方を「タイムスタンプで絞ってから grep」に決め打ちした設計:
//   - stdout と logs/aiagent-YYYYMMDD.log へ同内容の JSONL を出力 (ファイル出力はデフォルト ON)
//   - タイムスタンプは固定幅ローカルISOなので、sed/awk のプレフィックス一致で時刻絞りできる
//   - レベル配分: start/end/tool=info、failed=error、retry=warn、prompt preview=debug
// worker transport は使わない (in-process の pino.destination + multistream のみ)。
// 呼び出し側はこのファイルの関数経由のみとする。
import pino from "pino"

const pad = (value: number, width: number) => String(value).padStart(width, "0")

// 例: 2026-02-15T14:03:21.123+09:00 (常に同じ文字数になるようゼロ埋め)
export function localIsoTimestamp(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? "-" : "+"
  const absOffset = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}` +
    `T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absOffset / 60), 2)}:${pad(absOffset % 60, 2)}`
  )
}

const localIsoTime = () => `,"time":"${localIsoTimestamp(new Date())}"`

export function dailyLogFileName(date: Date): string {
  return `aiagent-${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}.log`
}

/** LOG_FILE の解釈: 未設定=デフォルトパス / 空文字=ファイル出力無効 / 非空=そのパス */
export function resolveLogFilePath(
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): string | null {
  if (env.LOG_FILE !== undefined) {
    return env.LOG_FILE === "" ? null : env.LOG_FILE
  }
  return `logs/${dailyLogFileName(now)}`
}

// harness.ts のメッセージ規約からレベルを決定する (呼び出し側を変更せずにレベル配分を実現)
export function eventLevel(message: string): "info" | "warn" | "error" {
  if (message.startsWith("failed:")) return "error"
  if (message.startsWith("retry")) return "warn"
  return "info"
}

export interface CreateAgentLoggerOptions {
  /** LOG_LEVEL 相当。未指定なら環境変数、それも未指定なら "info" */
  level?: string
  /** LOG_FILE 相当。null でファイル出力を無効化 */
  logFile?: string | null
  /** stdout 出力先 (テストでの差し替え用)。未指定なら fd 1 */
  stdout?: pino.DestinationStream
}

export function createAgentLogger(
  options: CreateAgentLoggerOptions = {},
): pino.Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? "info"

  // ファイルパスは起動時に確定し、以降は追記のみ
  // TODO: 書き込みごとの日付チェックによる日跨ぎランタイムローテートは先送り
  const logFilePath =
    options.logFile !== undefined
      ? options.logFile
      : resolveLogFilePath(process.env)

  // sync: true で開くことで pino.destination の非同期 open レース
  // (起動即 exit 時の "not ready yet") を構造的に回避する。ログ量は同期書き込みで十分
  // 各ストリームのレベルは trace 固定にし、絞り込みはロガーのレベル一括で行う
  // (multistream エントリのレベル未指定時は info 扱いになり debug が欠落するため)
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
      level,
      // 出力イメージに合わせて level を文字列で出し、pid/hostname は付けない
      base: {},
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: localIsoTime,
    },
    pino.multistream(streams),
  )
}

const agentLogger = createAgentLogger()

export function logAgent(
  message: string,
  logger: pino.Logger = agentLogger,
): void {
  logger[eventLevel(message)](message)
}

export function logAgentPrompt(
  text: string,
  logger: pino.Logger = agentLogger,
): void {
  const preview = text.length > 80 ? `${text.slice(0, 80)}...` : text
  logger.debug(`prompt: "${preview}"`)
}
