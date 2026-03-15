import { CheckIcon } from '#/client/components/svg/check-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import type { AnchorHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'

async function copyToClipboard(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
  } else {
    const input = document.createElement('textarea')
    input.value = text
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
  }
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

type CodeBlockRendererProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode | string
}

export function CodeBlockRenderer({ className, children }: CodeBlockRendererProps) {
  const isDarkMode = document.documentElement.classList.contains('dark')
  const [copied, setCopied] = useState(false)
  const code = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''
  const language = className?.split('-')[1]

  if (typeof children !== 'string' || !language) {
    return <code>{children}</code>
  }

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

  return (
    <>
      <div className='flex justify-end'>
        <button
          type='button'
          onClick={handleClickCopy}
          disabled={copied}
          className='flex cursor-pointer gap-1 align-center'
        >
          {copied ? (
            <>
              <CheckIcon size={18} className='stroke-white' />
              <span className='text-white text-xs'>コピーしました</span>
            </>
          ) : (
            <>
              <CopyIcon size={18} className='stroke-white' />
              <span className='text-white text-xs'>コピーする</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter style={isDarkMode ? atomDark : undefined} language={language}>
        {code}
      </SyntaxHighlighter>
    </>
  )
}
