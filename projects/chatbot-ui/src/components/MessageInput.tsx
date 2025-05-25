import { ArrowUp, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'

interface MessageInputProps {
  loading?: boolean
  onSendMessage: (message: string) => void
  onSendMessageCancel?: () => void
}

export function MessageInput({ loading, onSendMessage, onSendMessageCancel }: MessageInputProps) {
  // 入力メッセージの状態管理
  const [inputMessage, setInputMessage] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [composition, setComposition] = useState(false)
  const isMobile = useMemo(() => /iPhone|Android/i.test(navigator.userAgent), [])

  // テキストエリアの高さを調整する（5行まで自動拡張、それ以上はスクロール）
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      // 入力が完全に空の場合のみ最小の高さに設定
      if (inputMessage === '') {
        textarea.style.height = '36px' // min-h-[36px]と同じ値
        textarea.style.overflowY = 'hidden'
      } else {
        // 行数を計算（改行の数+1）
        const lineCount = (inputMessage.match(/\n/g) || []).length + 1

        // 5行までは自動拡張（1行あたり約24px）
        const newHeight = Math.min(textarea.scrollHeight, 5 * 24)
        textarea.style.height = `${newHeight}px`

        // 5行以下ならスクロールバーを非表示、それ以上ならスクロールバーを表示
        textarea.style.overflowY = lineCount <= 5 ? 'hidden' : 'auto'
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
    <div className='border-t bg-card p-4'>
      <div className='container mx-auto max-w-4xl'>
        <form
          className='flex items-center gap-3'
          onSubmit={(e) => {
            e.preventDefault()
            handleSendMessage()
          }}
        >
          <Textarea
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
            placeholder='メッセージを入力...'
            className='max-h-[120px] min-h-[40px] flex-1 px-2 text-md'
            rows={1}
          />
          {onSendMessageCancel && loading ? (
            <Button type='button' variant='icon' size='icon' onClick={onSendMessageCancel}>
              <Square className='scale-100' fill='white' />
            </Button>
          ) : (
            <Button
              type='submit'
              variant='icon'
              size='icon'
              disabled={loading || !inputMessage.trim()}
            >
              <ArrowUp className='scale-150' />
            </Button>
          )}
        </form>
      </div>
    </div>
  )
}
