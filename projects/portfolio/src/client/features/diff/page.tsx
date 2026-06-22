import './monaco'
import Editor from '@monaco-editor/react'
import type { ComponentType } from 'react'
import { useRef, useState } from 'react'
import ReactDiffViewerModule from 'react-diff-viewer'
import { useDarkMode } from '#/client/shared/hooks/use-dark-mode'
import { useMobileLayout } from '#/client/shared/hooks/use-mobile-layout'
import { type DiffStatePayload, saveDiffState } from '#/client/shared/storage/diff-state'

const reactDiffViewerImport = ReactDiffViewerModule as ComponentType<any> | { default: ComponentType<any> }
const ReactDiffViewer =
  typeof reactDiffViewerImport === 'function' ? reactDiffViewerImport : reactDiffViewerImport.default

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
  'markdown',
]

const diffViewerStyles = {
  variables: {
    light: {
      diffViewerBackground: '#ffffff',
      diffViewerColor: '#111827',
      addedBackground: '#f2fbf5',
      addedColor: '#111827',
      removedBackground: '#fdf2f3',
      removedColor: '#111827',
      wordAddedBackground: '#cfeedd',
      wordRemovedBackground: '#f5d3d8',
      addedGutterBackground: '#ddf5e6',
      removedGutterBackground: '#f8dfe3',
      gutterBackground: '#f8fafc',
      gutterBackgroundDark: '#f1f5f9',
      highlightBackground: '#f6f1cf',
      highlightGutterBackground: '#ede4ab',
      diffViewerTitleBackground: '#f8fafc',
      diffViewerTitleBorderColor: '#e5e7eb',
    },
    dark: {
      diffViewerBackground: '#111827',
      diffViewerColor: '#f3f4f6',
      addedBackground: '#12372f',
      addedColor: '#f9fafb',
      removedBackground: '#4a252c',
      removedColor: '#f9fafb',
      wordAddedBackground: '#1b5a4c',
      wordRemovedBackground: '#733b46',
      addedGutterBackground: '#163f37',
      removedGutterBackground: '#542b32',
      gutterBackground: '#172033',
      gutterBackgroundDark: '#1e293b',
      highlightBackground: '#3d3620',
      highlightGutterBackground: '#504726',
      diffViewerTitleBackground: '#172033',
      diffViewerTitleBorderColor: '#273449',
      diffViewerTitleColor: '#d1d5db',
      gutterColor: '#94a3b8',
      addedGutterColor: '#cbd5e1',
      removedGutterColor: '#cbd5e1',
      codeFoldContentColor: '#d1d5db',
      emptyLineBackground: '#0f172a',
    },
  },
  diffContainer: {
    pre: {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
      fontSize: '13px',
      lineHeight: '1.45',
      fontVariantLigatures: 'none',
      tabSize: 2,
    },
  },
  contentText: {
    fontSize: '13px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
    letterSpacing: '0',
  },
  codeFoldContent: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
  },
  lineNumber: {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
  },
  marker: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
  },
  wordDiff: {
    display: 'inline',
    padding: '0 1px',
    borderRadius: 0,
    lineHeight: 'inherit',
  },
}

type DiffProps = {
  initialState: DiffStatePayload
}

export function Diff({ initialState }: DiffProps) {
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [beforeCode, setBeforeCode] = useState(initialState.beforeCode)
  const [afterCode, setAfterCode] = useState(initialState.afterCode)
  const [language, setLanguage] = useState('')
  const beforeCodeRef = useRef(beforeCode)
  const afterCodeRef = useRef(afterCode)
  const isMobile = useMobileLayout()
  const isDarkTheme = useDarkMode()

  const handleBeforeCodeChange = (value: string | undefined) => {
    const nextBeforeCode = value ?? ''
    beforeCodeRef.current = nextBeforeCode
    setBeforeCode(nextBeforeCode)
    void saveDiffState({ beforeCode: nextBeforeCode, afterCode: afterCodeRef.current }).catch(() => undefined)
  }

  const handleAfterCodeChange = (value: string | undefined) => {
    const nextAfterCode = value ?? ''
    afterCodeRef.current = nextAfterCode
    setAfterCode(nextAfterCode)
    void saveDiffState({ beforeCode: beforeCodeRef.current, afterCode: nextAfterCode }).catch(() => undefined)
  }

  return (
    <div className='h-screen flex flex-col bg-white p-4 dark:bg-gray-900 overflow-hidden'>
      <div className='mb-4 flex-none flex items-center gap-2'>
        <button
          onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}
          className='w-10 h-10 cursor-pointer rounded-sm bg-primary-800 p-2 text-white hover:bg-primary-700 dark:bg-primary-600 dark:hover:bg-primary-500 flex items-center justify-center'
        >
          {mode === 'view' ? (
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path strokeWidth='2.5' d='M11 4H4a2 2 0 0 0 -2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2 -2v-7'></path>
              <path strokeWidth='2.5' d='m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z'></path>
            </svg>
          ) : (
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path strokeWidth='2.5' d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'></path>
              <circle strokeWidth='2.5' cx='12' cy='12' r='3'></circle>
            </svg>
          )}
        </button>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          disabled={mode === 'view'}
          className='px-3 py-2 rounded-sm bg-white border border-gray-300 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-800 dark:border-gray-600 dark:text-white'
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
          <div className='grid grid-cols-1 md:grid-cols-2 h-[calc(100dvh-120px)] min-h-[200px] md:min-h-[300px] border rounded-xl border-gray-200 dark:border-gray-700 overflow-hidden'>
            <div className='flex flex-col h-full min-h-0 md:border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'>
              <div className='border-b border-gray-200 bg-slate-50 px-3 py-2.5 dark:border-gray-700 dark:bg-slate-800/70'>
                <h3 className='font-mono text-[13px] leading-[1.45] font-normal text-gray-900 dark:text-gray-100'>
                  Before
                </h3>
              </div>
              <div className='flex-1 min-h-0'>
                <Editor
                  value={beforeCode}
                  onChange={handleBeforeCodeChange}
                  theme={isDarkTheme ? 'vs-dark' : 'light'}
                  height='100%'
                  language={language}
                />
              </div>
            </div>
            <div className='flex flex-col h-full min-h-0 bg-white dark:bg-gray-900'>
              <div className='border-b border-gray-200 bg-slate-50 px-3 py-2.5 dark:border-gray-700 dark:bg-slate-800/70'>
                <h3 className='font-mono text-[13px] leading-[1.45] font-normal text-gray-900 dark:text-gray-100'>
                  After
                </h3>
              </div>
              <div className='flex-1 min-h-0'>
                <Editor
                  value={afterCode}
                  onChange={handleAfterCodeChange}
                  theme={isDarkTheme ? 'vs-dark' : 'light'}
                  height='100%'
                  language={language}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className='h-[calc(100dvh-120px)] min-h-[200px] md:min-h-[300px] border rounded-xl border-gray-200 dark:border-gray-700 overflow-y-auto'>
            <ReactDiffViewer
              key={isDarkTheme ? 'diff-dark' : 'diff-light'}
              oldValue={beforeCode}
              newValue={afterCode}
              leftTitle='Before'
              rightTitle='After'
              splitView={!isMobile}
              useDarkTheme={isDarkTheme}
              styles={diffViewerStyles}
            />
          </div>
        )}
      </div>
    </div>
  )
}
