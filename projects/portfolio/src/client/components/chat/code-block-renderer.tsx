import { copyToClipboard } from '#/client/components/chat/copy-to-clipboard'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { useDarkMode } from '#/client/hooks/use-dark-mode'
import type { AnchorHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'

const CODE_BLOCK_FONT_FAMILY = "'M PLUS 1 Code', monospace"

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
}

export function CodeBlockRenderer({ className, children }: CodeBlockRendererProps) {
  const isDarkMode = useDarkMode()
  const [copied, setCopied] = useState(false)

  const code = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''
  const detectedLanguage = className?.split('-')[1]
  const initialLanguage = detectedLanguage ?? 'plain'

  const [selectedLanguage, setSelectedLanguage] = useState(initialLanguage)

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

  const selectOptionStyle = {
    backgroundColor: isDarkMode ? '#282c34' : '#f9fafb',
    color: isDarkMode ? '#d1d5db' : '#374151',
  }

  return (
    <div className='my-2 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-600'>
      <div className='flex items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-600 dark:bg-[#282c34]'>
        <select
          value={selectedLanguage}
          onChange={(e) => setSelectedLanguage(e.target.value)}
          className='cursor-pointer rounded border-none bg-transparent text-xs text-gray-600 dark:text-gray-300'
        >
          {languageOptions.map((lang) => (
            <option key={lang} value={lang} style={selectOptionStyle}>
              {lang}
            </option>
          ))}
        </select>
        <button
          type='button'
          onClick={handleClickCopy}
          disabled={copied}
          className='flex cursor-pointer gap-1 align-center'
        >
          {copied ? (
            <>
              <CheckIcon size={18} className='stroke-gray-600 dark:stroke-gray-300' />
              <span className='text-xs text-gray-600 dark:text-gray-300'>コピーしました</span>
            </>
          ) : (
            <>
              <CopyIcon size={18} className='stroke-gray-600 dark:stroke-gray-300' />
              <span className='text-xs text-gray-600 dark:text-gray-300'>コピーする</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        style={isDarkMode ? atomDark : undefined}
        language={selectedLanguage === 'plain' ? undefined : selectedLanguage}
        customStyle={{ fontSize: '0.875rem', margin: 0, borderRadius: 0, fontFamily: CODE_BLOCK_FONT_FAMILY }}
        codeTagProps={{ style: { fontFamily: CODE_BLOCK_FONT_FAMILY } }}
        showLineNumbers
        lineNumberStyle={{ color: isDarkMode ? '#6b7280' : '#9ca3af', minWidth: '2.5em' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}
