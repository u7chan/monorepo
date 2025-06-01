import { ArrowUp, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'

// テキストエリアの高さ定数
const MIN_HEIGHT = 56 // 最小高さ (px)
const MAX_HEIGHT = 120 // 最大高さ (px)
const MAX_LINES = 5 // 自動拡張する最大行数

interface ChatTextInputProps {
  placeholder?: string
  loading?: boolean
  onSendMessage: (message: string) => void
  onSendMessageCancel?: () => void
}

export function ChatTextInput({
  loading,
  placeholder = 'メッセージを入力...',
  onSendMessage,
  onSendMessageCancel,
}: ChatTextInputProps) {
  // 入力メッセージの状態管理
  const [inputMessage, setInputMessage] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [composition, setComposition] = useState(false)
  const isMobile = useMemo(() => /iPhone|Android/i.test(navigator.userAgent), [])

  // テキストエリアの高さを調整する（5行まで自動拡張、それ以上はスクロール）
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      // 一時的にoverflowYをautoに設定してscrollHeightを正確に取得
      textarea.style.overflowY = 'auto'
      textarea.style.height = 'auto'

      // scrollHeightを取得して高さを計算
      const scrollHeight = textarea.scrollHeight
      const newHeight = Math.max(MIN_HEIGHT, Math.min(scrollHeight, MAX_HEIGHT))
      textarea.style.height = `${newHeight}px`

      // 高さが最大高さに達した場合、またはscrollHeightが最大高さを超える場合はスクロールバーを表示
      if (scrollHeight > MAX_HEIGHT) {
        textarea.style.overflowY = 'auto'
      } else {
        textarea.style.overflowY = 'hidden'
      }
    }
  }, [inputMessage]) // inputMessageが変更されたときに高さを調整

  const handleChangeComposition = (composition: boolean) => {
    setComposition(composition)
  }

  // メッセージ送信処理
  const handleSendMessage = () => {
    if (!inputMessage.trim() || composition) {
      return
    }
    onSendMessage(inputMessage)
    setInputMessage('')
  }

  return (
    <div className='p-4'>
      <div className='container mx-auto max-w-4xl rounded-3xl border border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800'>
        <form
          className=''
          onSubmit={(e) => {
            e.preventDefault()
            handleSendMessage()
          }}
        >
          <Textarea
            className={`max-h-[${MAX_HEIGHT}px] min-h-[${MIN_HEIGHT}px] flex-1 px-4 py-4 text-md`}
            ref={textareaRef}
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onCompositionStart={() => handleChangeComposition(true)}
            onCompositionEnd={() => handleChangeComposition(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey || isMobile) {
                  // Shift+Enterまたはモバイルの場合は改行を許可
                  return
                }
                // 通常のEnterはメッセージ送信
                e.preventDefault()
                handleSendMessage()
              }
            }}
            placeholder={placeholder}
            rows={1}
          />
          <div className='flex justify-end p-2'>
            {onSendMessageCancel && loading ? (
              <Button
                className='dark:bg-gray-500'
                type='button'
                variant='icon'
                size='icon'
                onClick={onSendMessageCancel}
              >
                <Square className='scale-85 fill-white dark:fill-white dark:stroke-white' />
              </Button>
            ) : (
              <Button
                className='dark:bg-gray-500'
                type='submit'
                variant='icon'
                size='icon'
                disabled={loading || !inputMessage.trim()}
              >
                <ArrowUp className='scale-125 stroke-white dark:stroke-white' />
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
