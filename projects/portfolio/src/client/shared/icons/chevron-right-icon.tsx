import { type IconProps, SvgIcon } from './icon-base'

export function ChevronRightIcon({ size = 8, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} viewBox='0 0 8 8' label={label} className={className} {...rest}>
      <path
        d='M2 1.5L5 4L2 6.5'
        stroke='currentColor'
        strokeWidth='1.25'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </SvgIcon>
  )
}
