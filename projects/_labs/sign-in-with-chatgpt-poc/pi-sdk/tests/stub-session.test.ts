import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Config, loadConfig } from "../src/config.js"
import { authorizationDigest, runStubSession } from "../src/stub-session.js"
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

  test("保存済み OAuth 資格情報は推論に使われ、ツール子プロセスの env へは継承されない", async () => {
    await withTempConfig(async (config, dir) => {
      const access = `dummy-access-${Date.now()}`
      const refresh = `dummy-refresh-${Date.now()}`
      writeFileSync(
        config.authPath,
        JSON.stringify({
          openai: {
            type: "oauth",
            access,
            refresh,
            expires: Date.now() + 3_600_000,
            clientId: "oaiapp_example",
            scopes: ["chatgpt.tokens.use.direct"],
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
          // 保存済みの openai OAuth 資格情報を実際に使わせる
          useStoredOpenAiCredential: true,
        })
        const { environment, fileAccess } = splitToolCheckOutput(
          session.toolOutput,
        )
        const report = parseEnvironmentReport(environment, {
          prototypeVariable: DUMMY_VARIABLE,
          secretValues: { accessToken: access, refreshToken: refresh },
        })

        // 推論は保存済み OAuth トークンで実行された（生の値ではなく指紋で照合）
        expect(session.result.text).toBe("stub ok")
        expect(session.authHeaderDigests.length).toBeGreaterThanOrEqual(2)
        expect(
          session.authHeaderDigests.every(
            (digest) => digest === authorizationDigest(access),
          ),
        ).toBe(true)

        // 同じ資格情報はツール子プロセスの env へは出ない
        expect(report.leaked.accessToken).toBe(false)
        expect(report.leaked.refreshToken).toBe(false)
        expect(report.prototypeInherited).toBe(true)
        expect(report.present[DUMMY_VARIABLE]).toBe(true)
        expect(report.sessionVariables.PI_MODEL).toBe(config.modelId)
        expect(report.sessionVariables.PI_PROVIDER).toBe("openai")
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
