import { type ChangeEvent, type KeyboardEvent, useMemo } from 'react'
import { ChatInput } from '#/client/components/chat/chat-input'
import { FileImageInput, FileImagePreview } from '#/client/components/input/file-image-input'
import { ArrowUpIcon } from '#/client/components/svg/arrow-up-icon'
import { StopIcon } from '#/client/components/svg/stop-icon'
import { UploadIcon } from '#/client/components/svg/upload-icon'

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
  uploadImages: string[]
  onCancelStream: () => void
  onImageChange: (src: string, index?: number) => void
  onChangeInput: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onChangeComposition: (composition: boolean) => void
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
  uploadImages,
  onCancelStream,
  onImageChange,
  onChangeInput,
  onKeyDown,
  onChangeComposition,
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
        <ImageUploadAction
          uploadImages={uploadImages}
          disabled={loading || streamActive}
          contextLabel={sendImagesOnlyOnce ? 'この送信に含む' : '履歴でも継続'}
          onImageChange={onImageChange}
        />
      }
      onChangeInput={onChangeInput}
      onKeyDown={onKeyDown}
      onChangeComposition={onChangeComposition}
    />
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
      className='group flex cursor-pointer items-center gap-0.5 rounded-3xl border border-gray-200 bg-white px-2 py-1 transition-colors hover:bg-gray-100 focus:border-primary-700 focus:outline-none focus:ring-0.5 disabled:opacity-50 disabled:hover:cursor-default disabled:hover:bg-white dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:disabled:hover:bg-gray-700'
    >
      <UploadIcon size={20} className='fill-gray-500 group-disabled:fill-gray-300' />
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
    <button
      type='button'
      onClick={handleClickStop}
      className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700`}
    >
      <StopIcon className='fill-white' size={18} />
    </button>
  ) : (
    <button
      type='submit'
      disabled={disabled}
      className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700`}
    >
      <ArrowUpIcon className='fill-white' size={22} />
    </button>
  )
}
