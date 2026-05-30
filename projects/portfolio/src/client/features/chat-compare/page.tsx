import { CompareColumn } from '#/client/features/chat-compare/components/compare-column'
import { CompareComposer } from '#/client/features/chat-compare/components/compare-composer'
import { CompareLayout } from '#/client/features/chat-compare/components/compare-layout'
import { CompareSettings } from '#/client/features/chat-compare/components/compare-settings'
import { ModelChangeConfirmDialog } from '#/client/features/chat-compare/components/model-change-confirm-dialog'
import { ModelCheckboxList } from '#/client/features/chat-compare/components/model-checkbox-list'
import { useChatComparePage } from '#/client/features/chat-compare/hooks/use-chat-compare-page'
import { CloseIcon } from '#/client/shared/icons/close-icon'
import { GearIcon } from '#/client/shared/icons/gear-icon'
import { NewChatIcon } from '#/client/shared/icons/new-chat-icon'

export function ChatCompare() {
  const {
    selectedModels,
    modelStates,
    isSubmitting,
    hasConversation,
    settings,
    updateSettings,
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
  } = useChatComparePage()

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
                state={modelStates[model] ?? getFallbackModelState(model)}
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
