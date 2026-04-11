import { copyToClipboard } from '#/client/components/chat/copy-to-clipboard'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import type { AnchorHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'

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
  const isDarkMode = document.documentElement.classList.contains('dark')
  const [copied, setCopied] = useState(false)

  const code = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''
  const detectedLanguage = className?.split('-')[1]
  const initialLanguage = detectedLanguage ?? 'plain'

  const [selectedLanguage, setSelectedLanguage] = useState(initialLanguage)

  // Block code: has a language identifier OR children contains newlines
  // (react-markdown adds a trailing \n to fenced code blocks)
  const isBlock = detectedLanguage !== undefined || (typeof children === 'string' && code.includes('\n'))

  if (!isBlock || typeof children !== 'string') {
    return <code className={className}>{children}</code>
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

  const headerBg = isDarkMode ? 'bg-[#282c34]' : 'bg-gray-100'
  const textColor = isDarkMode ? 'text-gray-300' : 'text-gray-600'
  const iconStroke = isDarkMode ? 'stroke-white' : 'stroke-gray-600'
  const optionStyle = {
    backgroundColor: isDarkMode ? '#282c34' : '#f3f4f6',
    color: isDarkMode ? '#d1d5db' : '#4b5563',
  }

  return (
    <>
      <div className={`flex items-center justify-between px-2 py-1 ${headerBg}`}>
        <select
          value={selectedLanguage}
          onChange={(e) => setSelectedLanguage(e.target.value)}
          className={`cursor-pointer rounded border-none text-xs ${headerBg} ${textColor}`}
        >
          {languageOptions.map((lang) => (
            <option key={lang} value={lang} style={optionStyle}>
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
              <CheckIcon size={18} className={iconStroke} />
              <span className={`text-xs ${textColor}`}>コピーしました</span>
            </>
          ) : (
            <>
              <CopyIcon size={18} className={iconStroke} />
              <span className={`text-xs ${textColor}`}>コピーする</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        style={isDarkMode ? atomDark : undefined}
        language={selectedLanguage === 'plain' ? undefined : selectedLanguage}
      >
        {code}
      </SyntaxHighlighter>
    </>
  )
}
