import { useId } from 'react'
import { type IconProps, SvgIcon } from './icon-base'

export function SpinnerIcon({ size = 32, label, className, ...rest }: IconProps) {
  const gradientId = useId()
  return (
    <SvgIcon
      size={size}
      label={label}
      className={`animate-spin motion-reduce:animate-none ${className ?? ''}`}
      {...rest}
    >
      <defs>
        <linearGradient id={gradientId} x1='0%' y1='0%' x2='100%' y2='100%'>
          <stop offset='0%' style={{ stopColor: '#6B7280', stopOpacity: 0.25 }} />
          <stop offset='100%' style={{ stopColor: '#9CA3AF', stopOpacity: 0.25 }} />
        </linearGradient>
      </defs>

      <circle cx='12' cy='12' r='10' stroke={`url(#${gradientId})`} strokeWidth='4' />

      <path
        className='text-blue-500 dark:text-blue-400'
        d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
        fill='currentColor'
      />
    </SvgIcon>
  )
}
