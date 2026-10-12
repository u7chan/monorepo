export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export function requestIdFrom(response: Response): string | null {
  return (
    response.headers.get("openai-request-id") ??
    response.headers.get("x-request-id")
  )
}

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.trim() === "") {
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function readStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const property = (value as Record<string, unknown>)[key]
  return typeof property === "string" ? property : null
}

export function readNumberProperty(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const property = (value as Record<string, unknown>)[key]
  return typeof property === "number" && Number.isFinite(property)
    ? property
    : null
}

export function readObjectProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined
  }
  return (value as Record<string, unknown>)[key]
}
