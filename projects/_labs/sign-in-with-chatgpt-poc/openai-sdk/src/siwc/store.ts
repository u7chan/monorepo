import { join } from "node:path"

import { readStringProperty } from "./fetch"
import { readJsonFile, removeFile, writeJsonFile } from "./storage"

export const SESSION_FILE_NAME = "session.json"

export type Registration = {
  /** SIWC が発行した client_id。初回登録時の dynamic_agent_client は保存しない。 */
  clientId: string
  email: string | null
  subject: string
  issuer: string
  extAgentHostId: string
  registeredAt: string
}

export type TokenSet = {
  idToken: string
  accessToken: string
  refreshToken: string
  tokenType: string
  scopes: string[]
  expiresAt: string
  savedAt: string
}

export type StoredSession = {
  registration: Registration
  tokens: TokenSet | null
}

export class SessionStore {
  readonly directory: string
  readonly filePath: string

  constructor(directory: string) {
    this.directory = directory
    this.filePath = join(directory, SESSION_FILE_NAME)
  }

  async read(): Promise<StoredSession | null> {
    const value = await readJsonFile(this.filePath)
    if (value === null) {
      return null
    }
    if (!isStoredSession(value)) {
      throw new Error(`${this.filePath} の内容が想定した形式ではありません`)
    }
    return value
  }

  async save(session: StoredSession): Promise<void> {
    await writeJsonFile(this.filePath, session)
  }

  /**
   * サインアウトでトークンだけを消し、client ID と identity の対応は残す。
   * 次回サインインで同じ登録を再利用するため（公式ドキュメントの指示）。
   */
  async clearTokens(): Promise<StoredSession | null> {
    const session = await this.read()
    if (session === null) {
      return null
    }
    const cleared: StoredSession = {
      registration: session.registration,
      tokens: null,
    }
    await this.save(cleared)
    return cleared
  }

  async remove(): Promise<void> {
    await removeFile(this.filePath)
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    isRegistration(record.registration) &&
    (record.tokens === null || isTokenSet(record.tokens))
  )
}

function isRegistration(value: unknown): boolean {
  const email =
    typeof value === "object" && value !== null
      ? (value as { email?: unknown }).email
      : undefined
  return (
    typeof readStringProperty(value, "clientId") === "string" &&
    typeof readStringProperty(value, "subject") === "string" &&
    typeof readStringProperty(value, "issuer") === "string" &&
    typeof readStringProperty(value, "extAgentHostId") === "string" &&
    (email === undefined || email === null || typeof email === "string")
  )
}

function isTokenSet(value: unknown): boolean {
  const scopes =
    typeof value === "object" && value !== null
      ? (value as { scopes?: unknown }).scopes
      : null
  return (
    typeof readStringProperty(value, "idToken") === "string" &&
    typeof readStringProperty(value, "accessToken") === "string" &&
    typeof readStringProperty(value, "refreshToken") === "string" &&
    typeof readStringProperty(value, "tokenType") === "string" &&
    typeof readStringProperty(value, "expiresAt") === "string" &&
    typeof readStringProperty(value, "savedAt") === "string" &&
    Array.isArray(scopes) &&
    scopes.every((scope) => typeof scope === "string")
  )
}
