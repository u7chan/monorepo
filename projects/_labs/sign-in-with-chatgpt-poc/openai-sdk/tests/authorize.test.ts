import { describe, expect, test } from "bun:test"

import { buildAuthorizationUrl } from "../src/siwc/authorize"
import {
  API_BASE_URL,
  DYNAMIC_CLIENT_ID,
  REQUESTED_SCOPES,
} from "../src/siwc/constants"

const ENDPOINT = "https://auth.openai.com/api/accounts/authorize"
const BASE = {
  extAgentHostId: "urn:uuid:00000000-0000-0000-0000-000000000000",
  redirectUri: "http://127.0.0.1:8787/auth/callback",
  state: "state-value",
  nonce: "nonce-value",
  codeChallenge: "challenge-value",
}

describe("buildAuthorizationUrl", () => {
  test("初回登録は dynamic_agent_client と agent_name_hint を送る", () => {
    const url = buildAuthorizationUrl(ENDPOINT, {
      ...BASE,
      clientId: DYNAMIC_CLIENT_ID,
      agentNameHint: "my-poc",
    })
    const params = new URL(url).searchParams

    expect(url.startsWith(ENDPOINT)).toBe(true)
    expect(params.get("client_id")).toBe(DYNAMIC_CLIENT_ID)
    expect(params.get("agent_name_hint")).toBe("my-poc")
    expect(params.get("response_type")).toBe("code")
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(params.get("code_challenge")).toBe(BASE.codeChallenge)
    expect(params.get("ext_agent_host_id")).toBe(BASE.extAgentHostId)
    expect(params.get("resource")).toBe(API_BASE_URL)
    expect(params.get("id_token_hint")).toBeNull()
    expect(params.get("login_hint")).toBeNull()
  })

  test("scope は空白区切りの %20 で送る", () => {
    const url = buildAuthorizationUrl(ENDPOINT, {
      ...BASE,
      clientId: DYNAMIC_CLIENT_ID,
    })

    expect(url).not.toContain("+")
    expect(url).toContain(`scope=${REQUESTED_SCOPES.join("%20")}`)
  })

  test("再認可は保存済み client ID とヒントを使い、agent_name_hint を送らない", () => {
    const url = buildAuthorizationUrl(ENDPOINT, {
      ...BASE,
      clientId: "oaiapp_example",
      idTokenHint: "header.payload.signature",
      loginHint: "user@example.com",
    })
    const params = new URL(url).searchParams

    expect(params.get("client_id")).toBe("oaiapp_example")
    expect(params.get("id_token_hint")).toBe("header.payload.signature")
    expect(params.get("login_hint")).toBe("user@example.com")
    expect(params.get("agent_name_hint")).toBeNull()
  })
})
