import { type IconProps, SvgIcon } from './icon-base'

export function ChevronRightIcon({ size = 8, className = 'stroke-current' }: IconProps) {
  return (
    <SvgIcon size={size} title='chevron-right-icon' viewBox='0 0 8 8'>
      <path
        d='M2 1.5L5 4L2 6.5'
        strokeWidth='1.25'
        strokeLinecap='round'
        strokeLinejoin='round'
        className={className}
      />
    </SvgIcon>
  )
}
