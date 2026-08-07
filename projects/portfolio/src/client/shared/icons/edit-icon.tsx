import { type IconProps, SvgIcon } from './icon-base'

export function EditIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <g stroke='currentColor'>
        <path
          d='M4 20H8L18.5 9.5C19.3284 8.67157 19.3284 7.32843 18.5 6.5L17.5 5.5C16.6716 4.67157 15.3284 4.67157 14.5 5.5L4 16V20Z'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
        <path d='M13.5 6.5L17.5 10.5' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' />
      </g>
    </SvgIcon>
  )
}
