import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'

interface Props {
  name?: string
  value?: string
  textAreaRows?: number
  placeholder?: string
  disabled?: boolean
  rightBottom?: ReactNode
  leftBottom?: ReactNode
  onChangeInput?: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onChangeComposition?: (composition: boolean) => void
}

export function ChatInput({
  name,
  value,
  textAreaRows,
  placeholder,
  disabled,
  rightBottom,
  leftBottom,
  onChangeInput,
  onKeyDown,
  onChangeComposition,
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
      className={`mx-4 rounded-3xl border bg-white p-3 transition-colors dark:bg-gray-800 ${focus ? 'border-primary-700 dark:border-primary-500' : 'border-gray-300 dark:border-gray-600'}`}
    >
      <textarea
        ref={ref}
        name={name}
        value={value}
        onChange={onChangeInput}
        onKeyDown={onKeyDown}
        onCompositionStart={() => onChangeComposition?.(true)}
        onCompositionEnd={() => onChangeComposition?.(false)}
        rows={textAreaRows}
        placeholder={placeholder}
        disabled={disabled}
        className='w-full resize-none overflow-y-auto bg-transparent p-2 text-gray-900 placeholder-gray-500 focus:outline-hidden disabled:opacity-40 dark:text-white dark:placeholder-gray-400'
      />

      <div className='mt-1 flex items-center justify-between'>
        {leftBottom}
        {rightBottom}
      </div>
    </div>
  )
}
