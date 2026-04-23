import { type IconProps, SvgIcon } from './icon-base'

export function ArrowDownIcon({ size = 24, className = 'stroke-current' }: IconProps) {
  return (
    <SvgIcon size={size} title='arrow-down-icon'>
      <path
        d='M12 4V20M12 20L5 13M12 20L19 13'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
        className={className}
      />
    </SvgIcon>
  )
}
