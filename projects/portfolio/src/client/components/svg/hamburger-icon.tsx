interface Props {
  size?: number
  className?: string
}

export function HamburgerIcon({ size = 24, className = 'fill-black dark:fill-white' }: Props) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
      <title>hamburger-icon</title>
      <rect width='24' height='24' fill='none' />
      <rect x='3' y='6' width='18' height='2' className={className} />
      <rect x='3' y='11' width='18' height='2' className={className} />
      <rect x='3' y='16' width='18' height='2' className={className} />
    </svg>
  )
}
