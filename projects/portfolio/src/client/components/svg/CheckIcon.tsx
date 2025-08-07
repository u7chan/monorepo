interface Props {
  size?: number
  className?: string
}

export function CheckIcon({ size = 24, className = 'stroke-black dark:stroke-white' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
    >
      <title>check-icon</title>
      <path
        id='Vector'
        d='M6 12L10.2426 16.2426L18.727 7.75732'
        className={className}
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  )
}
