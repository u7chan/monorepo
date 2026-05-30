import type { ReactNode } from 'react'

interface CompareLayoutProps {
  header: ReactNode
  modelSelector: ReactNode
  columns: ReactNode
  composer: ReactNode
  children?: ReactNode
}

export function CompareLayout({ header, modelSelector, columns, composer, children }: CompareLayoutProps) {
  return (
    <div className='flex h-[calc(100dvh-3.5rem)] flex-col bg-white md:h-dvh dark:bg-gray-900'>
      {header}
      {modelSelector}
      <div className='flex min-h-0 flex-1 overflow-x-auto'>{columns}</div>
      {composer}
      {children}
    </div>
  )
}
