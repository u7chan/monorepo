import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type IconProps = Omit<ComponentPropsWithoutRef<'svg'>, 'children' | 'width' | 'height' | 'aria-label'> & {
  size?: number | string
  label?: string
}

interface SvgIconProps extends IconProps {
  viewBox?: string
  children: ReactNode
}

export function SvgIcon({ size = 24, viewBox = '0 0 24 24', label, children, className, ...rest }: SvgIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      {...rest}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  )
}
