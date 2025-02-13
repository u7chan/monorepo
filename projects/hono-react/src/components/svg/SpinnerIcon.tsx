interface Props {
  color?: string
}

export function SpinnerIcon({ color = '#4299e1' }: Props) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      className='h-8 w-8 animate-spin'
    >
      <title>spinner-icon</title>
      {/* グラデーションの定義 */}
      <defs>
        <linearGradient id='gradient' x1='0%' y1='0%' x2='100%' y2='100%'>
          <stop offset='0%' style={{ stopColor: '#6B7280', stopOpacity: 0.25 }} />
          <stop offset='100%' style={{ stopColor: '#9CA3AF', stopOpacity: 0.25 }} />
        </linearGradient>
      </defs>

      {/* グラデーションを適用した円 */}
      <circle cx='12' cy='12' r='10' stroke='url(#gradient)' strokeWidth='4' />

      {/* 回転する部分 */}
      <path
        fill={color}
        d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
      />
    </svg>
  )
}
