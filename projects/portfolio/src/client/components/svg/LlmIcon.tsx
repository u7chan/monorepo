interface Props {
  size?: number
  className?: string
}

export function LlmIcon({ size = 24, className = 'stroke-black dark:stroke-white' }: Props) {
  return (
    <svg
      xmlns='http://www.w3.org/2000/svg'
      width={size}
      height={size}
      viewBox='0 0 400 400'
      fill='none'
      className={className}
      aria-labelledby='title'
      role='img'
    >
      <title>llm-icon</title>
      <path
        fillRule='evenodd'
        clipRule='evenodd'
        d='M116.516 301.844C115.072 306.702 126.563 314.386 128.359 314.386C132.356 314.386 189.276 196.908 196.846 185.779C175.278 216.653 117.779 297.595 116.516 301.844Z'
        stroke='currentColor'
        strokeOpacity={0.9}
        strokeWidth={16}
        strokeLinecap='round'
        strokeLinejoin='round'
      />
      <path
        opacity={0.651739}
        d='M197.001 169.213C145.834 172.832 195.671 158.171 195.671 142.64C195.671 134.465 185.695 125.185 185.695 114.99C185.695 107.057 212.475 126.765 216.624 123.965C219.603 121.957 246.451 94.2833 248.103 100.523C252.259 116.23 238.751 140.846 240.423 142.64C243.642 146.095 268.009 163.006 265.508 167.058C259.861 176.207 226.387 156.045 227.598 171.727C227.813 174.525 225.458 210.785 223.94 210.509C214.477 208.808 214.046 181.559 209.308 173.883'
        stroke='currentColor'
        strokeOpacity={0.9}
        strokeWidth={16}
        strokeLinecap='round'
        strokeLinejoin='round'
      />
      <path
        opacity={0.503384}
        d='M161.298 145.468C154.054 145.26 146.554 145.998 139.51 144.471'
        stroke='currentColor'
        strokeOpacity={0.9}
        strokeWidth={16}
        strokeLinecap='round'
        strokeLinejoin='round'
      />
      <path
        opacity={0.503384}
        d='M204.873 95.5062C204.001 91.8584 202.117 88.7781 200.286 85.6133'
        stroke='currentColor'
        strokeOpacity={0.9}
        strokeWidth={16}
        strokeLinecap='round'
        strokeLinejoin='round'
      />
      <path
        opacity={0.503384}
        d='M270.239 135.078C274.541 131.762 278.884 129.373 284 128.895'
        stroke='#000000'
        strokeOpacity={0.9}
        strokeWidth={16}
        strokeLinecap='round'
        strokeLinejoin='round'
      />
      <path
        opacity={0.503384}
        d='M251.89 210.511C254.235 215.132 256.06 219.692 259.917 222.877'
        stroke='#000000'
        strokeOpacity={0.9}
        strokeWidth={16}
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  )
}
