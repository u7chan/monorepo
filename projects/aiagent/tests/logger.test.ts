import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import pino from "pino"

import {
  createAgentLogger,
  dailyLogFileName,
  logAgent,
  logAgentPrompt,
  resolveLogFilePath,
} from "../src/logger"

interface LogRecord {
  level: string
  time: string
  msg: string
}

function parseJsonl(content: string): LogRecord[] {
  return content
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LogRecord)
}

async function readRecords(filePath: string): Promise<LogRecord[]> {
  return parseJsonl(await readFile(filePath, "utf8"))
}

// stdout の検証が対象でないテストで、出力がテスト結果へ漏れないようにする
function discardStdout(): pino.DestinationStream {
  return pino.destination({
    dest: path.join(workDir, "discarded.jsonl"),
    sync: true,
  })
}

// 固定幅ローカルISO。例: 2026-02-15T14:03:21.123+09:00 (常に29文字)
const FIXED_WIDTH_LOCAL_ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "aiagent-logger-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe("createAgentLogger()", () => {
  it("writes the same JSONL to stdout and the daily file", async () => {
    const stdoutPath = path.join(workDir, "stdout.jsonl")
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({
      logFile: filePath,
      stdout: pino.destination({ dest: stdoutPath, sync: true }),
    })

    logAgent("start", logger)
    logAgent("tool start: bash", logger)

    // 完了条件①: stdout と日次ファイルに同内容の JSONL
    const stdoutContent = await readFile(stdoutPath, "utf8")
    const fileContent = await readFile(filePath, "utf8")
    expect(stdoutContent).toBe(fileContent)
    expect(stdoutContent.split("\n").filter((line) => line !== "")).toHaveLength(
      2,
    )
  })

  it("stamps every record with a fixed-width local ISO timestamp", async () => {
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({
      level: "debug",
      logFile: filePath,
      stdout: discardStdout(),
    })

    logAgent("start", logger)
    logAgent("failed: stopReason=error oops", logger)
    logAgentPrompt("hello", logger)

    const lines = (await readFile(filePath, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
    expect(lines).toHaveLength(3)

    for (const line of lines) {
      // 出力イメージ: {"level":"info","time":"...","msg":"..."}
      expect(line).toMatch(/^\{"level":"[a-z]+","time":"/)
      const record = JSON.parse(line) as LogRecord
      expect(record.time).toMatch(FIXED_WIDTH_LOCAL_ISO)
      // 固定幅であることが sed/awk プレフィックス一致の時刻絞りを支える
      expect(record.time).toHaveLength(29)
    }
  })

  it("keeps multi-line messages on a single JSONL line", async () => {
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({
      level: "debug",
      logFile: filePath,
      stdout: discardStdout(),
    })

    logAgent("failed: stopReason=error\nline1\nline2", logger)

    const content = await readFile(filePath, "utf8")
    const lines = content.split("\n").filter((line) => line !== "")
    // 1イベント=1行が機械的に保証される (改行はエスケープされる)
    expect(lines).toHaveLength(1)
    expect(parseJsonl(content)[0]?.msg).toBe(
      "failed: stopReason=error\nline1\nline2",
    )
  })

  it("creates the log directory when it does not exist", async () => {
    const filePath = path.join(workDir, "nested/dir/aiagent.log")
    const logger = createAgentLogger({ logFile: filePath, stdout: discardStdout() })

    logAgent("start", logger)

    expect(await readRecords(filePath)).toHaveLength(1)
  })

  it("appends to the same file instead of truncating it", async () => {
    const filePath = path.join(workDir, "aiagent.log")

    // ローテート方針: 起動時に日付確定・以降追記のみ
    const first = createAgentLogger({
      logFile: filePath,
      stdout: discardStdout(),
    })
    logAgent("tool start: bash", first)
    const second = createAgentLogger({
      logFile: filePath,
      stdout: discardStdout(),
    })
    logAgent("tool end: bash", second)

    const records = await readRecords(filePath)
    expect(records.map((record) => record.msg)).toEqual([
      "tool start: bash",
      "tool end: bash",
    ])
  })
})

describe("LOG_LEVEL", () => {
  it("falls back to info when neither option nor env is set", () => {
    const previous = process.env.LOG_LEVEL
    delete process.env.LOG_LEVEL
    try {
      const logger = createAgentLogger({ logFile: null })
      expect(logger.level).toBe("info")
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL
      else process.env.LOG_LEVEL = previous
    }
  })

  it("follows the LOG_LEVEL environment variable when the option is omitted", () => {
    const previous = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = "warn"
    try {
      const logger = createAgentLogger({ logFile: null })
      expect(logger.level).toBe("warn")
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL
      else process.env.LOG_LEVEL = previous
    }
  })

  it("suppresses records below the configured level", async () => {
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({
      level: "warn",
      logFile: filePath,
      stdout: discardStdout(),
    })

    logAgent("start", logger) // info → 抑制される
    logAgent("retry 2/5 in 250ms: rate limited", logger) // warn → 出力
    logAgent("failed: stopReason=error boom", logger) // error → 出力

    const records = await readRecords(filePath)
    expect(records.map((record) => [record.msg, record.level])).toEqual([
      ["retry 2/5 in 250ms: rate limited", "warn"],
      ["failed: stopReason=error boom", "error"],
    ])
  })
})

describe("LOG_FILE", () => {
  it("defaults to logs/aiagent-YYYYMMDD.log derived from the startup date", () => {
    // 月日がゼロ埋めされた固定のファイル名になる
    expect(resolveLogFilePath({}, new Date(2026, 1, 15, 14, 3, 21))).toBe(
      "logs/aiagent-20260215.log",
    )
  })

  it("resolves an empty-string LOG_FILE to null", () => {
    // 空文字=ファイル出力無効。createAgentLogger の両経路 (env / option) はこの契約に従う
    expect(resolveLogFilePath({ LOG_FILE: "" })).toBeNull()
  })

  it("disables file output when the option is an empty string", async () => {
    // option 直渡しも env と同じ契約 (空文字=出力無効) に正規化される
    const stdoutPath = path.join(workDir, "stdout.jsonl")
    const logger = createAgentLogger({
      logFile: "",
      stdout: pino.destination({ dest: stdoutPath, sync: true }),
    })
    logAgent("start", logger)

    expect(await readdir(workDir)).toEqual(["stdout.jsonl"])
    expect(await readRecords(stdoutPath)).toHaveLength(1)
  })

  it("disables file output when the LOG_FILE environment variable is an empty string", async () => {
    const previous = process.env.LOG_FILE
    process.env.LOG_FILE = ""
    try {
      const stdoutPath = path.join(workDir, "stdout.jsonl")
      const logger = createAgentLogger({
        stdout: pino.destination({ dest: stdoutPath, sync: true }),
      })
      logAgent("start", logger)

      // resolveLogFilePath が null を返し、ファイルストリーム自体が作られない
      expect(await readdir(workDir)).toEqual(["stdout.jsonl"])
      expect(await readRecords(stdoutPath)).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.LOG_FILE
      else process.env.LOG_FILE = previous
    }
  })

  it("uses the LOG_FILE path verbatim when set", () => {
    expect(resolveLogFilePath({ LOG_FILE: "/var/log/agent.log" })).toBe(
      "/var/log/agent.log",
    )
  })
})

describe("dailyLogFileName()", () => {
  it("pads month and day to two digits", () => {
    expect(dailyLogFileName(new Date(2026, 0, 5))).toBe("aiagent-20260105.log")
    expect(dailyLogFileName(new Date(2026, 11, 31))).toBe(
      "aiagent-20261231.log",
    )
  })
})

describe("logAgent()", () => {
  it("assigns levels by message convention (start/end/tool=info, failed=error, retry=warn)", async () => {
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({
      logFile: filePath,
      stdout: discardStdout(),
    })

    logAgent("start", logger)
    logAgent("end", logger)
    logAgent("tool start: bash", logger)
    logAgent("tool end: bash (error)", logger)
    logAgent("failed: stopReason=error oops", logger)
    logAgent("retry 1/3 in 500ms: timeout", logger)

    const records = await readRecords(filePath)
    expect(records.map((record) => [record.msg, record.level])).toEqual([
      ["start", "info"],
      ["end", "info"],
      ["tool start: bash", "info"],
      ["tool end: bash (error)", "info"],
      ["failed: stopReason=error oops", "error"],
      ["retry 1/3 in 500ms: timeout", "warn"],
    ])
  })
})

describe("logAgentPrompt()", () => {
  it("logs an 80-char preview at debug level", async () => {
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({
      level: "debug",
      logFile: filePath,
      stdout: discardStdout(),
    })

    logAgentPrompt("x".repeat(100), logger)

    const records = await readRecords(filePath)
    expect(records.map((record) => [record.msg, record.level])).toEqual([
      [`prompt: "${"x".repeat(80)}..."`, "debug"],
    ])
  })

  it("keeps prompts of at most 80 chars intact", async () => {
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({
      level: "debug",
      logFile: filePath,
      stdout: discardStdout(),
    })

    logAgentPrompt("x".repeat(80), logger)

    const records = await readRecords(filePath)
    expect(records[0]?.msg).toBe(`prompt: "${"x".repeat(80)}"`)
  })

  it("is hidden at the default info level", async () => {
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({ logFile: filePath, stdout: discardStdout() })

    logAgent("start", logger)
    logAgentPrompt("secret prompt body", logger)

    const records = await readRecords(filePath)
    // prompt preview は debug なので info 運用ではファイルに残らない
    expect(records.map((record) => record.msg)).toEqual(["start"])
  })
})

describe("analysis flow (time-prefix narrowing -> keyword grep)", () => {
  it("narrows events by fixed-width time prefix and extracts them by keyword without parsing", async () => {
    // 完了条件②: 「時刻プレフィックス → キーワード grep」の解析フローの実証。
    // シェルで `grep '"time":"2026-02-15T14:03' agent.log | grep 'bash'` するのに相当
    const filePath = path.join(workDir, "aiagent.log")
    const logger = createAgentLogger({
      level: "debug",
      logFile: filePath,
      stdout: discardStdout(),
    })

    logAgent("start", logger)
    logAgent("tool start: bash", logger)
    logAgent("tool end: bash", logger)
    logAgent("retry 1/3 in 500ms: timeout", logger)
    logAgentPrompt("unrelated prompt mentioning nothing special", logger)

    const lines = (await readFile(filePath, "utf8"))
      .split("\n")
      .filter((line) => line !== "")

    // 1) sed 的な時刻絞り: 先頭一致でプレフィックスを切り出せる (JSON パース不要)
    const firstTime = (JSON.parse(lines[0] ?? "") as LogRecord).time
    const minutePrefix = `"time":"${firstTime.slice(0, 16)}`
    const narrowedToMinute = lines.filter((line) =>
      line.includes(minutePrefix),
    )

    // 2) grep でキーワード抽出
    const bashLines = narrowedToMinute.filter((line) => line.includes("bash"))

    expect(bashLines.map((line) => (JSON.parse(line) as LogRecord).msg)).toEqual(
      ["tool start: bash", "tool end: bash"],
    )
  })
})
