import { type IconProps, SvgIcon } from './icon-base'

interface SidebarIconProps extends IconProps {
  variant?: 'collapse' | 'expand'
}

export function SidebarIcon({
  size = 24,
  className = 'fill-black dark:fill-white',
  variant = 'collapse',
}: SidebarIconProps) {
  const arrowPath =
    variant === 'collapse'
      ? 'M15.707 8.293a1 1 0 0 1 0 1.414L13.414 12l2.293 2.293a1 1 0 0 1-1.414 1.414l-3-3a1 1 0 0 1 0-1.414l3-3a1 1 0 0 1 1.414 0Z'
      : 'M12.293 8.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414-1.414L14.586 12l-2.293-2.293a1 1 0 0 1 0-1.414Z'

  return (
    <SvgIcon size={size} title='sidebar-icon'>
      <rect width='24' height='24' fill='none' />
      {/* サイドバー領域を持つウィンドウ枠 */}
      <path
        fillRule='evenodd'
        clipRule='evenodd'
        d='M5.5 4C4.119 4 3 5.119 3 6.5v11C3 18.881 4.119 20 5.5 20h13c1.381 0 2.5-1.119 2.5-2.5v-11C21 5.119 19.881 4 18.5 4h-13ZM5 6.5C5 6.224 5.224 6 5.5 6H8v12H5.5c-.276 0-.5-.224-.5-.5v-11ZM10 18h8.5c.276 0 .5-.224.5-.5v-11c0-.276-.224-.5-.5-.5H10v12Z'
        className={className}
      />
      <path d={arrowPath} className={className} />
    </SvgIcon>
  )
}
