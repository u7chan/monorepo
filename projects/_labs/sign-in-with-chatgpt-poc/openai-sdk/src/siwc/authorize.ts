import { API_BASE_URL, REQUESTED_SCOPES } from "./constants"

export type AuthorizationRequest = {
  clientId: string
  extAgentHostId: string
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
  agentNameHint?: string | undefined
  idTokenHint?: string | undefined
  loginHint?: string | undefined
}

export function buildAuthorizationUrl(
  endpoint: string,
  request: AuthorizationRequest,
): string {
  const params = new URLSearchParams({
    client_id: request.clientId,
    response_type: "code",
    redirect_uri: request.redirectUri,
    scope: REQUESTED_SCOPES.join(" "),
    resource: API_BASE_URL,
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    ext_agent_host_id: request.extAgentHostId,
  })

  if (request.agentNameHint !== undefined && request.agentNameHint !== "") {
    params.set("agent_name_hint", request.agentNameHint)
  }
  if (request.idTokenHint !== undefined && request.idTokenHint !== "") {
    params.set("id_token_hint", request.idTokenHint)
  }
  if (request.loginHint !== undefined && request.loginHint !== "") {
    params.set("login_hint", request.loginHint)
  }

  const url = new URL(endpoint)
  // URLSearchParams は空白を + にする。OAuth のクエリは form-encoding 前提ではないため %20 に直す。
  url.search = params.toString().replaceAll("+", "%20")
  return url.toString()
}
