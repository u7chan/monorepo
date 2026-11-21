import type { AnchorHTMLAttributes, MouseEvent } from 'react'

type MarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>

export function MarkdownLink({ href, children, ...props }: MarkdownLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (!href) {
      return
    }
    if (href.startsWith('http')) {
      window.open(href, '_blank', 'noopener,noreferrer')
    } else {
      window.location.href = href
    }
  }

  return (
    <a
      {...props}
      href={href}
      rel='noopener noreferrer'
      onClick={handleClick}
      className='text-primary-800 underline dark:text-primary-400'
    >
      {children}
    </a>
  )
}
