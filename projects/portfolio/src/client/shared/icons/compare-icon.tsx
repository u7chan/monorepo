import { type IconProps, SvgIcon } from './icon-base'

export function CompareIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} viewBox='0 0 16 16' label={label} className={className} {...rest}>
      <g fill='currentColor'>
        <rect x='1' y='2' width='6' height='12' rx='1' />
        <rect x='9' y='2' width='6' height='12' rx='1' />
      </g>
    </SvgIcon>
  )
}
