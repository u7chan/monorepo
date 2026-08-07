import { type IconProps, SvgIcon } from './icon-base'

export function HamburgerIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <rect width='24' height='24' fill='none' />
      <rect x='3' y='6' width='18' height='2' fill='currentColor' />
      <rect x='3' y='11' width='18' height='2' fill='currentColor' />
      <rect x='3' y='16' width='18' height='2' fill='currentColor' />
    </SvgIcon>
  )
}
