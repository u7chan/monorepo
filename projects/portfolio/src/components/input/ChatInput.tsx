import type { ChangeEvent, KeyboardEvent } from 'react'

interface Props {
  name?: string
  value?: string
  textAreaRows?: number
  loading?: boolean
  disabled?: boolean
  handleChangeInput?: (event: ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  handleChangeComposition?: (composition: boolean) => void
  handleClickStop?: () => void
}

export function ChatInput({
  name,
  value,
  textAreaRows,
  loading,
  disabled,
  handleChangeInput,
  handleKeyDown,
  handleChangeComposition,
  handleClickStop,
}: Props) {
  return (
    <div className={'flex h-[162px] items-center gap-2 px-4'}>
      <textarea
        name={name}
        value={value}
        onChange={handleChangeInput}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => handleChangeComposition?.(true)}
        onCompositionEnd={() => handleChangeComposition?.(false)}
        rows={textAreaRows}
        placeholder={loading ? 'しばらくお待ちください' : 'メッセージを送信する'}
        disabled={loading}
        className={`max-h-34 w-full resize-none overflow-y-auto rounded-2xl border border-gray-300 p-2 focus:outline-hidden focus:ring-2 focus:ring-blue-600 ${loading && 'opacity-40'}`}
      />
      {loading ? (
        <button
          type='button'
          onClick={handleClickStop}
          className='cursor-pointer whitespace-nowrap rounded-4xl bg-blue-400 px-4 py-2 font-bold text-white hover:bg-blue-300 focus:outline-hidden focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:bg-gray-400'
        >
          停止
        </button>
      ) : (
        <button
          type='submit'
          disabled={disabled}
          className='cursor-pointer whitespace-nowrap rounded-4xl bg-blue-400 px-4 py-2 font-bold text-white hover:bg-blue-300 focus:outline-hidden focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:bg-gray-400'
        >
          送信
        </button>
      )}
    </div>
  )
}
