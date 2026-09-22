import { type ChangeEvent, type KeyboardEvent, useId, useMemo } from 'react'
import { ChatInput } from '#/client/features/chat/components/chat-input'
import { IconButton } from '#/client/shared/components/icon-button/icon-button'
import { FileImageInput, FileImagePreview } from '#/client/shared/components/input/file-image-input'
import { ArrowUpIcon } from '#/client/shared/icons/arrow-up-icon'
import { StopIcon } from '#/client/shared/icons/stop-icon'
import { UploadIcon } from '#/client/shared/icons/upload-icon'

interface ChatComposerProps {
  name?: string
  value: string
  textAreaRows: number
  placeholder: string
  disabled?: boolean
  loading: boolean
  streamActive: boolean
  includeChatHistory: boolean
  sendImagesOnlyOnce: boolean
  imageGenerationMode?: boolean
  imageGenerationReady?: boolean
  imageGenerationDisabledReason?: string | null
  uploadImages: string[]
  onCancelStream: () => void
  onImageChange: (src: string, index?: number) => void
  onChangeInput: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onChangeComposition: (composition: boolean) => void
  onToggleImageGenerationMode?: () => void
  onToggleChatHistory?: () => void
}

export function ChatComposer({
  name = 'userInput',
  value,
  textAreaRows,
  placeholder,
  disabled,
  loading,
  streamActive,
  includeChatHistory,
  sendImagesOnlyOnce,
  imageGenerationMode = false,
  imageGenerationReady = true,
  imageGenerationDisabledReason,
  uploadImages,
  onCancelStream,
  onImageChange,
  onChangeInput,
  onKeyDown,
  onChangeComposition,
  onToggleImageGenerationMode,
  onToggleChatHistory,
}: ChatComposerProps) {
  return (
    <ChatInput
      name={name}
      value={value}
      textAreaRows={textAreaRows}
      placeholder={placeholder}
      disabled={disabled}
      rightBottom={
        <SendButton
          color={includeChatHistory ? 'primary' : 'green'}
          loading={loading}
          disabled={loading || streamActive || value.trim().length <= 0}
          handleClickStop={onCancelStream}
        />
      }
      leftBottom={
        <div className='flex items-center gap-1'>
          <ImageGenerationModeAction
            enabled={imageGenerationMode}
            ready={imageGenerationReady}
            disabledReason={imageGenerationDisabledReason ?? null}
            includeHistory={includeChatHistory}
            disabled={loading || streamActive}
            onToggleMode={onToggleImageGenerationMode}
            onToggleHistory={onToggleChatHistory}
          />
          {!imageGenerationMode && (
            <ImageUploadAction
              uploadImages={uploadImages}
              disabled={loading || streamActive}
              contextLabel={sendImagesOnlyOnce ? 'この送信に含む' : '履歴でも継続'}
              onImageChange={onImageChange}
            />
          )}
        </div>
      }
      onChangeInput={onChangeInput}
      onKeyDown={onKeyDown}
      onChangeComposition={onChangeComposition}
    />
  )
}

function ImageGenerationModeAction({
  enabled,
  ready,
  disabledReason,
  includeHistory,
  disabled,
  onToggleMode,
  onToggleHistory,
}: {
  enabled: boolean
  ready: boolean
  disabledReason: string | null
  includeHistory: boolean
  disabled: boolean
  onToggleMode?: () => void
  onToggleHistory?: () => void
}) {
  const reasonId = useId()
  // ON にできないときだけボタンを無効化し、ON 中は OFF に戻せるようにする
  const isModeDisabled = disabled || (!enabled && !ready)
  const reason = ready ? null : disabledReason

  return (
    <div className='flex min-w-0 items-center gap-1'>
      <button
        type='button'
        onClick={onToggleMode}
        disabled={isModeDisabled}
        aria-label='画像生成モード On/Off'
        aria-describedby={reason ? reasonId : undefined}
        title={reason ?? undefined}
        className={`shrink-0 rounded-3xl border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
          enabled
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200 dark:hover:bg-emerald-900/60'
            : 'border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
        }`}
      >
        画像生成 {enabled ? 'On' : 'Off'}
      </button>
      {reason && (
        <>
          <span id={reasonId} className='sr-only'>
            {reason}
          </span>
          <span
            aria-hidden='true'
            className='hidden min-w-0 max-w-64 truncate text-xs text-gray-500 sm:inline dark:text-gray-400'
          >
            {reason}
          </span>
        </>
      )}
      <button
        type='button'
        onClick={onToggleHistory}
        disabled={disabled}
        aria-label='画像生成 prompt 履歴 On/Off'
        className={`rounded-3xl border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
          includeHistory
            ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-200 dark:hover:bg-blue-900/60'
            : 'border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
        }`}
      >
        履歴 {includeHistory ? 'On' : 'Off'}
      </button>
    </div>
  )
}

function ImageUploadAction({
  uploadImages,
  disabled,
  contextLabel,
  onImageChange,
}: {
  uploadImages: string[]
  disabled: boolean
  contextLabel: string
  onImageChange: (src: string, index?: number) => void
}) {
  return (
    <FileImagePreview src={uploadImages} contextLabel={contextLabel} onImageChange={onImageChange}>
      <FileImageInput
        fileInputButton={(onClick) => <UploadButton disabled={disabled} onClick={onClick} />}
        onImageChange={onImageChange}
      />
    </FileImagePreview>
  )
}

function UploadButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      aria-label='画像アップロード'
      className='group flex cursor-pointer items-center gap-0.5 rounded-3xl border border-gray-200 bg-white px-2 py-1 transition-colors hover:bg-gray-100 focus:border-primary-700 focus:outline-none focus:ring-0.5 disabled:opacity-50 disabled:hover:cursor-default disabled:hover:bg-white dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:disabled:hover:bg-gray-700'
    >
      <UploadIcon size={20} className='text-gray-500 group-disabled:text-gray-300' />
      <div className='hidden sm:block mr-0.5 text-gray-500 text-xs group-disabled:text-gray-300 dark:text-gray-400 dark:group-disabled:text-gray-500'>
        画像アップロード
      </div>
    </button>
  )
}

interface SendButtonProps {
  color?: 'primary' | 'blue' | 'green'
  loading?: boolean
  disabled?: boolean
  handleClickStop?: () => void
}

export function SendButton({ color = 'blue', loading, disabled, handleClickStop }: SendButtonProps) {
  const classes = useMemo(() => {
    switch (color) {
      case 'primary':
        return 'bg-primary-800 hover:bg-primary-700 disabled:hover:bg-primary-800'
      case 'blue':
        return 'bg-blue-400 hover:bg-blue-300 disabled:hover:bg-blue-400'
      case 'green':
        return 'bg-emerald-400 hover:bg-emerald-300 disabled:hover:bg-emerald-400'
      default:
        throw new Error(`Invalid color type: ${color}`)
    }
  }, [color])

  return loading ? (
    <IconButton
      label='Stop sending'
      onClick={handleClickStop}
      className={`h-8 w-8 rounded-full focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700 ${classes}`}
    >
      <StopIcon className='-translate-x-[0.5px] translate-y-[0.5px] text-white' size={18} />
    </IconButton>
  ) : (
    <IconButton
      label='Send'
      type='submit'
      disabled={disabled}
      className={`h-8 w-8 rounded-full focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:opacity-100 dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700 ${classes}`}
    >
      <ArrowUpIcon className='text-white' size={22} />
    </IconButton>
  )
}
