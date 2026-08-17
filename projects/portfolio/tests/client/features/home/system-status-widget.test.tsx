// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { systemStatusGetMock } = vi.hoisted(() => ({
  systemStatusGetMock: vi.fn(),
}))

vi.mock('hono/client', () => ({
  hc: () => ({
    api: {
      'system-status': {
        $get: systemStatusGetMock,
      },
    },
  }),
}))

import { SystemStatusWidget } from '#/client/features/home/system-status-widget'

const responseBody = {
  status: 'ok',
  checkedAt: '2026-04-19T00:00:00.000Z',
  checks: {
    database: {
      status: 'ok',
      reason: 'ok',
      checkedAt: '2026-04-19T00:00:00.000Z',
      connection: { status: 'ok', reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
      schema: { status: 'ok', reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
    },
    fileServerHealth: { status: 'ok', reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
    fileServerApi: {
      status: 'ok',
      reason: 'ok',
      checkedAt: '2026-04-19T00:00:00.000Z',
      login: { status: 'ok', reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
      read: { status: 'ok', reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
    },
    fileServerPublic: { status: 'ok', reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
  },
}

describe('SystemStatusWidget', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    systemStatusGetMock.mockReset()
  })

  it('正常状態と最終確認時刻を表示し、再確認を実行する', async () => {
    systemStatusGetMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    )

    render(<SystemStatusWidget />)

    await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())
    expect(screen.getByText(/最終確認/)).toBeTruthy()
    expect(screen.getByText(/PostgreSQL/)).toBeTruthy()
    expect(screen.getByText(/file-server API/)).toBeTruthy()
    expect(screen.getByText(/公開URL/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '再確認' }))

    await waitFor(() => expect(systemStatusGetMock).toHaveBeenCalledTimes(2))
    expect(systemStatusGetMock).toHaveBeenLastCalledWith({ query: { refresh: '1' } })
  })

  it('詳細状態の reason label と異常時の表示を反映する', async () => {
    const degradedBody = structuredClone(responseBody)
    degradedBody.status = 'degraded'
    degradedBody.checks.database.status = 'error'
    degradedBody.checks.database.reason = 'database-unavailable'
    degradedBody.checks.database.connection.status = 'error'
    degradedBody.checks.database.connection.reason = 'connection-failed'
    degradedBody.checks.database.schema.status = 'error'
    degradedBody.checks.database.schema.reason = 'schema-check-failed'
    degradedBody.checks.fileServerHealth.status = 'error'
    degradedBody.checks.fileServerHealth.reason = 'healthz-unavailable'
    degradedBody.checks.fileServerApi.status = 'error'
    degradedBody.checks.fileServerApi.reason = 'file-server-api-unavailable'
    degradedBody.checks.fileServerApi.login.status = 'error'
    degradedBody.checks.fileServerApi.login.reason = 'login-failed'
    degradedBody.checks.fileServerApi.read.status = 'error'
    degradedBody.checks.fileServerApi.read.reason = 'read-failed'
    degradedBody.checks.fileServerPublic.status = 'error'
    degradedBody.checks.fileServerPublic.reason = 'public-unavailable'
    systemStatusGetMock
      .mockResolvedValueOnce(new Response(JSON.stringify(responseBody), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(degradedBody), { status: 200 }))

    render(<SystemStatusWidget />)
    await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '再確認' }))

    await waitFor(() => expect(screen.getByText('システム要確認')).toBeTruthy())
    expect(screen.getByText(/データベース利用不可/)).toBeTruthy()
    expect(screen.getByText(/接続失敗/)).toBeTruthy()
    expect(screen.getByText(/スキーマ確認失敗/)).toBeTruthy()
    expect(screen.getByText(/ヘルスチェック失敗/)).toBeTruthy()
    expect(screen.getByText(/API利用不可/)).toBeTruthy()
    expect(screen.getByText(/ログイン失敗/)).toBeTruthy()
    expect(screen.getByText(/読み取り失敗/)).toBeTruthy()
    expect(screen.getByText(/公開配信不可/)).toBeTruthy()
  })
})
