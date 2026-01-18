interface Props {
  size?: number
  className?: string
}

export function StopIcon({ size = 24, className = 'fill-black dark:fill-white' }: Props) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
      <title>stop-icon</title>
      <path
        fillRule='evenodd'
        clipRule='evenodd'
        d='M4 18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12z'
        className={className}
      />
    </svg>
  )
}
