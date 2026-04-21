import type { ReactNode } from 'react'

export interface IconProps {
  size?: number
  className?: string
}

interface SvgIconProps {
  size?: number
  viewBox?: string
  title: string
  children: ReactNode
}

export function SvgIcon({ size = 24, viewBox = '0 0 24 24', title, children }: SvgIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      role='img'
      aria-label={title}
    >
      {children}
    </svg>
  )
}
