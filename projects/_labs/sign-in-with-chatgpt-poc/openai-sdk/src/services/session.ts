import {
  DYNAMIC_CLIENT_ID,
  PLAN_USAGE_SCOPE,
  REFRESH_MARGIN_MS,
} from "../siwc/constants"
import type { DiscoveryClient } from "../siwc/discovery"
import { SicwRequestError } from "../siwc/errors"
import type { FetchLike } from "../siwc/fetch"
import { loadOrCreateHostId } from "../siwc/host"
import type { VerifiedIdentity } from "../siwc/identity"
import type {
  Registration,
  SessionStore,
  StoredSession,
  TokenSet,
} from "../siwc/store"
import {
  refreshAccessToken,
  revokeRefreshToken,
  type TokenResponse,
} from "../siwc/token"

export type SessionStatus = {
  signedIn: boolean
  email: string | null
  subject: string | null
  clientId: string | null
  registeredAt: string | null
  planUsageEnabled: boolean
  scopes: string[]
  expiresAt: string | null
  expiresInSeconds: number | null
  storageFile: string
  extAgentHostId: string
  debugActionsEnabled: boolean
}

export type AuthorizationHints = {
  clientId: string
  extAgentHostId: string
  agentNameHint: string | null
  idTokenHint: string | null
  loginHint: string | null
}

export type SignOutResult = {
  revoked: boolean
  warning: string | null
}

export type SessionDeps = {
  store: SessionStore
  discovery: DiscoveryClient
  fetch: FetchLike
  appName: string
  now?: () => Date
}

export class SessionService {
  private readonly store: SessionStore
  private readonly discovery: DiscoveryClient
  private readonly fetchImpl: FetchLike
  private readonly appName: string
  private readonly now: () => Date
  private refreshInFlight: Promise<TokenSet> | null = null

  constructor(deps: SessionDeps) {
    this.store = deps.store
    this.discovery = deps.discovery
    this.fetchImpl = deps.fetch
    this.appName = deps.appName
    this.now = deps.now ?? (() => new Date())
  }

  async status(debugActionsEnabled: boolean): Promise<SessionStatus> {
    const session = await this.store.read()
    const extAgentHostId = await loadOrCreateHostId(
      this.store.directory,
      this.appName,
    )
    const tokens = session?.tokens ?? null
    const expiresAt = tokens === null ? null : Date.parse(tokens.expiresAt)
    return {
      signedIn: tokens !== null,
      email: session?.registration.email ?? null,
      subject: session?.registration.subject ?? null,
      clientId: session?.registration.clientId ?? null,
      registeredAt: session?.registration.registeredAt ?? null,
      planUsageEnabled: tokens?.scopes.includes(PLAN_USAGE_SCOPE) ?? false,
      scopes: tokens?.scopes ?? [],
      expiresAt: tokens?.expiresAt ?? null,
      expiresInSeconds:
        expiresAt === null || Number.isNaN(expiresAt)
          ? null
          : Math.round((expiresAt - this.now().getTime()) / 1000),
      storageFile: this.store.filePath,
      extAgentHostId,
      debugActionsEnabled,
    }
  }

  /** 初回登録は dynamic_agent_client、再認可は保存済みの client ID とヒントを使う。 */
  async authorizationHints(): Promise<AuthorizationHints> {
    const session = await this.store.read()
    const extAgentHostId = await loadOrCreateHostId(
      this.store.directory,
      this.appName,
    )

    if (session === null) {
      return {
        clientId: DYNAMIC_CLIENT_ID,
        extAgentHostId,
        agentNameHint: this.appName,
        idTokenHint: null,
        loginHint: null,
      }
    }

    return {
      clientId: session.registration.clientId,
      extAgentHostId,
      // agent_name_hint は初回登録時だけ送る（公式ドキュメントの指示）
      agentNameHint: null,
      idTokenHint: session.tokens?.idToken ?? null,
      loginHint: session.registration.email,
    }
  }

  async completeSignIn(input: {
    clientId: string
    issuer: string
    identity: VerifiedIdentity
    tokenResponse: TokenResponse
  }): Promise<void> {
    const existing = await this.store.read()
    if (
      existing !== null &&
      existing.registration.clientId === input.clientId &&
      existing.registration.subject !== input.identity.subject
    ) {
      throw new SicwRequestError({
        message:
          "既存の登録と ID トークンの sub が一致しません。認証情報を更新しません。",
        code: "identity_mismatch",
      })
    }

    const savedAt = this.now()
    const registration: Registration = {
      clientId: input.clientId,
      email: input.identity.email,
      subject: input.identity.subject,
      issuer: input.issuer,
      extAgentHostId: await loadOrCreateHostId(
        this.store.directory,
        this.appName,
      ),
      registeredAt:
        existing?.registration.registeredAt ?? savedAt.toISOString(),
    }

    await this.store.save({
      registration,
      tokens: toTokenSet(input.tokenResponse, savedAt),
    })
  }

