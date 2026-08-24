import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import pino from "pino"
import {
  createAccessLogger,
  resolveAccessLogFilePath,
} from "../src/access-logger"
import { createApp } from "../src/app"
import type { Harness } from "../src/harness"
import { createAgentLogger, logAgent } from "../src/logger"

const fakeHarness: Harness = {
  prompt: async (text) => `assistant: ${text}`,
  dispose: () => {},
}

function requestPrompt(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function createSilentApp() {
  return createApp({
    harness: fakeHarness,
    accessLogger: createAccessLogger({
      logFile: null,
      stdout: pino.destination({ dest: "/dev/null", sync: true }),
    }),
  })
}

describe("GET /", () => {
  it("returns greeting text", async () => {
    const app = createSilentApp()
    const res = await app.request("/")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("Hello Hono!")
  })
})

describe("GET /healthz", () => {
  it("returns ok status", async () => {
    const app = createSilentApp()
    const res = await app.request("/healthz")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})

describe("POST /prompt", () => {
  it("delegates the prompt to the harness and returns the assistant result", async () => {
    const app = createSilentApp()
    const res = await requestPrompt(app, { prompt: "hello" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: "assistant: hello" })
  })

  it("returns 400 with an error body when prompt is empty", async () => {
    const app = createSilentApp()
    const res = await requestPrompt(app, { prompt: "" })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "prompt must be a non-empty string",
    })
  })

  it("returns 400 with an error body when prompt is missing", async () => {
    const app = createSilentApp()
    const res = await requestPrompt(app, {})

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "prompt must be a non-empty string",
    })
  })
})

interface LogRecord {
  [key: string]: unknown
  level: string
  time: string
}

function readJsonl(content: string): LogRecord[] {
  return content
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LogRecord)
}

const FIXED_WIDTH_LOCAL_ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/

describe("access log middleware", () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "aiagent-access-"))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  function createLoggedApp() {
    const stdoutPath = path.join(workDir, "stdout.jsonl")
    const accessFilePath = path.join(workDir, "aiagent-access.log")
    const app = createApp({
      harness: fakeHarness,
      accessLogger: createAccessLogger({
        logFile: accessFilePath,
        stdout: pino.destination({ dest: stdoutPath, sync: true }),
      }),
    })
    return { accessFilePath, app, stdoutPath }
  }

  it("writes the same JSONL for GET /healthz to stdout and the access file", async () => {
    const { accessFilePath, app, stdoutPath } = createLoggedApp()

    const response = await app.request("/healthz")

    expect(response.status).toBe(200)
    const stdoutContent = await readFile(stdoutPath, "utf8")
    const fileContent = await readFile(accessFilePath, "utf8")
    expect(stdoutContent).toBe(fileContent)

    const records = readJsonl(fileContent)
    expect(records).toHaveLength(1)
    const durationMs = records[0]?.durationMs
    expect(typeof durationMs).toBe("number")
    expect(durationMs as number).toBeGreaterThanOrEqual(0)
    expect(records[0]).toMatchObject({
      level: "info",
      method: "GET",
      path: "/healthz",
      status: 200,
    })
    expect(records[0]?.time).toMatch(FIXED_WIDTH_LOCAL_ISO)
    expect(records[0]).not.toHaveProperty("pid")
    expect(records[0]).not.toHaveProperty("hostname")
  })

  it("records the final status and pathname for an unmatched request", async () => {
    const { accessFilePath, app } = createLoggedApp()

    const response = await app.request("/not-found?probe=1")

    expect(response.status).toBe(404)
    expect(readJsonl(await readFile(accessFilePath, "utf8"))).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/not-found",
        status: 404,
        durationMs: expect.any(Number),
      }),
    ])
  })

  it("keeps agent events out of the access file", async () => {
    const { accessFilePath, app } = createLoggedApp()
    const agentFilePath = path.join(workDir, "aiagent.log")
    const agentLogger = createAgentLogger({
      logFile: agentFilePath,
      stdout: pino.destination({
        dest: path.join(workDir, "agent-stdout.jsonl"),
        sync: true,
      }),
    })

    await app.request("/healthz")
    logAgent("start", agentLogger)

    const accessRecord = readJsonl(await readFile(accessFilePath, "utf8"))[0]
    const agentRecord = readJsonl(await readFile(agentFilePath, "utf8"))[0]
    expect(accessRecord).toMatchObject({ method: "GET", path: "/healthz" })
    expect(accessRecord).not.toHaveProperty("msg")
    expect(agentRecord).toMatchObject({ level: "info", msg: "start" })
    expect(agentRecord).not.toHaveProperty("method")
  })
})

describe("LOG_ACCESS_FILE", () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "aiagent-access-env-"))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it("defaults to logs/aiagent-access-YYYYMMDD.log", () => {
    expect(
      resolveAccessLogFilePath({}, new Date(2026, 1, 5, 14, 3, 21)),
    ).toBe("logs/aiagent-access-20260205.log")
  })

  it("writes to the configured path when LOG_ACCESS_FILE is set", async () => {
    const previous = process.env.LOG_ACCESS_FILE
    const accessFilePath = path.join(workDir, "custom-access.jsonl")
    process.env.LOG_ACCESS_FILE = accessFilePath
    try {
      const app = createApp({
        harness: fakeHarness,
        accessLoggerOptions: {
          stdout: pino.destination({
            dest: path.join(workDir, "stdout.jsonl"),
            sync: true,
          }),
        },
      })

      await app.request("/healthz")

      expect(readJsonl(await readFile(accessFilePath, "utf8"))).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.LOG_ACCESS_FILE
      else process.env.LOG_ACCESS_FILE = previous
    }
  })

  it("disables file output when LOG_ACCESS_FILE is an empty string", async () => {
    const previous = process.env.LOG_ACCESS_FILE
    process.env.LOG_ACCESS_FILE = ""
    try {
      const stdoutPath = path.join(workDir, "stdout.jsonl")
      const app = createApp({
        harness: fakeHarness,
        accessLoggerOptions: {
          stdout: pino.destination({ dest: stdoutPath, sync: true }),
        },
      })

      await app.request("/healthz")

      expect(await readdir(workDir)).toEqual(["stdout.jsonl"])
      expect(readJsonl(await readFile(stdoutPath, "utf8"))).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.LOG_ACCESS_FILE
      else process.env.LOG_ACCESS_FILE = previous
    }
  })
})
