import type OpenAI from 'openai'

export type CompletionChunk = OpenAI.ChatCompletion
export type CompletionStreamChunk = OpenAI.ChatCompletionChunk

interface ChatStub {
  completions(model: string, content: string): Promise<CompletionChunk>
  streamCompletions(params: {
    model: string
    reasoningContent: string
    content: string
    maxTokens?: number
    includeUsage?: boolean
    onChunk?: (chunk: CompletionStreamChunk) => Promise<boolean>
  }): Promise<void>
}

export const chatStub: ChatStub = {
  async completions(model: string, content: string): Promise<CompletionChunk> {
    return {
      id: 'chatcmpl-1234567890abcdef',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            refusal: null,
          },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
      system_fingerprint: 'fp_dummy',
    }
  },
  async streamCompletions({
    model,
    reasoningContent,
    content,
    maxTokens,
    includeUsage,
    onChunk,
  }: {
    model: string
    reasoningContent: string
    content: string
    maxTokens?: number
    includeUsage?: boolean
    onChunk?: (chunk: CompletionStreamChunk) => Promise<boolean>
  }): Promise<void> {
    let aborted = false
    const chunkResponse: CompletionStreamChunk = {
      id: 'chatcmpl-1234567890abcdef',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: '',
          },
          finish_reason: null,
        },
      ],
      usage: null,
    }
    const chunkSize = 5
    const repeatCount = 3
    const contentList = [
      `これからストリームで返すデータは ${repeatCount} 回繰り返します 🚀`,
      '\n\n',
      ...splitByLength(content.repeat(repeatCount), chunkSize),
      'ストリームの終端です 🚀',
    ]
    const chunkList = [
      ...splitByLength(reasoningContent, chunkSize).map((text) => ({
        content: undefined,
        reasoning_content: text,
      })),
      ...contentList.map((text) => ({
        content: text,
        reasoning_content: undefined,
      })),
    ]
    if (maxTokens !== undefined) {
      aborted = !!(await onChunk?.({
        ...chunkResponse,
        choices: [
          {
            ...chunkResponse.choices[0],
            delta: {
              role: 'assistant',
              content: 'Stop👻',
              reasoning_content: undefined,
            },
            finish_reason: 'length',
          } as OpenAI.ChatCompletionChunk.Choice,
        ],
      }))
    } else {
      for (const chunk of chunkList) {
        if (aborted) {
          break
        }
        aborted = !!(await onChunk?.({
          ...chunkResponse,
          choices: [
            {
              ...chunkResponse.choices[0],
              delta: {
                role: 'assistant',
                content: chunk.content,
                reasoning_content: chunk.reasoning_content,
              },
            } as OpenAI.ChatCompletionChunk.Choice,
          ],
        }))
      }
    }
    if (aborted) {
      return
    }
    await onChunk?.({
      ...chunkResponse,
      choices: [
        {
          ...chunkResponse.choices[0],
          delta: {},
          finish_reason: 'stop',
        },
      ],
      usage: includeUsage
        ? {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
          }
        : undefined,
    })
  },
}

const splitByLength = (text: string, length: number): string[] => {
  const result = []
  for (let i = 0; i < text.length; i += length) {
    result.push(text.slice(i, i + length))
  }
  return result
}
