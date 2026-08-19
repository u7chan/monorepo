import { hc } from 'hono/client'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { IconButton } from '#/client/shared/components/icon-button/icon-button'
import { CheckIcon } from '#/client/shared/icons/check-icon'
import { ChevronRightIcon } from '#/client/shared/icons/chevron-right-icon'
import { CopyIcon } from '#/client/shared/icons/copy-icon'
import { copyToClipboard } from '#/client/shared/lib/copy-to-clipboard'
import type { AppType } from '#/server/app.d'
import type {
  DatabaseSystemStatus,
  FileServerApiSystemStatus,
  SystemCheck,
  SystemStatus,
  SystemStatusReason,
} from '#/types'

const client = hc<AppType>('/')

const COLLAPSED_STORAGE_KEY = 'portfolio.system-status-widget.collapsed'

function readCollapsedFromLocalStorage(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeCollapsedToLocalStorage(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed))
  } catch {
    // ストレージが利用できない場合は永続化を諦める（表示のみ切り替え）
  }
}

type SystemStatusEndpoint = {
  $get: (options?: { query?: { refresh?: string } }) => Promise<Response>
}

const systemStatusEndpoint = (client.api as unknown as { 'system-status'?: SystemStatusEndpoint })['system-status']

const reasonLabels: Record<SystemStatusReason, string> = {
  ok: '応答あり',
  'not-configured': '設定なし',
  timeout: 'タイムアウト',
  'connection-failed': '接続失敗',
  'schema-check-failed': 'スキーマ確認失敗',
  'database-unavailable': 'データベース利用不可',
  'healthz-unavailable': 'ヘルスチェック失敗',
  'login-failed': 'ログイン失敗',
  'read-failed': '読み取り失敗',
  'file-server-api-unavailable': 'API利用不可',
  'public-unavailable': '公開配信不可',
  'check-failed': '確認失敗',
}

function getStatusLabel(status: SystemCheck['status']): string {
  if (status === 'ok') return '正常'
  if (status === 'not-configured') return '未設定'
  return '異常'
}

function getReasonLabel(reason: SystemStatusReason): string {
  return reasonLabels[reason] ?? '確認失敗'
}

function formatCheckedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '不明'

  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date)
}

type SystemStatusCopyInput = Omit<SystemStatus, 'checks'> & {
  checks?: {
    database?: Omit<DatabaseSystemStatus, 'connection' | 'schema'> & {
      connection?: SystemCheck
      schema?: SystemCheck
    }
    fileServerHealth?: SystemCheck
    fileServerApi?: Omit<FileServerApiSystemStatus, 'login' | 'read'> & {
      login?: SystemCheck
      read?: SystemCheck
    }
    fileServerPublic?: SystemCheck
  }
}

function formatCheckDetails(check: SystemCheck): string {
  return [`- status: ${check.status}`, `- reason: ${check.reason}`, `- checkedAt: ${check.checkedAt}`].join('\n')
}

function formatCheckSection(
  label: string,
  check: SystemCheck | undefined,
  nested: readonly [string, SystemCheck | undefined][] = []
): string | null {
  if (!check) return null

  return [
    `### ${label}`,
    formatCheckDetails(check),
    ...nested.flatMap(([nestedLabel, nestedCheck]) =>
      nestedCheck ? [`#### ${nestedLabel}`, formatCheckDetails(nestedCheck)] : []
    ),
  ].join('\n\n')
}

export function formatSystemStatusForCopy(status: SystemStatusCopyInput): string {
  const checks = status.checks
  const sections = [
    formatCheckSection('PostgreSQL (`checks.database`)', checks?.database, [
      ['connection', checks?.database?.connection],
      ['schema', checks?.database?.schema],
    ]),
    formatCheckSection('file-server 稼働 (`checks.fileServerHealth`)', checks?.fileServerHealth),
    formatCheckSection('file-server API (`checks.fileServerApi`)', checks?.fileServerApi, [
      ['login', checks?.fileServerApi?.login],
      ['read', checks?.fileServerApi?.read],
    ]),
    formatCheckSection('公開URL (`checks.fileServerPublic`)', checks?.fileServerPublic),
  ].filter((section): section is string => section !== null)

  const lines = ['# System status', `- status: ${status.status}`, `- checkedAt: ${status.checkedAt}`]
  if (sections.length > 0) {
    lines.push('', '## Checks', '', sections.join('\n\n'))
  }

  return `${lines.join('\n')}\n`
}

