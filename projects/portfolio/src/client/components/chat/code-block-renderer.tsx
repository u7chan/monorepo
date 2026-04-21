import { copyToClipboard } from '#/client/components/chat/copy-to-clipboard'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { ChevronRightIcon } from '#/client/components/svg/chevron-right-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { EyeIcon } from '#/client/components/svg/eye-icon'
import { SparkleIcon } from '#/client/components/svg/sparkle-icon'
import type { AnchorHTMLAttributes, CSSProperties, HTMLAttributes, MouseEvent, ReactNode } from 'react'
import { createContext, useContext, useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'

export const StreamingCodeBlockContext = createContext<boolean>(false)

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

type MarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>

export function MarkdownLink({ href, children }: MarkdownLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (!href) {
      return
    }
    if (href.startsWith('http')) {
      window.open(href, '_blank')
    } else {
      window.location.href = href
    }
  }

  return (
    <a href={href} onClick={handleClick} className='text-primary-800 underline dark:text-primary-400'>
      {children}
    </a>
  )
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

export interface CodeBlockPreviewButtonProps {
  href: string
}

export function CodeBlockPreviewButton({ href }: CodeBlockPreviewButtonProps) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noopener noreferrer'
      aria-label='Preview code block'
      className='relative inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-gray-600 transition-[background-color,color] duration-200 ease-out hover:bg-gray-200 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'
    >
      <EyeIcon size={18} className='stroke-current' />
    </a>
  )
}

export interface CodeBlockGenerateButtonProps {
  onClick: () => void
  pending?: boolean
  disabled?: boolean
}

export function CodeBlockGenerateButton({ onClick, pending, disabled }: CodeBlockGenerateButtonProps) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={pending || disabled}
      aria-label={pending ? 'Generating preview' : 'Generate preview'}
      className='relative inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-gray-600 transition-[background-color,color] duration-200 ease-out hover:bg-gray-200 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:cursor-default disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'
    >
      {pending ? (
        <svg viewBox='0 0 24 24' aria-hidden='true' fill='none' className='h-[18px] w-[18px] animate-spin'>
          <circle cx='12' cy='12' r='9' strokeWidth='2.5' className='stroke-current opacity-25' />
          <path d='M21 12a9 9 0 0 0-9-9' strokeWidth='2.5' strokeLinecap='round' className='stroke-current' />
        </svg>
      ) : (
        <SparkleIcon size={18} className='stroke-current' />
      )}
    </button>
  )
}

interface CodeBlockCopyButtonProps {
  copied: boolean
  onClick: () => void
  disabled?: boolean
}

function CodeBlockCopyButton({ copied, onClick, disabled }: CodeBlockCopyButtonProps) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={copied || disabled}
      aria-label={copied ? 'Copied code block' : 'Copy code block'}
      className={`relative inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-gray-600 transition-[background-color,color] duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:focus-visible:ring-gray-500 ${
        copied
          ? 'text-emerald-600 disabled:cursor-default dark:text-emerald-400'
          : 'hover:bg-gray-200 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-white dark:disabled:hover:bg-transparent dark:disabled:hover:text-gray-300'
      }`}
    >
      <span className='relative h-[18px] w-[18px]' aria-hidden='true'>
        <span
          className={`absolute inset-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
            copied ? '-translate-y-0.5 scale-90 opacity-0' : 'translate-y-0 scale-100 opacity-100'
          }`}
        >
          <CopyIcon size={18} className='stroke-current' />
        </span>
        <span
          className={`absolute inset-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
            copied ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-0.5 scale-90 opacity-0'
          }`}
        >
          <CheckIcon size={18} className='stroke-current' />
        </span>
      </span>
    </button>
  )
}

export function CodeBlockRenderer({ className, children, actions }: CodeBlockRendererProps) {
  const [copied, setCopied] = useState(false)
  const streaming = useContext(StreamingCodeBlockContext)

  const code = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''
  const detectedLanguage = className?.split('-')[1]
  const initialLanguage = detectedLanguage ?? 'plain'

  const [selectedLanguage, setSelectedLanguage] = useState(initialLanguage)
  const [isOpen, setIsOpen] = useState(!streaming)

  // Block code: has a language identifier OR children contains newlines
  // (react-markdown adds a trailing \n to fenced code blocks)
  const isBlock = detectedLanguage !== undefined || (typeof children === 'string' && code.includes('\n'))

  if (!isBlock || typeof children !== 'string') {
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

  const lineCount = code.replace(/\n$/, '').split('\n').length
  const peekMode = streaming && !isOpen
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
    <div className='max-w-full overflow-x-auto'>
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
  )

  return (
    <div className='my-2 w-full max-w-full min-w-0 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-600'>
      <div className='flex items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-600 dark:bg-[#282c34]'>
        <div className='flex items-center gap-1'>
          <button
            type='button'
            onClick={toggle}
            aria-expanded={isOpen}
            aria-label={isOpen ? 'Collapse code block' : 'Expand code block'}
            className='inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-gray-600 transition-colors duration-200 ease-out hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:focus-visible:ring-gray-500'
          >
            <span
              className={`inline-flex transition-transform duration-200 ease-out motion-reduce:transition-none ${
                isOpen ? 'rotate-90' : ''
              }`}
            >
              <ChevronRightIcon size={10} />
            </span>
          </button>
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
      {!isOpen && (
        <button
          type='button'
          onClick={toggle}
          className='flex w-full cursor-pointer items-center bg-gray-50 px-3 py-1.5 text-left text-gray-500 text-xs transition-colors duration-200 ease-out hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-inset dark:bg-[#282c34] dark:text-gray-400 dark:hover:bg-gray-700 dark:focus-visible:ring-gray-500'
        >
          {streaming ? `生成中（${lineCount} 行・クリックで展開）` : `折りたたみ中（${lineCount} 行・クリックで展開）`}
        </button>
      )}
      {peekMode ? (
        <div className='relative h-24 select-none overflow-hidden'>
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
          className={`grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
            isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          }`}
        >
          <div className='min-h-0'>{highlighter}</div>
        </div>
      )}
    </div>
  )
}
