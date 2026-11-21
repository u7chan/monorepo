import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { createContext, useContext, useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import { CodeBlockCopyButton } from '#/client/features/chat/components/code-block-buttons'
import { IconButton } from '#/client/shared/components/icon-button/icon-button'
import { ChevronRightIcon } from '#/client/shared/icons/chevron-right-icon'
import { copyToClipboard } from '#/client/shared/lib/copy-to-clipboard'

export const StreamingCodeBlockContext = createContext<boolean>(false)

export type CodeBlockOpenBlocks = ReadonlyMap<string, boolean>

export type CodeBlockOpenChangeHandler = (key: string, isOpen: boolean) => void

export interface CodeBlockOpenStateContextValue {
  messageId: string
  cursor: { current: number }
  openBlocks: CodeBlockOpenBlocks
  onOpenChange: CodeBlockOpenChangeHandler
}

export const CodeBlockOpenStateContext = createContext<CodeBlockOpenStateContextValue | null>(null)

const CUSTOM_STYLE: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontWeight: 400,
  fontSize: '0.875rem',
  margin: 0,
  borderRadius: 0,
  whiteSpace: 'pre',
  wordBreak: 'normal',
  overflowWrap: 'normal',
}

const SUPPORTED_LANGUAGES = [
  'plain',
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'dart',
  'diff',
  'docker',
  'elixir',
  'erlang',
  'go',
  'graphql',
  'http',
  'java',
  'javascript',
  'json',
  'jsx',
  'kotlin',
  'lua',
  'makefile',
  'markup',
  'markdown',
  'nginx',
  'objectivec',
  'perl',
  'php',
  'powershell',
  'python',
  'r',
  'ruby',
  'rust',
  'scala',
  'scss',
  'sql',
  'swift',
  'toml',
  'tsx',
  'typescript',
  'vim',
  'yaml',
  'zig',
]

type CodeBlockRendererProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode | string
  actions?: ReactNode
}