function CheckRow({ label, check }: { label: string; check: SystemCheck }) {
  const isHealthy = check.status === 'ok'
  return (
    <div className='flex items-start justify-between gap-3 text-xs'>
      <span className='text-gray-700 dark:text-gray-300'>{label}</span>
      <span
        className={`text-right ${isHealthy ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
      >
        {getStatusLabel(check.status)}（{getReasonLabel(check.reason)}）
      </span>
    </div>
  )
}

type CopyState = 'idle' | 'copying' | 'copied'

export function SystemStatusWidget() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [copyError, setCopyError] = useState(false)
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsedFromLocalStorage())
  const requestRef = useRef<AbortController | null>(null)
  const detailsId = useId()

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      writeCollapsedToLocalStorage(next)
      return next
    })
  }, [])

  const loadStatus = useCallback(async (refresh: boolean) => {
    if (!systemStatusEndpoint) return

    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError(false)
    setCopyError(false)

    try {
      const response = await systemStatusEndpoint.$get(refresh ? { query: { refresh: '1' } } : undefined)
      if (!response.ok) {
        throw new Error('system status request failed')
      }

      const nextStatus = (await response.json()) as SystemStatus
      if (!nextStatus || !nextStatus.checks) {
        throw new Error('system status response is invalid')
      }
      setStatus(nextStatus)
    } catch {
      if (!controller.signal.aborted) {
        setError(true)
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadStatus(false)
    return () => requestRef.current?.abort()
  }, [loadStatus])

  useEffect(() => {
    if (copyState !== 'copied') return

    const timer = setTimeout(() => setCopyState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [copyState])

  const handleCopy = useCallback(async () => {
    if (!status || loading || copyState !== 'idle') return

    setCopyError(false)
    setCopyState('copying')
    try {
      await copyToClipboard(formatSystemStatusForCopy(status))
      setCopyState('copied')
    } catch {
      setCopyState('idle')
      setCopyError(true)
    }
  }, [copyState, loading, status])

  const isHealthy = status?.status === 'ok'
  const copyLabel = copyState === 'copied' ? 'コピー済み' : copyState === 'copying' ? 'コピー中…' : 'ステータスをコピー'
  const database = status?.checks.database
  const fileServerHealth = status?.checks.fileServerHealth
  const fileServerApi = status?.checks.fileServerApi
  const fileServerPublic = status?.checks.fileServerPublic

  return (
    <section
      aria-label='システム状態'
      className='fixed right-2 bottom-2 z-40 w-[calc(100%-1rem)] max-w-xs rounded-lg border border-gray-200 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-800/95 sm:right-4 sm:bottom-4'
    >
      <div className='flex items-center justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-1'>
          <IconButton
            label={collapsed ? '展開する' : '折りたたむ'}
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={detailsId}
            className='h-8 w-8 shrink-0 rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'
          >
            <span
              aria-hidden='true'
              className={`inline-flex transition-transform duration-200 ease-out motion-reduce:transition-none ${
                collapsed ? '' : 'rotate-90'
              }`}
            >
              <ChevronRightIcon size={16} />
            </span>
          </IconButton>
          <span
            aria-hidden='true'
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              isHealthy ? 'bg-green-500' : status ? 'bg-red-500' : 'bg-gray-400'
            }`}
          />
          <h2 className='truncate font-semibold text-gray-900 text-sm dark:text-white'>
            {isHealthy ? 'システム正常' : status ? 'システム要確認' : 'システム状態'}
          </h2>
        </div>
        <div className='flex shrink-0 items-center gap-1'>
          <IconButton
            label={copyLabel}
            onClick={() => void handleCopy()}
            disabled={!status || loading || copyState !== 'idle'}
            className={`relative h-8 w-8 rounded-full text-gray-500 transition-[background-color,color,transform] duration-200 ease-out dark:text-gray-300 disabled:opacity-100 ${
              copyState === 'copied'
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-white'
            }`}
          >
            <span
              aria-hidden='true'
              className={`absolute transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
                copyState === 'copied' ? '-translate-y-0.5 scale-90 opacity-0' : 'translate-y-0 scale-100 opacity-100'
              }`}
            >
              <CopyIcon size={18} className='stroke-current' />
            </span>
            <span
              aria-hidden='true'
              className={`absolute transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
                copyState === 'copied' ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-0.5 scale-90 opacity-0'
              }`}
            >
              <CheckIcon size={18} className='stroke-current' />
            </span>
          </IconButton>
          <button
            type='button'
            onClick={() => void loadStatus(true)}
            disabled={loading || !systemStatusEndpoint || copyState !== 'idle'}
            className='shrink-0 rounded border border-gray-300 px-2 py-1 text-gray-700 text-xs hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
          >
            {loading ? '確認中…' : '再確認'}
          </button>
        </div>
      </div>

      <div
        id={detailsId}
        aria-hidden={collapsed}
        className={`grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none ${
          collapsed ? 'mt-0 grid-rows-[0fr] opacity-0' : 'mt-2 grid-rows-[1fr] opacity-100'
        }`}
      >
        <div className='min-h-0'>
          {status ? (
            <>
              <p className='text-gray-500 text-[11px] dark:text-gray-400'>
                最終確認：{formatCheckedAt(status.checkedAt)}
              </p>
              <div className='mt-2 space-y-1.5 border-t border-gray-100 pt-2 dark:border-gray-700'>
                {database && <CheckRow label='PostgreSQL' check={database} />}
                {database && (
                  <div className='ml-3 space-y-1 border-l border-gray-200 pl-2 dark:border-gray-600'>
                    {database.connection && <CheckRow label='接続' check={database.connection} />}
                    {database.schema && <CheckRow label='スキーマ' check={database.schema} />}
                  </div>
                )}
                {fileServerHealth && <CheckRow label='file-server 稼働' check={fileServerHealth} />}
                {fileServerApi && <CheckRow label='file-server API' check={fileServerApi} />}
                {fileServerApi && (
                  <div className='ml-3 space-y-1 border-l border-gray-200 pl-2 dark:border-gray-600'>
                    {fileServerApi.login && <CheckRow label='ログイン' check={fileServerApi.login} />}
                    {fileServerApi.read && <CheckRow label='読み取り' check={fileServerApi.read} />}
                  </div>
                )}
                {fileServerPublic && <CheckRow label='公開URL' check={fileServerPublic} />}
              </div>
            </>
          ) : (
            <p className='text-gray-500 text-xs dark:text-gray-400'>状態を確認しています。</p>
          )}

          {copyError && (
            <p role='alert' className='mt-2 text-red-700 text-xs dark:text-red-400'>
              ステータスをコピーできませんでした。
            </p>
          )}
          {error && <p className='mt-2 text-red-700 text-xs dark:text-red-400'>状態を取得できませんでした。</p>}
        </div>
      </div>
    </section>
  )
}
