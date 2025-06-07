import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import remarkGfm from 'remark-gfm'

interface MarkdownRendererProps {
  content: string
  className?: string
}

export function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  const components: Components = {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '')
      const language = match ? match[1] : ''
      const isInline = !String(children).includes('\n')
      return language ? (
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          PreTag='div'
          className='my-4 rounded-lg text-sm'
          wrapLines
          wrapLongLines
          showLineNumbers
          lineProps={{
            style: { display: 'flex', width: 0 },
          }}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      ) : (
        <>
          {isInline ? (
            <code
              className={`${className} rounded bg-gray-100 px-1 py-0.5 font-mono text-sm dark:bg-gray-800`}
              {...props}
            >
              {children}
            </code>
          ) : (
            <SyntaxHighlighter
              style={oneDark}
              PreTag='div'
              className='my-4 rounded-lg text-sm'
              wrapLines
              wrapLongLines
              lineProps={{
                style: { display: 'flex', width: 0 },
              }}
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          )}
        </>
      )
    },
    pre({ children }) {
      return <>{children}</>
    },
    h1({ children }) {
      return (
        <h1 className='mb-4 font-bold text-3xl text-gray-900 dark:text-gray-100'>{children}</h1>
      )
    },
    h2({ children }) {
      return (
        <h2 className='mb-3 font-semibold text-2xl text-gray-900 dark:text-gray-100'>{children}</h2>
      )
    },
    h3({ children }) {
      return (
        <h3 className='mb-2 font-semibold text-gray-900 text-xl dark:text-gray-100'>{children}</h3>
      )
    },
    h4({ children }) {
      return (
        <h4 className='mb-2 font-semibold text-gray-900 text-lg dark:text-gray-100'>{children}</h4>
      )
    },
    h5({ children }) {
      return (
        <h5 className='mb-2 font-semibold text-base text-gray-900 dark:text-gray-100'>
          {children}
        </h5>
      )
    },
    h6({ children }) {
      return (
        <h6 className='mb-2 font-semibold text-gray-900 text-sm dark:text-gray-100'>{children}</h6>
      )
    },
    p({ children }) {
      return (
        <p className='mb-4 whitespace-pre-wrap text-gray-700 leading-relaxed dark:text-gray-300'>
          {children}
        </p>
      )
    },
    ul({ children }) {
      return <ul className='mb-4 ml-6 list-disc text-gray-700 dark:text-gray-300'>{children}</ul>
    },
    ol({ children }) {
      return <ol className='mb-4 ml-6 list-decimal text-gray-700 dark:text-gray-300'>{children}</ol>
    },
    li({ children }) {
      return <li className='mb-1'>{children}</li>
    },
    blockquote({ children, ...props }) {
      return (
        <blockquote
          className='mb-4 border-gray-300 border-l-4 pl-4 text-gray-600 italic dark:border-gray-600 dark:text-gray-400'
          {...props}
        >
          {children}
        </blockquote>
      )
    },
    a({ href, children }) {
      return (
        <a
          href={href}
          className='text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300'
          target='_blank'
          rel='noopener noreferrer'
        >
          {children}
        </a>
      )
    },
    table({ children }) {
      return (
        <div className='mb-4 overflow-x-auto'>
          <table className='min-w-full border border-gray-300 dark:border-gray-600'>
            {children}
          </table>
        </div>
      )
    },
    thead({ children }) {
      return <thead className='bg-gray-50 dark:bg-gray-800'>{children}</thead>
    },
    tbody({ children }) {
      return <tbody>{children}</tbody>
    },
    tr({ children }) {
      return <tr className='border-gray-200 border-b dark:border-gray-700'>{children}</tr>
    },
    th({ children }) {
      return (
        <th className='px-4 py-2 text-left font-semibold text-gray-900 dark:text-gray-100'>
          {children}
        </th>
      )
    },
    td({ children }) {
      return <td className='px-4 py-2 text-gray-700 dark:text-gray-300'>{children}</td>
    },
    hr() {
      return <hr className='my-6 border-gray-300 dark:border-gray-600' />
    },
    strong({ children }) {
      return <strong className='font-semibold text-gray-900 dark:text-gray-100'>{children}</strong>
    },
    em({ children }) {
      return <em className='text-gray-700 italic dark:text-gray-300'>{children}</em>
    },
  }

  return (
    <div className={`prose prose-gray dark:prose-invert ${className}`}>
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
