import { type IconProps, SvgIcon } from './icon-base'

export function HamburgerIcon({ size = 24, className = 'fill-black dark:fill-white' }: IconProps) {
  return (
    <SvgIcon size={size} title='hamburger-icon'>
      <rect width='24' height='24' fill='none' />
      <rect x='3' y='6' width='18' height='2' className={className} />
      <rect x='3' y='11' width='18' height='2' className={className} />
      <rect x='3' y='16' width='18' height='2' className={className} />
    </SvgIcon>
  )
}
