import { type IconProps, SvgIcon } from './icon-base'

export function CheckIcon({ size = 24, className = 'stroke-black dark:stroke-white' }: IconProps) {
  return (
    <SvgIcon size={size} title='check-icon'>
      <path
        id='Vector'
        d='M6 12L10.2426 16.2426L18.727 7.75732'
        className={className}
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </SvgIcon>
  )
}
