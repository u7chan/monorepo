import { type IconProps, SvgIcon } from './icon-base'

export function EyeIcon({ size = 24, className = 'stroke-black dark:stroke-white' }: IconProps) {
  return (
    <SvgIcon size={size} title='eye-icon'>
      <path
        d='M2.25 12C2.25 12 5.25 5.25 12 5.25C18.75 5.25 21.75 12 21.75 12C21.75 12 18.75 18.75 12 18.75C5.25 18.75 2.25 12 2.25 12Z'
        className={className}
        strokeWidth='1.5'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
      <path
        d='M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z'
        className={className}
        strokeWidth='1.5'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </SvgIcon>
  )
}
