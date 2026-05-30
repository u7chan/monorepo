import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useCompareModelsQuery } from './use-compare-models-query'
import { useCompareSettings } from './use-compare-settings'
import { type ModelStreamState, useCompareState } from './use-compare-state'
import { useCompareStream } from './use-compare-stream'

export function useChatComparePage() {
  const { settings, updateSettings } = useCompareSettings()
  const {
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
    appendAssistantMessage,
    setModelStreaming,
    appendUserMessageToAll,
    resetAllConversations,
  } = useCompareState()
  const { submitCompare, submitModel, cancelModel, cancelAll } = useCompareStream()
  const { canFetchModels, models, modelsQuery } = useCompareModelsQuery(settings)

  const [input, setInput] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingModelChange, setPendingModelChange] = useState<string[] | null>(null)
  const modelSelectorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!settingsOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [settingsOpen])

  const applyModelChange = useCallback(
    (nextModels: string[]) => {
      initModelStates(nextModels)
      setSelectedModels(nextModels)
      setPendingModelChange(null)
    },
    [initModelStates, setSelectedModels]
  )

  const handleModelChange = useCallback(
    (nextModels: string[]) => {
      if (hasConversation && nextModels.some((m) => !selectedModels.includes(m))) {
        setPendingModelChange(nextModels)
        return
      }
      applyModelChange(nextModels)
    },
    [applyModelChange, hasConversation, selectedModels]
  )

  const confirmModelChange = useCallback(() => {
    if (!pendingModelChange) return
    resetAllConversations(selectedModels)
    applyModelChange(pendingModelChange)
  }, [applyModelChange, pendingModelChange, resetAllConversations, selectedModels])

  const cancelModelChange = useCallback(() => {
    setPendingModelChange(null)
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim()
    if (trimmed.length === 0 || selectedModels.length === 0 || isSubmitting) return

    const models = selectedModels
    const userMessage = { role: 'user' as const, content: trimmed }

    setInput('')
    appendUserMessageToAll(models, userMessage)
    for (const model of models) {
      setModelStreaming(model)
    }

    submitCompare(settings, modelStates, models, userMessage, {
      onStreamContent: (model, content, reasoningContent) => {
        updateStreamingContent(model, content, reasoningContent)
      },
      onStreamDone: (model, result) => {
        setModelDone(model, {
          finishReason: result.finishReason,
          usage: result.usage,
          responseTimeMs: result.responseTimeMs,
        })
        if (result.content) {
          appendAssistantMessage(model, { role: 'assistant', content: result.content })
        }
      },
      onStreamError: (model, error) => {
        setModelError(model, error)
      },
    })
  }, [
    appendAssistantMessage,
    appendUserMessageToAll,
    input,
    isSubmitting,
    modelStates,
    selectedModels,
    setModelDone,
    setModelError,
    setModelStreaming,
    settings,
    submitCompare,
    updateStreamingContent,
  ])

  const handleCancel = useCallback(() => {
    cancelAll()
    for (const model of selectedModels) {
      const state = modelStates[model]
      if (state && (state.status === 'streaming' || state.status === 'retrying')) {
        setModelCancelled(model)
      }
    }
  }, [cancelAll, modelStates, selectedModels, setModelCancelled])

  const handleCancelModel = useCallback(
    (model: string) => {
      cancelModel(model)
      setModelCancelled(model)
    },
    [cancelModel, setModelCancelled]
  )

  const handleRetryModel = useCallback(
    (model: string) => {
      const state = modelStates[model]
      if (!state) return

      setModelRetrying(model)

      void submitModel({
        settings,
        modelState: state,
        callbacks: {
          onStreamContent: (content, reasoningContent) => {
            updateStreamingContent(model, content, reasoningContent)
          },
          onStreamDone: (result) => {
            setModelDone(model, {
              finishReason: result.finishReason,
              usage: result.usage,
              responseTimeMs: result.responseTimeMs,
            })
            if (result.content) {
              appendAssistantMessage(model, { role: 'assistant', content: result.content })
            }
          },
          onStreamError: (error) => {
            setModelError(model, error)
          },
        },
      })
    },
    [
      appendAssistantMessage,
      modelStates,
      setModelDone,
      setModelError,
      setModelRetrying,
      settings,
      submitModel,
      updateStreamingContent,
    ]
  )

  const handleChangeInput = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }, [])

  const handleKeyDown = useCallback((_e: KeyboardEvent<HTMLTextAreaElement>) => {
    // キーダウン処理は不要（Composer 側で Enter ハンドリング）
  }, [])

  const handleChangeComposition = useCallback((_composition: boolean) => {
    // IME 編集中は Enter 送信しないよう Composer が管理
  }, [])

  const handleNewChat = useCallback(() => {
    if (isSubmitting) return
    setInput('')
    resetAllConversations(selectedModels)
  }, [isSubmitting, resetAllConversations, selectedModels])

  return {
    settings,
    updateSettings,
    selectedModels,
    modelStates,
    isSubmitting,
    hasConversation,
    input,
    settingsOpen,
    setSettingsOpen,
    pendingModelChange,
    modelSelectorRef,
    canFetchModels,
    models,
    modelsQuery,
    handleModelChange,
    confirmModelChange,
    cancelModelChange,
    handleSubmit,
    handleCancel,
    handleCancelModel,
    handleRetryModel,
    handleChangeInput,
    handleKeyDown,
    handleChangeComposition,
    handleNewChat,
    getFallbackModelState,
  }
}

function getFallbackModelState(model: string): ModelStreamState {
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
