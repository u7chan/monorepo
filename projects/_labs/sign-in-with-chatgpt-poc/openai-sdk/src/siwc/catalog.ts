import { API_BASE_URL, TOKEN_TIMEOUT_MS } from "./constants"
import { toResponseError } from "./errors"
import {
  type FetchLike,
  readResponseBody,
  readStringProperty,
  requestIdFrom,
} from "./fetch"

export type CatalogModel = {
  slug: string
  displayName: string
}

/**
 * SIWC のモデルカタログは `{ models: [{ slug, display_name, visibility }] }` を返す。
 * openai SDK の `models.list()` は `{ data: [...] }` を前提にするためここでは使わない。
 */
export async function fetchModelCatalog(
  fetchImpl: FetchLike,
  input: { accessToken: string },
): Promise<CatalogModel[]> {
  const response = await fetchImpl(`${API_BASE_URL}/models`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.accessToken}`,
    },
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  })
  const payload = await readResponseBody(response)
  if (!response.ok) {
    throw toResponseError({
      status: response.status,
      payload,
      requestId: requestIdFrom(response),
      fallbackMessage: `モデルカタログを取得できませんでした (HTTP ${response.status})`,
    })
  }
  return parseModelCatalog(payload)
}

export function parseModelCatalog(payload: unknown): CatalogModel[] {
  const models =
    typeof payload === "object" && payload !== null
      ? (payload as { models?: unknown }).models
      : undefined

  if (!Array.isArray(models)) {
    const topLevelKeys =
      typeof payload === "object" && payload !== null
        ? Object.keys(payload).join(", ")
        : typeof payload
    throw new Error(
      `SIWC のモデルカタログ形式 ({ models: [...] }) ではありません。top-level keys: ${topLevelKeys}`,
    )
  }

  return models.flatMap<CatalogModel>((entry) => {
    const slug = readStringProperty(entry, "slug")
    if (slug === null || readStringProperty(entry, "visibility") !== "list") {
      return []
    }
    return [
      { slug, displayName: readStringProperty(entry, "display_name") ?? slug },
    ]
  })
}
