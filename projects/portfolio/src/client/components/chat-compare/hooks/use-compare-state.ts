import { useCallback, useState } from 'react'
import type { ApiChatMessage, ChatUsage } from '#/types'

export interface ModelStreamState {
  model: string
  status: 'idle' | 'streaming' | 'retrying' | 'done' | 'error'
  messages: ApiChatMessage[]
  content: string
  reasoningContent: string
  usage: ChatUsage | null
  finishReason: string | null
  responseTimeMs: number | null
  error: string | null
  retryAttempt: number
}

function createModelStreamState(model: string): ModelStreamState {
  return {
    model,
    status: 'idle',
    messages: [],
    content: '',
    reasoningContent: '',
    usage: null,
    finishReason: null,
    responseTimeMs: null,
    error: null,
    retryAttempt: 0,
  }
}

export function useCompareState() {
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [modelStates, setModelStates] = useState<Record<string, ModelStreamState>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const hasConversation = selectedModels.some((model) => (modelStates[model]?.messages.length ?? 0) > 0)

  const initModelStates = useCallback((models: string[]) => {
    setModelStates((prev) => {
      const next = { ...prev }
      for (const model of models) {
        if (!next[model]) {
          next[model] = createModelStreamState(model)
        }
      }
      return next
    })
  }, [])

  const updateStreamingContent = useCallback((model: string, content: string, reasoningContent: string) => {
    setModelStates((prev) => ({
      ...prev,
      [model]: {
        ...prev[model],
        status: 'streaming' as const,
        content,
        reasoningContent,
      },
    }))
  }, [])

  const setModelDone = useCallback(
    (
      model: string,
      result: {
        finishReason: string
        usage: ChatUsage | null
        responseTimeMs: number
      }
    ) => {
      setModelStates((prev) => ({
        ...prev,
        [model]: {
          ...prev[model],
          status: 'done' as const,
          finishReason: result.finishReason,
          usage: result.usage,
          responseTimeMs: result.responseTimeMs,
        },
      }))
    },
    []
  )

  const setModelError = useCallback((model: string, error: string) => {
    setModelStates((prev) => ({
      ...prev,
      [model]: {
        ...prev[model],
        status: 'error' as const,
        error,
      },
    }))
  }, [])

  const setModelRetrying = useCallback((model: string, attempt: number) => {
    setModelStates((prev) => ({
      ...prev,
      [model]: {
        ...prev[model],
        status: 'retrying' as const,
        content: '',
        reasoningContent: '',
        usage: null,
        finishReason: null,
        responseTimeMs: null,
        error: null,
        retryAttempt: attempt,
      },
    }))
  }, [])

  const resetModelStream = useCallback((model: string) => {
    setModelStates((prev) => {
      const current = prev[model]
      if (!current) return prev
      return {
        ...prev,
        [model]: {
          ...current,
          status: 'idle' as const,
          content: '',
          reasoningContent: '',
          usage: null,
          finishReason: null,
          responseTimeMs: null,
          error: null,
          retryAttempt: 0,
        },
      }
    })
  }, [])

  const appendAssistantMessage = useCallback((model: string, assistantMessage: ApiChatMessage) => {
    setModelStates((prev) => ({
      ...prev,
      [model]: {
        ...prev[model],
        messages: [...prev[model].messages, assistantMessage],
      },
    }))
  }, [])

  const setModelStreaming = useCallback((model: string) => {
    setModelStates((prev) => ({
      ...prev,
      [model]: {
        ...prev[model],
        status: 'streaming' as const,
        content: '',
        reasoningContent: '',
        usage: null,
        finishReason: null,
        responseTimeMs: null,
        error: null,
        retryAttempt: 0,
      },
    }))
  }, [])

  const appendUserMessageToAll = useCallback((selectedModels: string[], userMessage: ApiChatMessage) => {
    setModelStates((prev) => {
      const next = { ...prev }
      for (const model of selectedModels) {
        if (!next[model]) continue
        next[model] = {
          ...next[model],
          messages: [...next[model].messages, userMessage],
        }
      }
      return next
    })
  }, [])

  const resetAllConversations = useCallback((models: string[]) => {
    setModelStates((prev) => {
      const next = { ...prev }
      for (const model of models) {
        next[model] = createModelStreamState(model)
      }
      return next
    })
  }, [])

  return {
    selectedModels,
    setSelectedModels,
    modelStates,
    isSubmitting,
    setIsSubmitting,
    hasConversation,
    initModelStates,
    updateStreamingContent,
    setModelDone,
    setModelError,
    setModelRetrying,
    resetModelStream,
    appendAssistantMessage,
    setModelStreaming,
    appendUserMessageToAll,
    resetAllConversations,
  }
}
