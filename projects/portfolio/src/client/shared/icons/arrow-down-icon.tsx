import { type IconProps, SvgIcon } from './icon-base'

export function ArrowDownIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <path
        d='M12 4V20M12 20L5 13M12 20L19 13'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </SvgIcon>
  )
}
