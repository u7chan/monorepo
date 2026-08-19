import { type IconProps, SvgIcon } from './icon-base'

export function ChevronRightIcon({ size = 8, label, className, strokeWidth = 1.25, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} viewBox='0 0 8 8' label={label} className={className} {...rest}>
      <path
        d='M2.5 1.5L5.5 4L2.5 6.5'
        stroke='currentColor'
        strokeWidth={strokeWidth}
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </SvgIcon>
  )
}
