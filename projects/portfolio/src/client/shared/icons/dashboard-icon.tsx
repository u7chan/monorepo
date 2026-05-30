import { type IconProps, SvgIcon } from './icon-base'

export function DashboardIcon({ size = 24, className = 'stroke-black dark:stroke-white' }: IconProps) {
  return (
    <SvgIcon size={size} title='dashboad-icon'>
      <rect
        x='4'
        y='4'
        width='16'
        height='16'
        rx='2'
        strokeWidth='1'
        strokeLinecap='round'
        className={className}
        fill='none'
      />
      <line x1='4' y1='9' x2='20' y2='9' strokeWidth='1' strokeLinecap='round' className={className} />
      <line x1='9' y1='10' x2='9' y2='20' strokeWidth='1' strokeLinecap='round' className={className} />
    </SvgIcon>
  )
}
