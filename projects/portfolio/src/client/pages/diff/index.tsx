import { useEffect, useState } from 'react'
import ReactDiffViewer from 'react-diff-viewer'
import { loadDiffState, saveDiffState } from '../../storage/diff-state'

const defaultBefore = `line 1
line 2
line 3`
const defaultAfter = `line 1
modified line 2
line 3`

export function Diff() {
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [beforeCode, setBeforeCode] = useState(defaultBefore)
  const [afterCode, setAfterCode] = useState(defaultAfter)
  const [isHydrated, setIsHydrated] = useState(false)
  const [isDarkTheme, setIsDarkTheme] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }
    const saved = localStorage.getItem('theme')
    if (saved === 'dark') {
      return true
    }
    if (saved === 'light') {
      return false
    }
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    const syncTheme = () => {
      const saved = localStorage.getItem('theme')
      if (saved === 'dark') {
        setIsDarkTheme(true)
        return
      }
      if (saved === 'light') {
        setIsDarkTheme(false)
        return
      }
      setIsDarkTheme(document.documentElement.classList.contains('dark'))
    }

    syncTheme()

    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('storage', syncTheme)

    return () => {
      observer.disconnect()
      window.removeEventListener('storage', syncTheme)
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    const hydrate = async () => {
      try {
        const saved = await loadDiffState()
        if (!isMounted) {
          return
        }
        if (saved) {
          setBeforeCode(saved.beforeCode)
          setAfterCode(saved.afterCode)
        }
      } catch {
        if (!isMounted) {
          return
        }
      } finally {
        if (isMounted) {
          setIsHydrated(true)
        }
      }
    }

    hydrate()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!isHydrated) {
      return
    }

    const persist = async () => {
      await saveDiffState({ beforeCode, afterCode })
    }

    persist()
  }, [beforeCode, afterCode, isHydrated])

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
            <h3 className='text-lg font-semibold mb-2 dark:text-white'>Before</h3>
            <textarea
              value={beforeCode}
              onChange={(e) => setBeforeCode(e.target.value)}
              className='w-full h-64 p-2 border border-gray-300 rounded dark:bg-gray-800 dark:border-gray-600 dark:text-white'
              placeholder='Enter before code...'
            />
          </div>
          <div>
            <h3 className='text-lg font-semibold mb-2 dark:text-white'>After</h3>
            <textarea
              value={afterCode}
              onChange={(e) => setAfterCode(e.target.value)}
              className='w-full h-64 p-2 border border-gray-300 rounded dark:bg-gray-800 dark:border-gray-600 dark:text-white'
              placeholder='Enter after code...'
            />
          </div>
        </div>
      ) : (
        <ReactDiffViewer
          key={isDarkTheme ? 'diff-dark' : 'diff-light'}
          oldValue={beforeCode}
          newValue={afterCode}
          splitView={true}
          useDarkTheme={isDarkTheme}
          styles={{ contentText: { fontSize: '14px' }, lineNumber: { fontSize: '14px' } }}
        />
      )}
    </div>
  )
}
