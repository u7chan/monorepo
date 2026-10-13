import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const DEFAULT_MODEL_ID = "gpt-6-luna"
export const DEFAULT_AGENT_NAME = "sign-in-with-chatgpt-poc pi-sdk"

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium"

export interface Config {
  /** 資格情報とホスト ID の保存先（リポジトリ外） */
  storageDir: string
  authPath: string
  deviceIdPath: string
  modelId: string
  thinkingLevel: ThinkingLevel
  agentName: string
  /** ツールの作業ディレクトリ */
  workspace: string
}

const ENV_STORAGE_DIR = "SIWC_PI_STORAGE_DIR"
const ENV_MODEL = "SIWC_PI_MODEL"
const ENV_THINKING = "SIWC_PI_THINKING"
const ENV_AGENT_NAME = "SIWC_PI_AGENT_NAME"
const ENV_WORKSPACE = "SIWC_PI_WORKSPACE"

export function defaultStorageDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  return join(base, "sign-in-with-chatgpt-poc", "pi-sdk")
}

export function parseThinkingLevel(raw: string): ThinkingLevel {
  const value = raw.trim()
  const found = THINKING_LEVELS.find((level) => level === value)
  if (!found) {
    throw new Error(
      `Invalid thinking level: ${raw} (expected one of ${THINKING_LEVELS.join(", ")})`,
    )
  }
  return found
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Config {
  const storageDir = resolve(
    cwd,
    env[ENV_STORAGE_DIR]?.trim() || defaultStorageDir(env),
  )
  const modelId = env[ENV_MODEL]?.trim() || DEFAULT_MODEL_ID
  const thinkingLevel = parseThinkingLevel(
    env[ENV_THINKING]?.trim() || DEFAULT_THINKING_LEVEL,
  )
  const agentName = env[ENV_AGENT_NAME]?.trim() || DEFAULT_AGENT_NAME
  const workspace = resolve(cwd, env[ENV_WORKSPACE]?.trim() || ".")

  return {
    storageDir,
    authPath: join(storageDir, "auth.json"),
    deviceIdPath: join(storageDir, "device-id"),
    modelId,
    thinkingLevel,
    agentName,
    workspace,
  }
}

export const ENV_NAMES = {
  storageDir: ENV_STORAGE_DIR,
  model: ENV_MODEL,
  thinking: ENV_THINKING,
  agentName: ENV_AGENT_NAME,
  workspace: ENV_WORKSPACE,
} as const
