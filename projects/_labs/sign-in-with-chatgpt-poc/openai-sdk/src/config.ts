import { homedir } from "node:os"
import { join } from "node:path"

import { CALLBACK_PATH, REDIRECT_HOST } from "./siwc/constants"

export type Config = {
  port: number
  appName: string
  storageDir: string
  origin: string
  redirectUri: string
  enableDebugActions: boolean
}

const DEFAULT_PORT = 8787

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const port = parsePort(env.PORT)
  const origin = `http://${REDIRECT_HOST}:${port}`
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config")

  return {
    port,
    // agent_name_hint として同意画面に出る。初回登録で使うのでアプリ名として安定させる。
    appName: env.SIWC_APP_NAME ?? "sign-in-with-chatgpt-poc openai-sdk",
    // トークンはリポジトリ外の 0600 ファイルに保存する
    storageDir:
      env.SIWC_STORAGE_DIR ??
      join(configHome, "sign-in-with-chatgpt-poc", "openai-sdk"),
    origin,
    redirectUri: `${origin}${CALLBACK_PATH}`,
    enableDebugActions: env.SIWC_ENABLE_DEBUG_ACTIONS !== "false",
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT の値が不正です: ${value}`)
  }
  return port
}
