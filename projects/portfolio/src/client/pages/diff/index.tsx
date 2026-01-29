import Editor from '@monaco-editor/react'
import { useEffect, useState } from 'react'
import ReactDiffViewer from 'react-diff-viewer'
import { loadDiffState, saveDiffState } from '../../storage/diff-state'

const LANGUAGE_OPTIONS: string[] = [
  // Web / フロントエンド
  'html',
  'css',
  'javascript',
  'typescript',

  // バックエンド / 汎用
  'python',
  'java',
  'go',
  'php',
  'ruby',
  'rust',
  'cpp',
  'csharp',

  // モバイル
  'swift',
  'kotlin',

  // データベース / クエリ
  'sql',
  'mysql',
  'pgsql',

  // インフラ / DevOps
  'shell',
  'powershell',
  'dockerfile',
  'yaml',

  // その他よく使われるもの
  'graphql',
  'markdown'
]

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
  const [language, setLanguage] = useState('')
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
    <div className='h-screen flex flex-col overflow-y-auto bg-white p-4 dark:bg-gray-900'>
      <div className='mb-4 flex-none flex items-center gap-2'>
        <button
          onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}
          className='w-10 h-10 cursor-pointer rounded-sm bg-primary-800 p-2 text-white hover:bg-primary-700 dark:bg-primary-600 dark:hover:bg-primary-500 flex items-center justify-center'
        >
          {mode === 'view' ? (
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path stroke-width='2.5' d='M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 2-2v-7'></path>
              <path stroke-width='2.5' d='m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z'></path>
            </svg>
          ) : (
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path stroke-width='2.5' d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'></path>
              <circle stroke-width='2.5' cx='12' cy='12' r='3'></circle>
            </svg>
          )}
        </button>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className='px-3 py-2 rounded-sm bg-white border border-gray-300 dark:bg-gray-800 dark:border-gray-600 dark:text-white'
        >
          <option value=''>text</option>
          {LANGUAGE_OPTIONS.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
      </div>
      <div className='flex-1 min-h-0'>
        {mode === 'edit' ? (
          <div className='grid grid-cols-2 gap-4 h-full min-h-0 border rounded-xl border-gray-200 dark:border-gray-700 overflow-hidden'>
            <div className='flex flex-col h-full min-h-0 border-r border-gray-200 dark:border-gray-700'>
              <h3 className='text-lg font-semibold mb-2 dark:text-white px-4 pt-4'>Before</h3>
              <div className='flex-1 min-h-0 px-4 pb-4'>
                <Editor
                  value={beforeCode}
                  onChange={(value) => setBeforeCode(value || '')}
                  theme={isDarkTheme ? 'vs-dark' : 'light'}
                  height='100%'
                  language={language}
                />
              </div>
            </div>
            <div className='flex flex-col h-full min-h-0'>
              <h3 className='text-lg font-semibold mb-2 dark:text-white px-4 pt-4'>After</h3>
              <div className='flex-1 min-h-0 px-4 pb-4'>
                <Editor
                  value={afterCode}
                  onChange={(value) => setAfterCode(value || '')}
                  theme={isDarkTheme ? 'vs-dark' : 'light'}
                  height='100%'
                  language={language}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className='h-full border rounded-xl border-gray-200 dark:border-gray-700 overflow-hidden'>
            <ReactDiffViewer
              key={isDarkTheme ? 'diff-dark' : 'diff-light'}
              oldValue={beforeCode}
              newValue={afterCode}
              splitView={true}
              useDarkTheme={isDarkTheme}
              styles={{ contentText: { fontSize: '12px' }, lineNumber: { fontSize: '12px' } }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
