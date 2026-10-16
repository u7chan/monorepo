import { publicApi } from "./api"

export const PAIR_HASH_PREFIX = "#pair="

export type PairFailure =
  | { status: "invalid" }
  | { status: "rate-limited" }
  | { status: "unreachable"; reason: string }

export type PairExchange = { status: "ok"; token: string } | PairFailure

export function parsePairHash(hash: string): string | null {
  if (!hash.startsWith(PAIR_HASH_PREFIX)) {
    return null
  }

  const code = hash.slice(PAIR_HASH_PREFIX.length)

  return code === "" ? null : code
}

// 到達不能に丸めると LAN / portproxy の確認を促す文言になり、対処が変わる。分類はここで固定する。
export function classifyPairResponse(status: number): PairFailure {
  if (status === 400 || status === 410) {
    return { status: "invalid" }
  }

  if (status === 429) {
    return { status: "rate-limited" }
  }

  return { status: "unreachable", reason: `HTTP ${status}` }
}

export async function exchangePairCode(code: string): Promise<PairExchange> {
  try {
    const res = await publicApi.api.pair.$post({ json: { code } })

    if (res.status !== 200) {
      return classifyPairResponse(res.status)
    }

    const body: unknown = await res.json()

    if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
      return { status: "unreachable", reason: "サーバーの応答を解釈できません" }
    }

    return { status: "ok", token: body.token }
  } catch (error) {
    return { status: "unreachable", reason: error instanceof Error ? error.message : String(error) }
  }
}

export function clearPairHash(): void {
  if (!location.hash.startsWith(PAIR_HASH_PREFIX)) {
    return
  }

  history.replaceState(null, "", `${location.pathname}${location.search}`)
}
