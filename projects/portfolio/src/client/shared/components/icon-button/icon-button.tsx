import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  label: string
  children: ReactNode
}

export function IconButton({ label, children, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={`flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500 disabled:cursor-default disabled:opacity-50${className ? ` ${className}` : ''}`}
      {...rest}
      aria-label={label}
    >
      {children}
    </button>
  )
}
