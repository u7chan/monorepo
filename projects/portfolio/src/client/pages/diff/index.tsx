import ReactDiffViewer from 'react-diff-viewer'
import { useEffect, useState } from 'react'

export function Diff() {
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [oldCode, setOldCode] = useState(`line 1
line 2
line 3`)
  const [newCode, setNewCode] = useState(`line 1
modified line 2
line 3`)
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

  return (
    <div className='h-screen overflow-y-auto bg-white p-4 dark:bg-gray-900'>
      <div className='mb-4'>
        <button
          onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}
          className='px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 dark:bg-blue-700 dark:hover:bg-blue-800'
        >
          {mode === 'view' ? 'Edit' : 'View Diff'}
        </button>
      </div>
      {mode === 'edit' ? (
        <div className='grid grid-cols-2 gap-4'>
          <div>
            <h3 className='text-lg font-semibold mb-2'>Old Code</h3>
            <textarea
              value={oldCode}
              onChange={(e) => setOldCode(e.target.value)}
              className='w-full h-64 p-2 border border-gray-300 rounded dark:bg-gray-800 dark:border-gray-600 dark:text-white'
              placeholder='Enter old code...'
            />
          </div>
          <div>
            <h3 className='text-lg font-semibold mb-2'>New Code</h3>
            <textarea
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className='w-full h-64 p-2 border border-gray-300 rounded dark:bg-gray-800 dark:border-gray-600 dark:text-white'
              placeholder='Enter new code...'
            />
          </div>
        </div>
      ) : (
        <ReactDiffViewer oldValue={oldCode} newValue={newCode} splitView={true} useDarkTheme={isDarkTheme} />
      )}
    </div>
  )
}