'use client'

interface JumpToLatestButtonProps {
  showJumpButton: boolean
  isNearBottom: boolean
  onClick: () => void
}

export function JumpToLatestButton({ showJumpButton, isNearBottom, onClick }: JumpToLatestButtonProps) {
  if (!showJumpButton || isNearBottom) return null

  return (
    <button
      type='button'
      onClick={onClick}
      className='bg-secondary absolute right-4 bottom-4 rounded-full px-3 py-2 text-xs font-medium shadow-md transition hover:opacity-90'
    >
      Jump to latest
    </button>
  )
}