  async ensureAccessToken(): Promise<string> {
    const session = await this.store.read()
    const tokens = session?.tokens ?? null
    if (tokens === null) {
      throw new SicwRequestError({
        message: "サインインしていません。",
        status: 401,
        code: "not_signed_in",
      })
    }
    if (needsRefresh(tokens, this.now())) {
      return (await this.refresh()).accessToken
    }
    return tokens.accessToken
  }

  /** 同一セッションの同時リフレッシュで更新トークンを競合させない。 */
  async refresh(): Promise<TokenSet> {
    this.refreshInFlight ??= this.performRefresh().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  async signOut(): Promise<SignOutResult> {
    const session = await this.store.read()
    const tokens = session?.tokens ?? null
    if (session === null || tokens === null) {
      return { revoked: false, warning: null }
    }

    const discovery = await this.discovery.get()
    if (discovery.revocationEndpoint === null) {
      await this.store.clearTokens()
      return {
        revoked: false,
        warning:
          "discovery document に revocation_endpoint がないため、リモート失効は確認できませんでした。",
      }
    }

    const result = await revokeRefreshToken(this.fetchImpl, {
      revocationEndpoint: discovery.revocationEndpoint,
      clientId: session.registration.clientId,
      refreshToken: tokens.refreshToken,
    })
    await this.store.clearTokens()

    if (!result.revoked) {
      return {
        revoked: false,
        warning: `リモート失効を確認できませんでした (HTTP ${result.error?.status ?? "unknown"})。ローカルのトークンは削除済みです。`,
      }
    }
    return { revoked: true, warning: null }
  }

  /** 期限切れ→自動更新の経路を、待たずに検証するためのデバッグ操作。 */
  async expireAccessToken(): Promise<void> {
    const session = await this.requireSession()
    await this.store.save({
      registration: session.registration,
      tokens: {
        ...session.tokens,
        expiresAt: new Date(this.now().getTime() - 1000).toISOString(),
      },
    })
  }

  /** 401 の応答を、更新トークンを壊さずに再現するためのデバッグ操作。 */
  async invalidateAccessToken(): Promise<void> {
    const session = await this.requireSession()
    await this.store.save({
      registration: session.registration,
      tokens: {
        ...session.tokens,
        accessToken: "dummy-invalid-access-token",
        expiresAt: new Date(
          this.now().getTime() + 60 * 60 * 1000,
        ).toISOString(),
      },
    })
  }

  private async performRefresh(): Promise<TokenSet> {
    const session = await this.requireSession()
    const discovery = await this.discovery.get()
    const tokenResponse = await refreshAccessToken(this.fetchImpl, {
      tokenEndpoint: discovery.tokenEndpoint,
      clientId: session.registration.clientId,
      refreshToken: session.tokens.refreshToken,
    })
    const tokens = toTokenSet(tokenResponse, this.now())
    await this.store.save({ registration: session.registration, tokens })
    return tokens
  }

  private async requireSession(): Promise<
    StoredSession & { tokens: TokenSet }
  > {
    const session = await this.store.read()
    if (session === null || session.tokens === null) {
      throw new SicwRequestError({
        message: "サインインしていません。",
        status: 401,
        code: "not_signed_in",
      })
    }
    return { registration: session.registration, tokens: session.tokens }
  }
}

export function needsRefresh(tokens: TokenSet, now: Date): boolean {
  const expiresAt = Date.parse(tokens.expiresAt)
  if (Number.isNaN(expiresAt)) {
    return true
  }
  return expiresAt - now.getTime() <= REFRESH_MARGIN_MS
}

export function toTokenSet(tokenResponse: TokenResponse, now: Date): TokenSet {
  return {
    idToken: tokenResponse.idToken,
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    tokenType: tokenResponse.tokenType,
    scopes: tokenResponse.scopes,
    expiresAt: new Date(
      now.getTime() + tokenResponse.expiresInSeconds * 1000,
    ).toISOString(),
    savedAt: now.toISOString(),
  }
}
