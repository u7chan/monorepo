import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

interface Props {
  name: string
  value: string
  textAreaRows: number
  buttonColor: 'blue' | 'green'
  loading: boolean
  disabled: boolean
  handleChangeInput: (event: ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  handleChangeComposition: (composition: boolean) => void
  handleClickStop: () => void
}

export function ChatInput({
  name,
  value,
  textAreaRows,
  buttonColor = 'blue',
  loading,
  disabled,
  handleChangeInput,
  handleKeyDown,
  handleChangeComposition,
  handleClickStop,
}: Partial<Props>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [focus, setFocus] = useState(false)
  const buttonColorClasses = ((color) => {
    switch (color) {
      case 'blue':
        return 'bg-blue-400 hover:bg-blue-300'
      case 'green':
        return 'bg-emerald-400 hover:bg-emerald-300'
      default:
        throw new Error(`Invalid color type: ${color}`)
    }
  })(buttonColor)
  useEffect(() => {
    const handleFocus = () => {
      setFocus(true)
    }
    const handleBlur = () => {
      setFocus(false)
    }
    ref?.current?.addEventListener('focus', handleFocus)
    ref?.current?.addEventListener('blur', handleBlur)
    return () => {
      ref?.current?.removeEventListener('focus', handleFocus)
      ref?.current?.removeEventListener('blur', handleBlur)
    }
  }, [])
  return (
    <div className={'flex h-[162px] items-center px-4'}>
      <div
        className={`grid min-h-[84px] flex-1 grid-flow-col grid-cols-[1fr_64px] items-start gap-2 rounded-2xl border bg-white p-2 ${focus ? 'border-gray-300 shadow-lg' : 'shadow-md'}`}
      >
        <textarea
          ref={ref}
          name={name}
          value={value}
          onChange={handleChangeInput}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => handleChangeComposition?.(true)}
          onCompositionEnd={() => handleChangeComposition?.(false)}
          rows={textAreaRows}
          placeholder={loading ? 'しばらくお待ちください' : '質問してみよう！'}
          disabled={loading}
          className={`max-h-34 w-full resize-none overflow-y-auto border-gray-300 p-2 focus:outline-hidden ${loading && 'opacity-40'}`}
        />
        <div className='flex h-full items-end'>
          {loading ? (
            <button
              type='button'
              onClick={handleClickStop}
              className={`cursor-pointer whitespace-nowrap rounded-4xl ${buttonColorClasses} px-4 py-2 font-bold text-white focus:outline-hidden focus:ring-2 focus:ring-blue-600 disabled:cursor-not-allowed disabled:bg-gray-400`}
            >
              停止
            </button>
          ) : (
            <button
              type='submit'
              disabled={disabled}
              className={`cursor-pointer whitespace-nowrap rounded-4xl ${buttonColorClasses} px-4 py-2 font-bold text-white focus:outline-hidden focus:ring-2 focus:ring-blue-600 disabled:cursor-not-allowed disabled:bg-gray-400`}
            >
              送信
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
