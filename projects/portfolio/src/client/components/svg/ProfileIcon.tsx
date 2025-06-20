interface Props {
  size?: number
  className?: string
}

export function ProfileIcon({ size = 24, className = 'fill-black' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 32 32'
      xmlns='http://www.w3.org/2000/svg'
      className={className}
    >
      <title>profile-icon</title>
      <g id='about'>
        <path d='M16,16A7,7,0,1,0,9,9,7,7,0,0,0,16,16ZM16,4a5,5,0,1,1-5,5A5,5,0,0,1,16,4Z' />
        <path d='M17,18H15A11,11,0,0,0,4,29a1,1,0,0,0,1,1H27a1,1,0,0,0,1-1A11,11,0,0,0,17,18ZM6.06,28A9,9,0,0,1,15,20h2a9,9,0,0,1,8.94,8Z' />
      </g>
    </svg>
  )
}
