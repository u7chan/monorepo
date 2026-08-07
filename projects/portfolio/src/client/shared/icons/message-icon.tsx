import { type IconProps, SvgIcon } from './icon-base'

export function MessageIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <g stroke='currentColor'>
        <path
          d='M5 6.5C5 5.67157 5.67157 5 6.5 5H17.5C18.3284 5 19 5.67157 19 6.5V13.5C19 14.3284 18.3284 15 17.5 15H11.2L8 18V15H6.5C5.67157 15 5 14.3284 5 13.5V6.5Z'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
        <path d='M8 8.5H16' strokeWidth='1.5' strokeLinecap='round' />
        <path d='M8 11.5H13' strokeWidth='1.5' strokeLinecap='round' />
      </g>
    </SvgIcon>
  )
}
