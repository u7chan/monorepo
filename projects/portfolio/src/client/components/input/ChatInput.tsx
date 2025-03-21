import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'

interface Props {
  name?: string
  value?: string
  textAreaRows?: number
  placeholder?: string
  disabled?: boolean
  rightBottom?: ReactNode
  leftBottom?: ReactNode
  handleChangeInput?: (event: ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  handleChangeComposition?: (composition: boolean) => void
}

export function ChatInput({
  name,
  value,
  textAreaRows,
  placeholder,
  disabled,
  rightBottom,
  leftBottom,
  handleChangeInput,
  handleKeyDown,
  handleChangeComposition,
}: Props) {
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
    <div
      className={`mx-4 rounded-3xl border bg-white p-3 ${focus ? 'border-gray-300 shadow-lg' : 'shadow-md'}`}
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
        placeholder={placeholder}
        disabled={disabled}
        className='w-full resize-none overflow-y-auto p-2 focus:outline-hidden disabled:opacity-40'
      />

      <div className='mt-1 flex items-center justify-between'>
        {leftBottom}
        {rightBottom}
      </div>
    </div>
  )
}
