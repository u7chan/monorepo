import { useCallback, useMemo, useState } from 'react'
import type { ApiChatMessage, ChatUsage } from '#/types'

export type ModelStreamStatus = 'idle' | 'streaming' | 'retrying' | 'done' | 'error' | 'cancelled'

export interface ModelStreamState {
  model: string
  status: ModelStreamStatus
  messages: ApiChatMessage[]
  content: string
  reasoningContent: string
  usage: ChatUsage | null
  finishReason: string | null
  responseTimeMs: number | null
  error: string | null
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
  }
}

export function useCompareState() {
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [modelStates, setModelStates] = useState<Record<string, ModelStreamState>>({})

  const hasConversation = selectedModels.some((model) => (modelStates[model]?.messages.length ?? 0) > 0)

  const isSubmitting = useMemo(
    () =>
      selectedModels.some(
        (model) => modelStates[model]?.status === 'streaming' || modelStates[model]?.status === 'retrying'
      ),
    [selectedModels, modelStates]
  )

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

  const setModelCancelled = useCallback((model: string) => {
    setModelStates((prev) => ({
      ...prev,
      [model]: {
        ...prev[model],
        status: 'cancelled' as const,
        error: 'Cancelled by user',
      },
    }))
  }, [])

  const setModelRetrying = useCallback((model: string) => {
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
    hasConversation,
    initModelStates,
    updateStreamingContent,
    setModelDone,
    setModelError,
    setModelCancelled,
    setModelRetrying,
    resetModelStream,
    appendAssistantMessage,
    setModelStreaming,
    appendUserMessageToAll,
    resetAllConversations,
  }
}
