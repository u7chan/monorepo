import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'

interface Props {
  name: string
  value: string
  textAreaRows: number
  disabled: boolean
  rightBottom?: ReactNode
  handleChangeInput: (event: ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  handleChangeComposition: (composition: boolean) => void
}

export function ChatInput({
  name,
  value,
  textAreaRows,
  disabled,
  rightBottom,
  handleChangeInput,
  handleKeyDown,
  handleChangeComposition,
}: Partial<Props>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [focus, setFocus] = useState(false)
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
          placeholder={disabled ? 'しばらくお待ちください' : '質問してみよう！'}
          disabled={disabled}
          className={`max-h-34 w-full resize-none overflow-y-auto border-gray-300 p-2 focus:outline-hidden ${disabled && 'opacity-40'}`}
        />
        <div className='flex h-full items-end'>{rightBottom}</div>
      </div>
    </div>
  )
}
