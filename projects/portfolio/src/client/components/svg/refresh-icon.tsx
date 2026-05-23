import { type IconProps, SvgIcon } from './icon-base'

export function RefreshIcon({ size = 24, className = 'fill-black dark:fill-white' }: IconProps) {
  return (
    <SvgIcon size={size} title='refresh-icon'>
      <path
        fillRule='evenodd'
        clipRule='evenodd'
        d='M4 12a8 8 0 0 1 12.93-6.146l-1.065 1.065A6 6 0 1 0 18 12h-3l3.707 3.707a1 1 0 0 0 1.414 0L23.83 12H19a10 10 0 1 1-15-7.071V1a1 1 0 0 1 2 0v4a1 1 0 0 1-1 1H1a1 1 0 0 1 0-2h3.343A8 8 0 0 1 4 12z'
        className={className}
      />
    </SvgIcon>
  )
}
