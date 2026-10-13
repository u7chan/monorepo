import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent"

/**
 * 実際に送られた provider リクエストの形だけを記録する。トークンやヘッダー値は持たない。
 * `before_provider_request` は provider へ渡す直前の payload（Responses API の body）を受け取る。
 */
export interface RequestSummary {
  model?: string
  store?: boolean
  stream?: boolean
  topLevelKeys: string[]
  inputItems: number
  /** input 配列の role（system prompt は先頭の developer になる） */
  inputRoles: string[]
  toolNames: string[]
  toolTypes: string[]
  reasoningEffort?: string
  reasoningSummary?: string
  include?: string[]
  hasInstructions: boolean
  instructionLength?: number
  hasPromptCacheKey: boolean
  promptCacheRetention?: string
  maxOutputTokens?: number
  temperature?: number
}

export interface ResponseSummary {
  status: number
  contentType?: string
  requestId?: string
  openaiVersion?: string
}

const RESPONSE_HEADER_ALLOWLIST = [
  "content-type",
  "x-request-id",
  "openai-request-id",
  "openai-version",
]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

/**
 * 実際に wire へ出る形に合わせる。Pi は未対応フィールドを `undefined` にして渡すため、
 * JSON 化して落としてからキーを数える。
 */
function wireRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value)
  if (!record) {
    return {}
  }
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const values = value.filter(
    (item): item is string => typeof item === "string",
  )
  return values.length > 0 ? values : undefined
}

export function summarizeRequestPayload(payload: unknown): RequestSummary {
  const body = wireRecord(payload)
  const tools = Array.isArray(body.tools) ? body.tools : []
  const reasoning = asRecord(body.reasoning)
  const input = Array.isArray(body.input) ? body.input : []

  return {
    model: asString(body.model),
    store: typeof body.store === "boolean" ? body.store : undefined,
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
    topLevelKeys: Object.keys(body).sort(),
    inputItems: input.length,
    inputRoles: input.flatMap((item) => {
      const entry = asRecord(item)
      const role = asString(entry?.role)
      return role ? [role] : []
    }),
    toolNames: tools.flatMap((tool) => {
      const entry = asRecord(tool)
      const name =
        asString(entry?.name) ?? asString(asRecord(entry?.function)?.name)
      return name ? [name] : []
    }),
    toolTypes: tools.flatMap((tool) => {
      const type = asString(asRecord(tool)?.type)
      return type ? [type] : []
    }),
    reasoningEffort: asString(reasoning?.effort),
    reasoningSummary: asString(reasoning?.summary),
    include: asStringArray(body.include),
    hasInstructions: typeof body.instructions === "string",
    instructionLength:
      typeof body.instructions === "string"
        ? body.instructions.length
        : undefined,
    hasPromptCacheKey: body.prompt_cache_key !== undefined,
    promptCacheRetention: asString(body.prompt_cache_retention),
    maxOutputTokens:
      typeof body.max_output_tokens === "number"
        ? body.max_output_tokens
        : undefined,
    temperature:
      typeof body.temperature === "number" ? body.temperature : undefined,
  }
}

export function summarizeResponseHeaders(
  status: number,
  headers: Record<string, string>,
): ResponseSummary {
  const picked: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (RESPONSE_HEADER_ALLOWLIST.includes(key.toLowerCase())) {
      picked[key.toLowerCase()] = value
    }
  }

  return {
    status,
    contentType: picked["content-type"],
    requestId: picked["x-request-id"] ?? picked["openai-request-id"],
    openaiVersion: picked["openai-version"],
  }
}

export interface RequestRecorder {
  extension: InlineExtension
  requests: RequestSummary[]
  responses: ResponseSummary[]
}

export function createRequestRecorder(): RequestRecorder {
  const requests: RequestSummary[] = []
  const responses: ResponseSummary[] = []

  const extension = ((pi: ExtensionAPI) => {
    pi.on("before_provider_request", (event) => {
      requests.push(summarizeRequestPayload(event.payload))
      return event.payload
    })
    pi.on("after_provider_response", (event) => {
      responses.push(summarizeResponseHeaders(event.status, event.headers))
    })
  }) as InlineExtension

  return { extension, requests, responses }
}
