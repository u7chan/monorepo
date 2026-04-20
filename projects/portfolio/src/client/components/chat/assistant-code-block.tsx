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
  const canShowActions = supported && (!!existing || ctx.canSaveGeneratedFile)

  return (
    <div>
      <CodeBlockRenderer className={className} {...rest}>
        {children}
      </CodeBlockRenderer>
      {canShowActions && (
        <GeneratedFileActions
          existing={existing}
          disabled={ctx.disabled}
          canSave={ctx.canSaveGeneratedFile}
          onSave={() =>
            ctx.onSave({
              blockIndex,
              language: detectedLanguage ?? '',
              content: code,
            })
          }
        />
      )}
    </div>
  )
}

interface GeneratedFileActionsProps {
  existing: GeneratedCodeFile | undefined
  disabled?: boolean
  canSave?: boolean
  onSave: () => Promise<GeneratedCodeFile | null>
}

function GeneratedFileActions({ existing, disabled, canSave, onSave }: GeneratedFileActionsProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (existing) {
    const previewHref = existing.previewUrl || existing.publicPath

    return (
      <div className='mt-1 flex items-center gap-2 text-xs'>
        <a
          href={previewHref}
          target='_blank'
          rel='noopener noreferrer'
          className='rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
        >
          プレビュー
        </a>
        <span className='text-gray-400 dark:text-gray-500'>{existing.fileName}</span>
      </div>
    )
  }

  if (!canSave) {
    return null
  }

  const handleClick = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='mt-1 flex items-center gap-2 text-xs'>
      <button
        type='button'
        onClick={handleClick}
        disabled={saving || disabled}
        className='cursor-pointer rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-gray-700 hover:bg-gray-100 disabled:cursor-default disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
      >
        {saving ? '生成中…' : '生成'}
      </button>
      {error && <span className='text-red-500'>{error}</span>}
    </div>
  )
}
