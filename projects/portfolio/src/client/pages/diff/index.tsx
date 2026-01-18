import ReactDiffViewer from 'react-diff-viewer'
import { useEffect, useState } from 'react'

export function Diff() {
  const [isDarkTheme, setIsDarkTheme] = useState(
    typeof window !== 'undefined' ? document.documentElement.classList.contains('dark') : false
  )

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkTheme(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const oldCode = `line 1
line 2
line 3`

  const newCode = `line 1
modified line 2
line 3`

  return (
    <div className='h-screen overflow-y-auto bg-white p-4 dark:bg-gray-900'>
      <ReactDiffViewer oldValue={oldCode} newValue={newCode} splitView={true} useDarkTheme={isDarkTheme} />
    </div>
  )
}