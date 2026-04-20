import { CodeBlockRenderer } from '#/client/components/chat/code-block-renderer'
import type { GeneratedCodeFile } from '#/types'
import { createContext, type HTMLAttributes, type ReactNode, useContext, useState } from 'react'

export type SaveGeneratedFileRequest = {
  blockIndex: number
  language: string
  content: string
}

export interface AssistantCodeBlockContextValue {
  messageId: string | null
  conversationId: string | null
  generatedFiles: GeneratedCodeFile[]
  cursor: { current: number }
  disabled?: boolean
  canSaveGeneratedFile?: boolean
  onSave: (params: SaveGeneratedFileRequest) => Promise<GeneratedCodeFile | null>
}

export const AssistantCodeBlockContext = createContext<AssistantCodeBlockContextValue | null>(null)

const SUPPORTED_LANGUAGES = new Set(['html', 'htm', 'xhtml', 'svg'])

function isSupportedLanguage(language: string | undefined): boolean {
  if (!language) {
    return false
  }
  return SUPPORTED_LANGUAGES.has(language.toLowerCase())
}

type AssistantAwareCodeBlockProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode | string
}

export function AssistantAwareCodeBlock({ className, children, ...rest }: AssistantAwareCodeBlockProps) {
  const detectedLanguage = className?.split('-')[1]
  const code = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''
  const isBlock = detectedLanguage !== undefined || (typeof children === 'string' && code.includes('\n'))

  if (!isBlock) {
    return (
      <CodeBlockRenderer className={className} {...rest}>
        {children}
      </CodeBlockRenderer>
    )
  }

  return (
    <AssistantSavableCodeBlock className={className} detectedLanguage={detectedLanguage} code={code} {...rest}>
      {children}
    </AssistantSavableCodeBlock>
  )
}

type AssistantSavableCodeBlockProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode | string
  detectedLanguage?: string
  code: string
}

function AssistantSavableCodeBlock({
  className,
  children,
  detectedLanguage,
  code,
  ...rest
}: AssistantSavableCodeBlockProps) {
  const ctx = useContext(AssistantCodeBlockContext)

  // 保存可能な context が無い場合（stream 中や user メッセージなど）は通常描画のみ
  if (!ctx || !ctx.messageId || !ctx.conversationId) {
    return (
      <CodeBlockRenderer className={className} {...rest}>
        {children}
      </CodeBlockRenderer>
    )
  }

  // render のたびに cursor を進めることで fenced code block に順序 index を割り当てる
  const blockIndex = ctx.cursor.current
  ctx.cursor.current += 1

  const existing = ctx.generatedFiles.find((f) => f.blockIndex === blockIndex)
  const supported = isSupportedLanguage(detectedLanguage)
  const previewHref = existing ? existing.previewUrl || existing.publicPath : undefined
  const canShowSaveAction = supported && !existing && ctx.canSaveGeneratedFile

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await ctx.onSave({
        blockIndex,
        language: detectedLanguage ?? '',
        content: code,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <CodeBlockRenderer
        className={className}
        previewHref={previewHref}
        generateAction={
          canShowSaveAction
            ? {
                onClick: handleSave,
                pending: saving,
                disabled: ctx.disabled,
              }
            : undefined
        }
        {...rest}
      >
        {children}
      </CodeBlockRenderer>
      {error && <div className='mt-1 text-red-500 text-xs'>{error}</div>}
    </div>
  )
}
