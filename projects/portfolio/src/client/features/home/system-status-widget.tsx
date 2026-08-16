import { hc } from 'hono/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppType } from '#/server/app.d'
import type { SystemCheck, SystemStatus } from '#/types'

const client = hc<AppType>('/')

type SystemStatusEndpoint = {
  $get: (options?: { query?: { refresh?: string } }) => Promise<Response>
}

const systemStatusEndpoint = (client.api as unknown as { 'system-status'?: SystemStatusEndpoint })['system-status']

const reasonLabels: Record<string, string> = {
  ok: '応答あり',
  'not-configured': '設定なし',
  'connection-failed': '接続失敗',
  'schema-check-failed': 'スキーマ確認失敗',
  'schema-incomplete': 'スキーマ不備',
  'database-unavailable': 'データベース利用不可',
  timeout: 'タイムアウト',
  'healthz-unavailable': 'ヘルスチェック失敗',
  'login-failed': 'ログイン失敗',
  'read-failed': '読み取り失敗',
  'file-server-api-unavailable': 'API利用不可',
  'public-unavailable': '公開配信不可',
}

function getStatusLabel(status: SystemCheck['status']): string {
  if (status === 'ok') return '正常'
  if (status === 'not-configured') return '未設定'
  return '異常'
}

function getReasonLabel(reason: string): string {
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

export function SystemStatusWidget() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const requestRef = useRef<AbortController | null>(null)

  const loadStatus = useCallback(async (refresh: boolean) => {
    if (!systemStatusEndpoint) return

    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError(false)

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

  const isHealthy = status?.status === 'ok'
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
        <div className='flex min-w-0 items-center gap-2'>
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
        <button
          type='button'
          onClick={() => void loadStatus(true)}
          disabled={loading || !systemStatusEndpoint}
          className='shrink-0 rounded border border-gray-300 px-2 py-1 text-gray-700 text-xs hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
        >
          {loading ? '確認中…' : '再確認'}
        </button>
      </div>

      {status ? (
        <>
          <p className='mt-2 text-gray-500 text-[11px] dark:text-gray-400'>
            最終確認：{formatCheckedAt(status.checkedAt)}
          </p>
          <div className='mt-2 space-y-1.5 border-t border-gray-100 pt-2 dark:border-gray-700'>
            {database && <CheckRow label='PostgreSQL' check={database} />}
            {database && (
              <div className='ml-3 space-y-1 border-l border-gray-200 pl-2 dark:border-gray-600'>
                <CheckRow label='接続' check={database.connection} />
                <CheckRow label='スキーマ' check={database.schema} />
              </div>
            )}
            {fileServerHealth && <CheckRow label='file-server 稼働' check={fileServerHealth} />}
            {fileServerApi && <CheckRow label='file-server API' check={fileServerApi} />}
            {fileServerApi && (
              <div className='ml-3 space-y-1 border-l border-gray-200 pl-2 dark:border-gray-600'>
                <CheckRow label='ログイン' check={fileServerApi.login} />
                <CheckRow label='読み取り' check={fileServerApi.read} />
              </div>
            )}
            {fileServerPublic && <CheckRow label='公開URL' check={fileServerPublic} />}
          </div>
        </>
      ) : (
        <p className='mt-2 text-gray-500 text-xs dark:text-gray-400'>状態を確認しています。</p>
      )}

      {error && <p className='mt-2 text-red-700 text-xs dark:text-red-400'>状態を取得できませんでした。</p>}
    </section>
  )
}
