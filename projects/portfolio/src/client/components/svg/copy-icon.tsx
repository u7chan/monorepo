import { type IconProps, SvgIcon } from './icon-base'

export function CopyIcon({ size = 24, className = 'stroke-black dark:stroke-white' }: IconProps) {
  return (
    <SvgIcon size={size} title='copy-icon'>
      <path
        d='M17.5 14H19C20.1046 14 21 13.1046 21 12V5C21 3.89543 20.1046 3 19 3H12C10.8954 3 10 3.89543 10 5V6.5M5 10H12C13.1046 10 14 10.8954 14 12V19C14 20.1046 13.1046 21 12 21H5C3.89543 21 3 20.1046 3 19V12C3 10.8954 3.89543 10 5 10Z'
        className={className}
        strokeWidth='1.5'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </SvgIcon>
  )
}