export function CodeBlockRenderer({ className, children, actions }: CodeBlockRendererProps) {
  const [copied, setCopied] = useState(false)
  const streaming = useContext(StreamingCodeBlockContext)
  const openState = useContext(CodeBlockOpenStateContext)

  const code = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''
  const detectedLanguage = className?.split('-')[1]
  const initialLanguage = detectedLanguage ?? 'plain'

  const [selectedLanguage, setSelectedLanguage] = useState(initialLanguage)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)

  // Block code: has a language identifier OR children contains newlines
  // (react-markdown adds a trailing \n to fenced code blocks)
  const isBlock = detectedLanguage !== undefined || (typeof children === 'string' && code.includes('\n'))
  const isRenderableBlock = isBlock && typeof children === 'string'
  const lineCount = code.replace(/\n$/, '').split('\n').length
  const canCollapse = lineCount >= 4
  const stateKey =
    isRenderableBlock && canCollapse && openState ? `${openState.messageId}:${openState.cursor.current++}` : undefined
  const controlledOpen = stateKey ? (openState?.openBlocks.get(stateKey) ?? false) : undefined
  const isOpen = !canCollapse || (controlledOpen ?? uncontrolledOpen)
  const setIsOpen = (value: boolean | ((current: boolean) => boolean)) => {
    const nextOpen = typeof value === 'function' ? value(isOpen) : value
    if (stateKey && openState) {
      openState.onOpenChange(stateKey, nextOpen)
    } else {
      setUncontrolledOpen(nextOpen)
    }
  }

  if (!isRenderableBlock) {
    return (
      <code
        className={`${className ?? ''} before:content-none after:content-none rounded bg-gray-100 px-1 py-0.5 font-mono text-sm dark:bg-gray-700`}
      >
        {children}
      </code>
    )
  }

  // Include detected language in options even if not in the standard list
  const languageOptions = SUPPORTED_LANGUAGES.includes(initialLanguage)
    ? SUPPORTED_LANGUAGES
    : [initialLanguage, ...SUPPORTED_LANGUAGES]

  const peekMode = canCollapse && !isOpen
  const toggle = () => setIsOpen((v) => !v)

  const handleClickCopy = async () => {
    setCopied(true)
    try {
      await copyToClipboard(children.trim())
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } catch (error) {
      alert(error)
    }
    setCopied(false)
  }

  const highlighter = (
    <div className='bg-[#282c34]'>
      <div className='code-block-scrollbar max-w-full overflow-x-auto rounded-b-md'>
        <SyntaxHighlighter
          style={atomDark}
          language={selectedLanguage}
          customStyle={CUSTOM_STYLE}
          codeTagProps={{ style: CUSTOM_STYLE }}
          showLineNumbers={selectedLanguage !== 'plain'}
          lineNumberStyle={{ color: '#6b7280', minWidth: '2.5em' }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  )

  return (
    <div className='my-2 w-full max-w-full min-w-0 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-600'>
      <div className='flex items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-600 dark:bg-[#282c34]'>
        <div className='flex items-center gap-1'>
          {canCollapse && (
            <IconButton
              label={isOpen ? 'Collapse code block' : 'Expand code block'}
              onClick={toggle}
              aria-expanded={isOpen}
              className='inline-flex h-6 w-6 rounded text-gray-600 transition-colors duration-200 ease-out hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700'
            >
              <span
                className={`inline-flex transition-transform duration-200 ease-out motion-reduce:transition-none ${
                  isOpen ? 'rotate-90' : ''
                }`}
              >
                <ChevronRightIcon size={10} />
              </span>
            </IconButton>
          )}
          <div className='relative'>
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              className='cursor-pointer appearance-none rounded border-none bg-gray-50 py-1 pr-6 text-xs text-gray-600 dark:bg-[#282c34] dark:text-gray-300'
            >
              {languageOptions.map((lang) => (
                <option key={lang} value={lang} className='bg-white text-gray-900 dark:bg-[#282c34] dark:text-gray-100'>
                  {lang}
                </option>
              ))}
            </select>
            <svg
              viewBox='0 0 20 20'
              aria-hidden='true'
              className='pointer-events-none absolute top-1/2 right-1 h-3.5 w-3.5 -translate-y-1/2 stroke-gray-600 dark:stroke-gray-300'
              fill='none'
            >
              <path d='M5 7.5L10 12.5L15 7.5' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
          </div>
        </div>
        <div className='flex items-center gap-1'>
          {actions}
          <CodeBlockCopyButton copied={copied} onClick={handleClickCopy} disabled={streaming} />
        </div>
      </div>
      {canCollapse && !isOpen && (
        <button
          type='button'
          onClick={toggle}
          className='flex w-full cursor-pointer items-center bg-gray-50 px-3 py-1.5 text-left text-gray-500 text-xs transition-colors duration-200 ease-out hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-inset dark:bg-[#282c34] dark:text-gray-400 dark:hover:bg-gray-700 dark:focus-visible:ring-gray-500'
        >
          {streaming ? `生成中（${lineCount} 行・クリックで展開）` : `折りたたみ中（${lineCount} 行・クリックで展開）`}
        </button>
      )}
      {peekMode ? (
        <div className='relative h-24 select-none overflow-hidden bg-[#282c34]'>
          <div className='pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden'>
            <SyntaxHighlighter
              style={atomDark}
              language={selectedLanguage}
              customStyle={{ ...CUSTOM_STYLE, overflow: 'hidden' }}
              codeTagProps={{ style: CUSTOM_STYLE }}
              showLineNumbers={selectedLanguage !== 'plain'}
              lineNumberStyle={{ color: '#6b7280', minWidth: '2.5em' }}
            >
              {code}
            </SyntaxHighlighter>
          </div>
          <div
            aria-hidden='true'
            className='pointer-events-none absolute inset-x-0 top-0 h-12 backdrop-blur-[3px]'
            style={{
              maskImage: 'linear-gradient(to bottom, black 30%, transparent)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 30%, transparent)',
            }}
          />
        </div>
      ) : (
        <div
          aria-hidden={!isOpen}
          className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
            isOpen ? 'overflow-y-hidden' : 'overflow-hidden'
          } ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
        >
          <div className='min-h-0'>{highlighter}</div>
        </div>
      )}
    </div>
  )
}
