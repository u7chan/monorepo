import OpenAI from 'openai'

/**
 * 上流 LLM へ接続する OpenAI クライアント。
 *
 * 30x を追従すると、許可した base-url から任意のホストへリクエストを転送できてしまうため、
 * SDK の fetch には `redirect: 'error'` を渡して追従させない。
 */
export function createUpstreamClient({ apiKey, baseURL }: { apiKey: string; baseURL: string }): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL,
    fetchOptions: { redirect: 'error' },
  })
}
