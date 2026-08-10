import type { Message } from '#/types'

export function buildImageGenerationPrompt(
  messages: Message[],
  currentPrompt: string,
  includeHistory: boolean
): { currentPrompt: string; prompt: string } | null {
  const trimmedPrompt = currentPrompt.trim()
  if (!trimmedPrompt) {
    return null
  }

  const history = includeHistory
    ? messages
        .filter((message) => message.role === 'user' && message.metadata.imageGenerationMode === true)
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
        )
        .map((prompt) => prompt.trim())
        .filter(Boolean)
    : []

  return {
    currentPrompt: trimmedPrompt,
    prompt: [...history, trimmedPrompt].join('\n\n'),
  }
}
