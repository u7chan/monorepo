'use server'

import { streamText, generateText, APICallError } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

export async function generate(model: string, input: string) {
  const openai = createOpenAI({
    baseURL: process.env.LITELLM_API_BASE_URL!,
    apiKey: process.env.LITELLM_API_KEY!,
  })

  try {
    const response = await generateText({
      model: openai(model),
      prompt: input,
    })
    return { output: response.text }
  } catch (error) {
    console.error('Error generating text:', error)
    if (error instanceof APICallError) {
      return { output: error.responseBody || error.message }
    }
    return { output: error instanceof Error ? error.message : String(error) }
  }
}

export async function generateStream(model: string, input: string) {
  const stream = createStreamableValue('')

  ;(async () => {
    const openai = createOpenAI({
      baseURL: process.env.LITELLM_API_BASE_URL!,
      apiKey: process.env.LITELLM_API_KEY!,
    })
    const { textStream } = streamText({
      model: openai(model),
      prompt: input,
      onError: ({ error }) => {
        console.error('Error generating text stream:', error)
        stream.update(extractErrorMessage(error))
      },
    })

    for await (const delta of textStream) {
      stream.update(delta)
    }
    stream.done()
  })()

  return { output: stream.value }
}

function extractErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.message
    } else if (typeof error === 'string') {
      return error
    } else if (typeof error === 'object' && error !== null) {
      // ネストされたエラー（例: { error: { message: "..." } }）をチェック
      if ('error' in error && typeof error.error === 'object' && error.error !== null && 'message' in error.error) {
        return (error.error as any).message
      } else if ('message' in error) {
        return (error as any).message
      } else {
        // オブジェクトを安全に文字列化（循環参照対策）
        return JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      }
    } else {
      return String(error)
    }
  } catch (fallbackError) {
    console.error('Fallback error in error handling:', fallbackError)
    return 'An unexpected error occurred while processing the error details.'
  }
}
