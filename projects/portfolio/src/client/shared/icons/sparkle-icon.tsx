import { type IconProps, SvgIcon } from './icon-base'

export function SparkleIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      <g stroke='currentColor'>
        <path
          d='M12 3V7M12 17V21M5 12H3M21 12H19M6.34 6.34L4.93 4.93M19.07 19.07L17.66 17.66M6.34 17.66L4.93 19.07M19.07 4.93L17.66 6.34'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
        <path
          d='M12 8.5L13.2 10.8L15.5 12L13.2 13.2L12 15.5L10.8 13.2L8.5 12L10.8 10.8L12 8.5Z'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </g>
    </SvgIcon>
  )
}
