interface Props {
  width?: number | string
  height?: number | string
}

export function HamburgerIcon({ width, height }: Props) {
  return (
    <svg
      width={width || '24'}
      height={height || '24'}
      viewBox='0 0 24 24'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
    >
      <title>hamburger-icon</title>
      <rect width='24' height='24' fill='none' />
      <rect x='3' y='6' width='18' height='2' fill='currentColor' />
      <rect x='3' y='11' width='18' height='2' fill='currentColor' />
      <rect x='3' y='16' width='18' height='2' fill='currentColor' />
    </svg>
  )
}
