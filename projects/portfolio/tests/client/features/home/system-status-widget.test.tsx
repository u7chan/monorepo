// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { copyToClipboardMock, systemStatusGetMock } = vi.hoisted(() => ({
  copyToClipboardMock: vi.fn(),
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

vi.mock('#/client/shared/lib/copy-to-clipboard', () => ({
  copyToClipboard: copyToClipboardMock,
}))

import { formatSystemStatusForCopy, SystemStatusWidget } from '#/client/features/home/system-status-widget'
import type { SystemStatus } from '#/types'

const responseBody: SystemStatus = {
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
    copyToClipboardMock.mockReset()
    copyToClipboardMock.mockResolvedValue(undefined)
  })

  it('正常状態と最終確認時刻を表示し、再確認を実行する', async () => {
    systemStatusGetMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    )

    render(<SystemStatusWidget />)

    expect((screen.getByRole('button', { name: 'ステータスをコピー' }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())
    expect(screen.getByText(/最終確認/)).toBeTruthy()
    expect(screen.getByText(/PostgreSQL/)).toBeTruthy()
    expect(screen.getByText(/file-server API/)).toBeTruthy()
    expect(screen.getByText(/公開URL/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'ステータスをコピー' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '再確認' }))

    await waitFor(() => expect(systemStatusGetMock).toHaveBeenCalledTimes(2))
    expect(systemStatusGetMock).toHaveBeenLastCalledWith({ query: { refresh: '1' } })
  })

  it('公開DTOを改行と階層を保ったMarkdownとしてコピーし、成功状態を表示する', async () => {
    systemStatusGetMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    )

    render(<SystemStatusWidget />)
    await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'ステータスをコピー' }))

    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalledWith(formatSystemStatusForCopy(responseBody)))
    expect(screen.getByRole('button', { name: 'コピー済み' })).toBeTruthy()
  })

  it('コピー中と成功中の二重操作を無効化する', async () => {
    let resolveCopy: (() => void) | undefined
    systemStatusGetMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    )
    copyToClipboardMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve
        })
    )

    render(<SystemStatusWidget />)
    await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'ステータスをコピー' }))

    const copyingButton = screen.getByRole('button', { name: 'コピー中…' }) as HTMLButtonElement
    expect(copyingButton.disabled).toBe(true)
    fireEvent.click(copyingButton)
    expect(copyToClipboardMock).toHaveBeenCalledTimes(1)

    resolveCopy?.()
    await waitFor(() => expect(screen.getByRole('button', { name: 'コピー済み' })).toBeTruthy())
    expect((screen.getByRole('button', { name: 'コピー済み' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('コピー中と成功表示中は再確認を無効化し、解除後のrefreshで古い成功表示を残さない', async () => {
    let resolveCopy: (() => void) | undefined
    let resolveRefresh: ((response: Response) => void) | undefined
    const refreshedBody = structuredClone(responseBody)
    refreshedBody.status = 'degraded'
    systemStatusGetMock
      .mockResolvedValueOnce(new Response(JSON.stringify(responseBody), { status: 200 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRefresh = resolve
          })
      )
    copyToClipboardMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve
        })
    )

    render(<SystemStatusWidget />)
    await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'ステータスをコピー' }))
    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'コピー中…' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '再確認' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '再確認' }))
    expect(systemStatusGetMock).toHaveBeenCalledTimes(1)

    expect(resolveCopy).toBeTypeOf('function')
    resolveCopy?.()
    await waitFor(() => expect(screen.getByRole('button', { name: 'コピー済み' })).toBeTruthy())
    expect((screen.getByRole('button', { name: '再確認' }) as HTMLButtonElement).disabled).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 2100))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '再確認' }) as HTMLButtonElement).disabled).toBe(false)
    )

    fireEvent.click(screen.getByRole('button', { name: '再確認' }))
    await waitFor(() => expect(systemStatusGetMock).toHaveBeenCalledTimes(2))
    expect(resolveRefresh).toBeTypeOf('function')
    resolveRefresh?.(new Response(JSON.stringify(refreshedBody), { status: 200 }))
    await waitFor(() => expect(screen.getByText('システム要確認')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'コピー済み' })).toBeNull()
  })

  it('コピー失敗時も状態表示と再確認を維持する', async () => {
    systemStatusGetMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    )
    copyToClipboardMock.mockRejectedValueOnce(new Error('clipboard unavailable'))

    render(<SystemStatusWidget />)
    await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'ステータスをコピー' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('ステータスをコピーできませんでした。'))
    expect(screen.getByText('システム正常')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'ステータスをコピー' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '再確認' }))
    await waitFor(() => expect(systemStatusGetMock).toHaveBeenCalledTimes(2))
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
  describe('折りたたみ', () => {
    beforeEach(() => {
      systemStatusGetMock.mockReset()
      copyToClipboardMock.mockReset()
      copyToClipboardMock.mockResolvedValue(undefined)
      localStorage.clear()
    })

    afterEach(() => {
      localStorage.clear()
      cleanup()
    })

    function mockOkResponse() {
      systemStatusGetMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
        )
      )
    }

    function getDetailsContainer(): HTMLElement {
      const toggle = screen.getByRole('button', { name: /折りたたむ|展開する/ })
      const detailsId = toggle.getAttribute('aria-controls')
      const container = detailsId ? document.getElementById(detailsId) : null
      expect(container).not.toBeNull()
      return container as HTMLElement
    }

    it('折りたたみボタンで詳細を非表示にし、再レンダリング後も状態を保持する', async () => {
      mockOkResponse()

      render(<SystemStatusWidget />)
      await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())

      // 初期状態は展開
      expect(screen.getByText(/最終確認/)).toBeTruthy()
      const collapseButton = screen.getByRole('button', { name: '折りたたむ' })
      expect(collapseButton.getAttribute('aria-expanded')).toBe('true')
      expect(getDetailsContainer().getAttribute('aria-hidden')).toBe('false')

      fireEvent.click(collapseButton)

      // 詳細は折りたたまれ、タイトルと操作ボタンは残る
      const expandButton = screen.getByRole('button', { name: '展開する' })
      expect(expandButton.getAttribute('aria-expanded')).toBe('false')
      expect(getDetailsContainer().getAttribute('aria-hidden')).toBe('true')
      expect(getDetailsContainer().className).toContain('grid-rows-[0fr]')
      expect(screen.getByText('システム正常')).toBeTruthy()
      expect(screen.getByRole('button', { name: '再確認' })).toBeTruthy()

      // localStorage により再レンダリング後も折りたたみ状態を保持
      cleanup()
      render(<SystemStatusWidget />)
      await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())
      expect(screen.getByRole('button', { name: '展開する' }).getAttribute('aria-expanded')).toBe('false')
      expect(getDetailsContainer().getAttribute('aria-hidden')).toBe('true')

      // 展開ボタンで詳細が再表示される
      fireEvent.click(screen.getByRole('button', { name: '展開する' }))
      expect(screen.getByText(/最終確認/)).toBeTruthy()
      expect(screen.getByRole('button', { name: '折りたたむ' }).getAttribute('aria-expanded')).toBe('true')
      expect(getDetailsContainer().getAttribute('aria-hidden')).toBe('false')
    })

    it('折りたたみ中でもコピーと再確認を利用できる', async () => {
      mockOkResponse()

      render(<SystemStatusWidget />)
      await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: '折りたたむ' }))

      // 再確認はヘッダーに残り、折りたたみ中でも実行できる
      fireEvent.click(screen.getByRole('button', { name: '再確認' }))
      await waitFor(() => expect(systemStatusGetMock).toHaveBeenCalledTimes(2))

      // コピーもヘッダーに残り、折りたたみ中でも実行できる
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'ステータスをコピー' }) as HTMLButtonElement).disabled).toBe(false)
      )
      fireEvent.click(screen.getByRole('button', { name: 'ステータスをコピー' }))
      await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalledWith(formatSystemStatusForCopy(responseBody)))
    })
  })

  describe('再確認中の表示', () => {
    it('通信中は再確認ボタンをスピナー表示にし、コピーボタンを無効化する', async () => {
      let resolveRefresh: ((response: Response) => void) | undefined
      systemStatusGetMock
        .mockResolvedValueOnce(new Response(JSON.stringify(responseBody), { status: 200 }))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveRefresh = resolve
            })
        )

      render(<SystemStatusWidget />)
      await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())

      fireEvent.click(screen.getByRole('button', { name: '再確認' }))

      // 通信中: ボタンはスピナーを表示し、コピーは無効
      const refreshButton = screen.getByRole('button', { name: '確認中' })
      expect(refreshButton.querySelector('.animate-spin')).toBeTruthy()
      expect((screen.getByRole('button', { name: 'ステータスをコピー' }) as HTMLButtonElement).disabled).toBe(true)

      // 応答後: スピナーを解除し、コピーを再有効化
      expect(resolveRefresh).toBeTypeOf('function')
      resolveRefresh?.(new Response(JSON.stringify(responseBody), { status: 200 }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '再確認' }).querySelector('.animate-spin')).toBeNull()
      )
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'ステータスをコピー' }) as HTMLButtonElement).disabled).toBe(false)
      )
    })

    it('応答が一瞬でもスピナーを最小表示時間だけ維持する', async () => {
      vi.useFakeTimers()
      try {
        systemStatusGetMock.mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
          )
        )

        render(<SystemStatusWidget />)
        // 初回ロードのモック応答（microtask）をフラッシュする
        await act(async () => {})
        expect(screen.getByText('システム正常')).toBeTruthy()

        fireEvent.click(screen.getByRole('button', { name: '再確認' }))
        // 再確認のモック応答（microtask）をフラッシュする
        await act(async () => {})

        // resolve 直後: 最小表示時間が経過していないためスピナーが残る
        expect(screen.getByRole('button', { name: '確認中' }).querySelector('.animate-spin')).toBeTruthy()

        // 最小表示時間の経過でスピナーが解除される
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400)
        })
        expect(screen.getByRole('button', { name: '再確認' }).querySelector('.animate-spin')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('エラー時の自動展開', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    afterEach(() => {
      localStorage.clear()
    })

    it('折りたたみ中に再確認が失敗すると自動展開する', async () => {
      systemStatusGetMock
        .mockResolvedValueOnce(new Response(JSON.stringify(responseBody), { status: 200 }))
        .mockRejectedValueOnce(new Error('network error'))

      render(<SystemStatusWidget />)
      await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: '折りたたむ' }))
      expect(screen.getByRole('button', { name: '展開する' }).getAttribute('aria-expanded')).toBe('false')

      fireEvent.click(screen.getByRole('button', { name: '再確認' }))

      await waitFor(() => expect(screen.getByText('状態を取得できませんでした。')).toBeTruthy())
      expect(screen.getByRole('button', { name: '折りたたむ' }).getAttribute('aria-expanded')).toBe('true')
    })

    it('折りたたみ中にコピーが失敗すると自動展開する', async () => {
      systemStatusGetMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
        )
      )
      copyToClipboardMock.mockRejectedValueOnce(new Error('clipboard unavailable'))

      render(<SystemStatusWidget />)
      await waitFor(() => expect(screen.getByText('システム正常')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: '折りたたむ' }))

      fireEvent.click(screen.getByRole('button', { name: 'ステータスをコピー' }))

      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('ステータスをコピーできませんでした。')
      )
      expect(screen.getByRole('button', { name: '折りたたむ' }).getAttribute('aria-expanded')).toBe('true')
    })
  })
})
