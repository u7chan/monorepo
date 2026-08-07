import { type IconProps, SvgIcon } from './icon-base'

export function SunIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <g stroke='currentColor'>
        <circle cx='12' cy='12' r='4' strokeWidth='2' strokeLinecap='round' />
        <line x1='12' y1='2' x2='12' y2='5' strokeWidth='2' strokeLinecap='round' />
        <line x1='12' y1='19' x2='12' y2='22' strokeWidth='2' strokeLinecap='round' />
        <line x1='4.22' y1='4.22' x2='6.34' y2='6.34' strokeWidth='2' strokeLinecap='round' />
        <line x1='17.66' y1='17.66' x2='19.78' y2='19.78' strokeWidth='2' strokeLinecap='round' />
        <line x1='2' y1='12' x2='5' y2='12' strokeWidth='2' strokeLinecap='round' />
        <line x1='19' y1='12' x2='22' y2='12' strokeWidth='2' strokeLinecap='round' />
        <line x1='4.22' y1='19.78' x2='6.34' y2='17.66' strokeWidth='2' strokeLinecap='round' />
        <line x1='17.66' y1='6.34' x2='19.78' y2='4.22' strokeWidth='2' strokeLinecap='round' />
      </g>
    </SvgIcon>
  )
}
