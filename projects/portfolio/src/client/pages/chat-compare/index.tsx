import { useQuery } from '@tanstack/react-query'
import { hc } from 'hono/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CompareColumn } from '#/client/components/chat-compare/compare-column'
import { CompareComposer } from '#/client/components/chat-compare/compare-composer'
import { CompareLayout } from '#/client/components/chat-compare/compare-layout'
import { CompareSettings } from '#/client/components/chat-compare/compare-settings'
import { useCompareSettings } from '#/client/components/chat-compare/hooks/use-compare-settings'
import { useCompareState } from '#/client/components/chat-compare/hooks/use-compare-state'
import { useCompareStream } from '#/client/components/chat-compare/hooks/use-compare-stream'
import { ModelChangeConfirmDialog } from '#/client/components/chat-compare/model-change-confirm-dialog'
import { ModelCheckboxList } from '#/client/components/chat-compare/model-checkbox-list'
import { CloseIcon } from '#/client/components/svg/close-icon'
import { GearIcon } from '#/client/components/svg/gear-icon'
import { NewChatIcon } from '#/client/components/svg/new-chat-icon'
import type { AppType } from '#/server/app.d'

const client = hc<AppType>('/')

export function ChatCompare() {
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

  const canFetchModels = settings.baseURL.length > 0 && settings.apiKey.length > 0

  const modelsQuery = useQuery({
    queryKey: ['compare-models', settings.baseURL, settings.apiKey],
    queryFn: async () => {
      const res = await client.api['fetch-models'].$get({
        header: {
          'api-key': settings.apiKey,
          'base-url': settings.baseURL,
        },
      } as never)
      return (await res.json()) as string[]
    },
    enabled: canFetchModels,
    staleTime: 5 * 60 * 1000,
  })

  const models = modelsQuery.data ?? []

  const handleModelChange = useCallback(
    (nextModels: string[]) => {
      if (hasConversation && nextModels.some((m) => !selectedModels.includes(m))) {
        setPendingModelChange(nextModels)
        return
      }
      applyModelChange(nextModels)
    },
    [hasConversation, selectedModels]
  )

  const applyModelChange = useCallback(
    (nextModels: string[]) => {
      initModelStates(nextModels)
      setSelectedModels(nextModels)
      setPendingModelChange(null)
    },
    [initModelStates, setSelectedModels]
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
      modelStates,
      setModelRetrying,
      submitModel,
      settings,
      updateStreamingContent,
      setModelDone,
      appendAssistantMessage,
      setModelError,
    ]
  )

  const handleChangeInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }, [])

  const handleKeyDown = useCallback((_e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  const loading = isSubmitting

  return (
    <>
      <CompareLayout
        header={
          <div className='flex shrink-0 items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-700 dark:bg-gray-800'>
            <div className='flex items-center gap-2'>
              <h1 className='font-semibold text-gray-800 text-sm dark:text-gray-200'>Chat Compare</h1>
              <button
                type='button'
                onClick={handleNewChat}
                disabled={!hasConversation || isSubmitting}
                aria-label='New chat'
                className='flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors enabled:cursor-pointer enabled:hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:enabled:hover:bg-gray-700'
              >
                <NewChatIcon size={18} className='fill-current' />
              </button>
            </div>
            <div className='flex items-center gap-2'>
              <button
                type='button'
                onMouseDown={(e) => {
                  if (settingsOpen) e.stopPropagation()
                }}
                onClick={() => setSettingsOpen((prev) => !prev)}
                className='flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-gray-500 text-xs transition-colors hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700'
              >
                {settingsOpen ? (
                  <>
                    <CloseIcon size={14} />
                    Close
                  </>
                ) : (
                  <>
                    <GearIcon size={14} />
                    Settings
                  </>
                )}
              </button>
            </div>
          </div>
        }
        modelSelector={
          <div ref={modelSelectorRef}>
            <CompareSettings
              settings={settings}
              open={settingsOpen}
              onUpdate={updateSettings}
              onClose={() => setSettingsOpen(false)}
            />
            {settingsOpen && (
              <div className='shrink-0 border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-800'>
                <ModelCheckboxList
                  models={models}
                  selectedModels={selectedModels}
                  loading={canFetchModels && modelsQuery.isLoading}
                  error={modelsQuery.isError ? 'モデル一覧の取得に失敗しました' : null}
                  disabled={isSubmitting}
                  onChange={handleModelChange}
                />
              </div>
            )}
          </div>
        }
        columns={
          selectedModels.length === 0 ? (
            <div className='flex flex-1 items-center justify-center'>
              <p className='text-gray-400 text-sm dark:text-gray-500'>
                {canFetchModels ? '比較するモデルを選択してください' : '設定でBase URLとAPI Keyを構成してください'}
              </p>
            </div>
          ) : (
            selectedModels.map((model) => (
              <CompareColumn
                key={model}
                state={
                  modelStates[model] ?? {
                    model,
                    status: 'idle' as const,
                    messages: [],
                    content: '',
                    reasoningContent: '',
                    usage: null,
                    finishReason: null,
                    responseTimeMs: null,
                    error: null,
                  }
                }
                onCancelModel={handleCancelModel}
                onRetryModel={handleRetryModel}
              />
            ))
          )
        }
        composer={
          <CompareComposer
            value={input}
            inputDisabled={loading}
            submitDisabled={selectedModels.length === 0 || loading}
            loading={loading}
            onChangeInput={handleChangeInput}
            onKeyDown={handleKeyDown}
            onChangeComposition={handleChangeComposition}
            onCancel={handleCancel}
            onSubmit={handleSubmit}
          />
        }
      />
      <ModelChangeConfirmDialog
        open={pendingModelChange !== null}
        onConfirm={confirmModelChange}
        onCancel={cancelModelChange}
      />
    </>
  )
}
