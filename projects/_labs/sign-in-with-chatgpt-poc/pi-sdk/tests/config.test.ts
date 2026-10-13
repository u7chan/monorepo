import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  DEFAULT_MODEL_ID,
  defaultStorageDir,
  ENV_NAMES,
  loadConfig,
  parseThinkingLevel,
} from "../src/config.js"

describe("parseThinkingLevel", () => {
  test("既知の level をそのまま返す", () => {
    expect(parseThinkingLevel("high")).toBe("high")
    expect(parseThinkingLevel(" off ")).toBe("off")
  })

  test("未知の level は例外にする", () => {
    expect(() => parseThinkingLevel("ultra")).toThrow(/Invalid thinking level/)
  })
})

describe("loadConfig", () => {
  test("既定値はホーム配下の保存先と gpt-6-luna になる", () => {
    const config = loadConfig({}, "/tmp/workspace")
    expect(config.storageDir).toBe(defaultStorageDir({}))
    expect(config.modelId).toBe(DEFAULT_MODEL_ID)
    expect(config.thinkingLevel).toBe("medium")
    expect(config.workspace).toBe("/tmp/workspace")
    expect(config.authPath).toBe(join(config.storageDir, "auth.json"))
    expect(config.deviceIdPath).toBe(join(config.storageDir, "device-id"))
  })

  test("環境変数で保存先・モデル・thinking level を上書きできる", () => {
    const config = loadConfig(
      {
        XDG_CONFIG_HOME: "/tmp/xdg",
        [ENV_NAMES.model]: "gpt-6-sol",
        [ENV_NAMES.thinking]: "xhigh",
        [ENV_NAMES.agentName]: "custom agent",
        [ENV_NAMES.workspace]: "/tmp/other",
      },
      "/tmp/workspace",
    )
    expect(config.storageDir).toBe("/tmp/xdg/sign-in-with-chatgpt-poc/pi-sdk")
    expect(config.modelId).toBe("gpt-6-sol")
    expect(config.thinkingLevel).toBe("xhigh")
    expect(config.agentName).toBe("custom agent")
    expect(config.workspace).toBe("/tmp/other")
  })

  test("保存先の上書きは相対パスでも解決する", () => {
    const config = loadConfig(
      { [ENV_NAMES.storageDir]: "relative-dir" },
      "/tmp/workspace",
    )
    expect(config.storageDir).toBe("/tmp/workspace/relative-dir")
  })
})
