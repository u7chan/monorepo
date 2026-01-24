'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

interface DebugMessagesOverlayProps {
  messagesJson: string
  messageCount: number
}

export function DebugMessagesOverlay({ messagesJson, messageCount }: DebugMessagesOverlayProps) {
  const [position, setPosition] = useState({ x: 32, y: 72 })
  const [dragging, setDragging] = useState(false)
  const originRef = useRef(position)
  const startRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    if (!dragging) {
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dx = event.clientX - startRef.current.x
      const dy = event.clientY - startRef.current.y
      setPosition({ x: originRef.current.x + dx, y: originRef.current.y + dy })
    }

    const stopDrag = () => setDragging(false)

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopDrag)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopDrag)
    }
  }, [dragging])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    startRef.current = { x: event.clientX, y: event.clientY }
    originRef.current = position
    setDragging(true)
  }

  if (!messagesJson) {
    return null
  }

  return (
    <div
      className='fixed z-[9999] max-w-[calc(100vw-40px)] rounded-2xl border border-white/30 bg-slate-900/70 p-3 text-slate-200 shadow-lg backdrop-blur-lg'
      style={{ top: position.y, left: position.x, width: 320, maxHeight: '50vh' }}
    >
      <div
        className='mb-1 flex cursor-grab items-center gap-2 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-300'
        onPointerDown={startDrag}
      >
        <svg width='10' height='10' viewBox='0 0 10 10' aria-hidden='true'>
          <rect x='1' y='1' width='2' height='2' className='fill-current text-slate-300/80' />
          <rect x='1' y='4' width='2' height='2' className='fill-current text-slate-300/60' />
          <rect x='1' y='7' width='2' height='2' className='fill-current text-slate-300/40' />
          <rect x='4' y='1' width='2' height='2' className='fill-current text-slate-300/80' />
          <rect x='4' y='4' width='2' height='2' className='fill-current text-slate-300/60' />
          <rect x='4' y='7' width='2' height='2' className='fill-current text-slate-300/40' />
        </svg>
        Debug Messages ({messageCount})
      </div>
      <pre className='max-h-[calc(50vh-40px)] overflow-auto text-[11px] leading-snug'>{messagesJson}</pre>
    </div>
  )
}
