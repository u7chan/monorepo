import { useEffect, useState } from 'react'
import ReactDiffViewer from 'react-diff-viewer'

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
          className='w-10 h-10 cursor-pointer rounded-sm bg-primary-800 p-2 text-white hover:bg-primary-700 dark:bg-primary-600 dark:hover:bg-primary-500 flex items-center justify-center'
        >
          {mode === 'view' ? (
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path stroke-width='2.5' d='M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'></path>
              <path stroke-width='2.5' d='m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z'></path>
            </svg>
          ) : (
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path stroke-width='2.5' d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'></path>
              <circle stroke-width='2.5' cx='12' cy='12' r='3'></circle>
            </svg>
          )}
        </button>
      </div>
      {mode === 'edit' ? (
        <div className='grid grid-cols-2 gap-4'>
          <div>
            <h3 className='text-lg font-semibold mb-2 dark:text-white'>Old Code</h3>
            <textarea
              value={oldCode}
              onChange={(e) => setOldCode(e.target.value)}
              className='w-full h-64 p-2 border border-gray-300 rounded dark:bg-gray-800 dark:border-gray-600 dark:text-white'
              placeholder='Enter old code...'
            />
          </div>
          <div>
            <h3 className='text-lg font-semibold mb-2 dark:text-white'>New Code</h3>
            <textarea
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className='w-full h-64 p-2 border border-gray-300 rounded dark:bg-gray-800 dark:border-gray-600 dark:text-white'
              placeholder='Enter new code...'
            />
          </div>
        </div>
      ) : (
        <ReactDiffViewer
          oldValue={oldCode}
          newValue={newCode}
          splitView={true}
          useDarkTheme={isDarkTheme}
          styles={{ contentText: { fontSize: '14px' }, lineNumber: { fontSize: '14px' } }}
        />
      )}
    </div>
  )
}
