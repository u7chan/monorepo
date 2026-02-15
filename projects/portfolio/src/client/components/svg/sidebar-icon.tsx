interface Props {
  size?: number
  className?: string
}

export function SidebarIcon({ size = 24, className = 'fill-black dark:fill-white' }: Props) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
      <title>sidebar-icon</title>
      <rect width='24' height='24' fill='none' />
      {/* 左側のパネル */}
      <rect x='3' y='5' width='6' height='14' rx='1.5' className={className} />
      {/* 右側のコンテンツエリアを表す2本の線 */}
      <rect x='12' y='5' width='9' height='2' rx='1' className={className} />
      <rect x='12' y='10' width='7' height='2' rx='1' className={className} />
      <rect x='12' y='15' width='9' height='2' rx='1' className={className} />
    </svg>
  )
}
