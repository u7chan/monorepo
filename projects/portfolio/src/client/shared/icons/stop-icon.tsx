import { type IconProps, SvgIcon } from './icon-base'

export function StopIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <path
        fillRule='evenodd'
        clipRule='evenodd'
        d='M4 18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12z'
        fill='currentColor'
      />
    </SvgIcon>
  )
}
