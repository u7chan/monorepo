import { type IconProps, SvgIcon } from './icon-base'

export function CompareIcon({ size = 24, className = 'fill-black dark:fill-white' }: IconProps) {
  return (
    <SvgIcon size={size} viewBox='0 0 16 16' title='compare-icon'>
      <g className={className}>
        <rect x='1' y='2' width='6' height='12' rx='1' />
        <rect x='9' y='2' width='6' height='12' rx='1' />
      </g>
    </SvgIcon>
  )
}
