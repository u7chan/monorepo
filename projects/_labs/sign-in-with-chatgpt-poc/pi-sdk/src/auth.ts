import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import {
  ModelRuntime,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent"
import type { Config } from "./config.js"
import { readOrCreateDeviceId } from "./device-id.js"
import type { LoginInteraction } from "./login.js"

/** SIWC の OAuth アクセストークンを受け取る Pi 組み込みプロバイダ */
export const SIWC_PROVIDER = "openai"
/** ChatGPT の backend-api を使う別経路。SIWC 経路と混同しないために明示的に確認する */
export const CODEX_PROVIDER = "openai-codex"

export type StoredCredential = {
  type: "api_key" | "oauth"
  access?: string
  refresh?: string
  expires?: number
  clientId?: string
  scopes?: string[]
}

export async function createModelRuntime(
  config: Config,
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: config.authPath,
    // ホームディレクトリの models.json / models-store.json を読ませず、PoC の保存先に閉じる
    modelsPath: null,
  })
}

export async function loginWithSiwc(
  runtime: ModelRuntime,
  config: Config,
  interaction: LoginInteraction,
): Promise<void> {
  await runtime.login(SIWC_PROVIDER, "oauth", interaction, {
    getDeviceId: () => readOrCreateDeviceId(config.deviceIdPath),
    agentName: config.agentName,
  })
}

export async function logoutWithSiwc(runtime: ModelRuntime): Promise<void> {
  await runtime.logout(SIWC_PROVIDER)
}

export interface AuthReport {
  provider: string
  configured: boolean
  source?: string
  label?: string
  usingOAuth: boolean
  usingSubscription: boolean
  credentialType?: "api_key" | "oauth"
  hasRefreshToken: boolean
  expiresAt?: number
  expiresInSeconds?: number
  scopes?: string[]
  clientId?: string
  codex: {
    configured: boolean
    usingOAuth: boolean
    usingSubscription: boolean
  }
}

function readStoredCredentialSafely(
  config: Config,
): StoredCredential | undefined {
  try {
    return readStoredCredential(SIWC_PROVIDER, config.authPath) as
      | StoredCredential
      | undefined
  } catch {
    return undefined
  }
}

export async function describeAuth(
  runtime: ModelRuntime,
  config: Config,
): Promise<AuthReport> {
  const status = runtime.getProviderAuthStatus(SIWC_PROVIDER)
  const stored = readStoredCredentialSafely(config)
  const expiresAt =
    typeof stored?.expires === "number" ? stored.expires : undefined

  return {
    provider: SIWC_PROVIDER,
    configured: status.configured,
    source: status.source,
    label: status.label,
    usingOAuth: runtime.isUsingOAuth(SIWC_PROVIDER),
    usingSubscription: runtime.isUsingSubscription(SIWC_PROVIDER),
    credentialType: stored?.type,
    hasRefreshToken:
      typeof stored?.refresh === "string" && stored.refresh.length > 0,
    expiresAt,
    expiresInSeconds:
      expiresAt === undefined
        ? undefined
        : Math.floor((expiresAt - Date.now()) / 1000),
    scopes: stored?.scopes,
    clientId: stored?.clientId,
    codex: {
      configured: runtime.getProviderAuthStatus(CODEX_PROVIDER).configured,
      usingOAuth: runtime.isUsingOAuth(CODEX_PROVIDER),
      usingSubscription: runtime.isUsingSubscription(CODEX_PROVIDER),
    },
  }
}

/**
 * SIWC PoC では API キーへの暗黙のフォールバックを認めない。
 * `openai` の OAuth（ChatGPT プラン）でなくても推論できてしまうと、「SIWC 経路で検証した」
 * という記録が崩れるため。
 */
export function assertSiwcCredential(report: AuthReport): void {
  if (!report.usingOAuth || report.credentialType !== "oauth") {
    const detail =
      report.source === "environment"
        ? "現在は OPENAI_API_KEY などの API キーが使われようとしています。"
        : `現在の資格情報: ${report.credentialType ?? "なし"}（source: ${report.source ?? "なし"}）`
    throw new Error(
      `SIWC 経路の OAuth 資格情報がありません。\`bun run start login\` でサインインし、OPENAI_API_KEY を unset してください。${detail}`,
    )
  }
  if (!report.usingSubscription) {
    throw new Error(
      "OAuth 資格情報はありますが、ChatGPT プラン枠（subscription）として認識されていません。SIWC で再ログインしてください。",
    )
  }
}

/** 保存済みの OAuth 資格情報を読み書きする。書式や権限を一箇所に閉じるためのもの */
function updateStoredOAuthCredential(
  config: Config,
  update: (credential: Record<string, unknown>) => void,
): boolean {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(config.authPath, "utf-8"))
  } catch {
    return false
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false
  }

  const record = data as Record<string, unknown>
  const credential = record[SIWC_PROVIDER]
  if (
    typeof credential !== "object" ||
    credential === null ||
    Array.isArray(credential)
  ) {
    return false
  }

  const oauth = credential as Record<string, unknown>
  if (oauth.type !== "oauth") {
    return false
  }

  update(oauth)
  writeFileSync(config.authPath, JSON.stringify(record, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  })
  chmodSync(config.authPath, 0o600)
  return true
}

/**
 * 保存済みアクセストークンの期限だけを過去にずらす。トークン自体は有効なままなので、
 * 次のリクエスト前に Pi の OAuth 更新が走るかどうかを確認できる。
 */
export function forceExpireStoredToken(
  config: Config,
  now: number = Date.now(),
): boolean {
  return updateStoredOAuthCredential(config, (credential) => {
    credential.expires = now - 1000
  })
}

/**
 * アクセストークンをダミー値に差し替え、期限は未来のままにする。期限が有効なので
 * 自動更新は走らず、API 側の 401 がそのまま見える。
 */
export function forceInvalidStoredToken(
  config: Config,
  now: number = Date.now(),
): boolean {
  return updateStoredOAuthCredential(config, (credential) => {
    credential.access = "dummy-access-token-for-poc"
    credential.expires = now + 3_600_000
  })
}
