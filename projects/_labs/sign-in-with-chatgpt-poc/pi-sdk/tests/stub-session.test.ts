import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Config, loadConfig } from "../src/config.js"
import { runStubSession } from "../src/stub-session.js"
import {
  buildToolCheckCommand,
  parseEnvironmentReport,
  splitToolCheckOutput,
} from "../src/tool-check.js"

const DUMMY_VARIABLE = "SIWC_PI_TEST_DUMMY_TOKEN"

function withTempConfig<T>(
  fn: (config: Config, dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "siwc-pi-session-"))
  const config: Config = {
    ...loadConfig({}, dir),
    storageDir: dir,
    authPath: join(dir, "auth.json"),
    deviceIdPath: join(dir, "device-id"),
    workspace: dir,
  }
  return fn(config, dir).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

describe("stub provider 経由のエージェントセッション", () => {
  test("セッションがツール呼び出しを実行し、送信 payload は store:false / stream:true になる", async () => {
    await withTempConfig(async (config) => {
      const session = await runStubSession(config, {
        prompt: "self check",
        toolCommand: "true",
      })

      expect(session.result.text).toBe("stub ok")
      expect(session.result.provider).toBe("siwc-poc-stub")
      expect(session.result.api).toBe("openai-responses")
      expect(session.result.requests[0]?.store).toBe(false)
      expect(session.result.requests[0]?.stream).toBe(true)
      expect(session.result.requests[0]?.toolNames).toContain("bash")
      expect(
        session.result.responses.every((response) => response.status === 200),
      ).toBe(true)
      // ツール結果を送り返す 2 回目のリクエストまで進む
      expect(session.result.requestCount).toBe(2)
    })
  })

  test("followUpPrompt で同じセッションの 2 ターン目を送れる", async () => {
    await withTempConfig(async (config) => {
      const session = await runStubSession(config, {
        prompt: "1 ターン目",
        toolCommand: "true",
        followUpPrompt: "2 ターン目",
      })

      expect(session.result.answers).toHaveLength(2)
      // 1 回目のツール呼び出し + 2 ターン分で 3 リクエスト
      expect(session.result.requestCount).toBe(3)
      expect(session.result.requests[0]?.inputItems).toBeLessThan(
        session.result.requests[2]?.inputItems ?? 0,
      )
    })
  })

  test("setRuntimeApiKey で外部から渡したトークンでもセッションを実行できる", async () => {
    await withTempConfig(async (config) => {
      const session = await runStubSession(config, {
        prompt: "self check",
        toolCommand: "true",
        runtimeApiKey: "injected-token",
      })

      expect(session.result.text).toBe("stub ok")
      expect(session.result.requests[0]?.store).toBe(false)
      expect(session.result.responses[0]?.status).toBe(200)
    })
  })

  test("保存済み資格情報はツール子プロセスの env へ継承されない", async () => {
    await withTempConfig(async (config, dir) => {
      const secret = `secret-access-${Date.now()}`
      writeFileSync(
        config.authPath,
        JSON.stringify({
          openai: {
            type: "oauth",
            access: secret,
            refresh: "refresh-token",
            expires: Date.now() + 3_600_000,
          },
        }),
        { mode: 0o600 },
      )

      const dummyValue = `dummy-${Date.now()}`
      const previous = process.env[DUMMY_VARIABLE]
      process.env[DUMMY_VARIABLE] = dummyValue
      try {
        const session = await runStubSession(config, {
          prompt: "self check",
          toolCommand: buildToolCheckCommand(config.authPath),
        })
        const { environment, fileAccess } = splitToolCheckOutput(
          session.toolOutput,
        )
        const report = parseEnvironmentReport(environment, {
          prototypeVariable: DUMMY_VARIABLE,
          secretValues: { accessToken: secret },
        })

        expect(session.result.text).toBe("stub ok")
        expect(report.leaked.accessToken).toBe(false)
        expect(report.observed[DUMMY_VARIABLE]).toBe(dummyValue)
        expect(report.sessionVariables.PI_MODEL).toBe("stub-model")
        expect(report.sessionVariables.PI_PROVIDER).toBe("siwc-poc-stub")
        expect(report.sessionVariables.PI_SESSION_ID).toBeTruthy()

        // 同一 OS ユーザーのツールからは資格情報ファイルを読める（env 継承とは別問題）
        expect(fileAccess).toContain("READABLE")
        expect(dir.length).toBeGreaterThan(0)
      } finally {
        if (previous === undefined) {
          delete process.env[DUMMY_VARIABLE]
        } else {
          process.env[DUMMY_VARIABLE] = previous
        }
      }
    })
  })
})
