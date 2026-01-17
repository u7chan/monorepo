interface Props {
  size?: number
  className?: string
}

export function DashboardIcon({ size = 24, className = 'stroke-black dark:stroke-white' }: Props) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
      <title>dashboad-icon</title>
      <rect
        x='4'
        y='4'
        width='16'
        height='16'
        rx='2'
        strokeWidth='1'
        strokeLinecap='round'
        className={className}
        fill='none'
      />
      <line x1='4' y1='9' x2='20' y2='9' strokeWidth='1' strokeLinecap='round' className={className} />
      <line x1='9' y1='10' x2='9' y2='20' strokeWidth='1' strokeLinecap='round' className={className} />
    </svg>
  )
}
