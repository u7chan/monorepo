import { type IconProps, SvgIcon } from './icon-base'

export function CheckIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <path
        d='M6 12L10.2426 16.2426L18.727 7.75732'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </SvgIcon>
  )
}
