import { type IconProps, SvgIcon } from './icon-base'

export function MoonIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <path
        d='M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'
        fill='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </SvgIcon>
  )
}
