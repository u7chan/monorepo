// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
})
