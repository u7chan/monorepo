import { DISCOVERY_TIMEOUT_MS, DISCOVERY_URL, ISSUER } from "./constants"
import { SicwRequestError, toResponseError } from "./errors"
import {
  type FetchLike,
  readResponseBody,
  readStringProperty,
  requestIdFrom,
} from "./fetch"

export type DiscoveryDocument = {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string | null
  jwksUri: string
}

/**
 * OpenID Connect discovery document を一度だけ取得して使い回す。
 * エンドポイントの値がドキュメントとドリフトするのを避けるため、定数には持たない。
 */
export class DiscoveryClient {
  #cached: DiscoveryDocument | null = null
  #inFlight: Promise<DiscoveryDocument> | null = null

  constructor(private readonly fetchImpl: FetchLike) {}

  async get(): Promise<DiscoveryDocument> {
    if (this.#cached !== null) {
      return this.#cached
    }
    this.#inFlight ??= this.#load().finally(() => {
      this.#inFlight = null
    })
    return this.#inFlight
  }

  async #load(): Promise<DiscoveryDocument> {
    const response = await this.fetchImpl(DISCOVERY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    const payload = await readResponseBody(response)
    if (!response.ok) {
      throw toResponseError({
        status: response.status,
        payload,
        requestId: requestIdFrom(response),
        fallbackMessage: `discovery document を取得できませんでした (HTTP ${response.status})`,
      })
    }
    const document = parseDiscoveryDocument(payload)
    this.#cached = document
    return document
  }
}

export function parseDiscoveryDocument(payload: unknown): DiscoveryDocument {
  const issuer = readStringProperty(payload, "issuer")
  const authorizationEndpoint = readStringProperty(
    payload,
    "authorization_endpoint",
  )
  const tokenEndpoint = readStringProperty(payload, "token_endpoint")
  const jwksUri = readStringProperty(payload, "jwks_uri")

  if (
    issuer === null ||
    authorizationEndpoint === null ||
    tokenEndpoint === null ||
    jwksUri === null
  ) {
    throw new SicwRequestError({
      message: "discovery document に必要なフィールドがありません。",
      code: "invalid_discovery_document",
    })
  }
  if (issuer !== ISSUER) {
    throw new SicwRequestError({
      message: `discovery document の issuer が想定と異なります: ${issuer}`,
      code: "unexpected_issuer",
    })
  }

  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint: readStringProperty(payload, "revocation_endpoint"),
    jwksUri,
  }
}
