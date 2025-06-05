import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import app from '#/server/app'

// グローバルfetchをモック - 外部APIへのリクエストをモック化
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('App', () => {
  beforeEach(() => {
    // 各テスト前にモックをリセット
    vi.clearAllMocks()
  })

  afterEach(() => {
    // 各テスト後にモックをリセット
    vi.resetAllMocks()
  })

  test('POST /api/chat should stream text response', async () => {
    // モックレスポンスのストリームデータを作成
    const mockStreamData = [
      'data: {"choices":[{"delta":{"content":"こんにちは！"}}]}\n',
      'data: {"choices":[{"delta":{"content":"テストメッセージ"}}]}\n',
      'data: {"choices":[{"delta":{"content":"への応答です。"}}]}\n',
      'data: [DONE]\n',
    ]

    // ReadableStreamを作成
    const mockStream = new ReadableStream({
      start(controller) {
        for (const chunk of mockStreamData) {
          controller.enqueue(new TextEncoder().encode(chunk))
        }
        controller.close()
      },
    })

    // fetchのモックレスポンスを設定
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: mockStream,
    })

    // 環境変数をモック
    vi.stubEnv('CHAT_BASE_URL', 'http://mock-api.example.com/chat')
    vi.stubEnv('CHAT_API_KEY', 'unit_test_key')
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: 'テストメッセージ',
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')

    // ストリーミングレスポンスを読み込む
    const reader = res.body?.getReader()
    expect(reader).not.toBeUndefined()

    if (reader) {
      let receivedText = ''
      let isDone = false

      // すべてのチャンクを読み込む
      while (!isDone) {
        const { done, value } = await reader.read()
        if (done) {
          isDone = true
          continue
        }

        // Uint8Arrayをテキストに変換
        const chunk = new TextDecoder().decode(value)
        receivedText += chunk
      }

      // 期待されるテキストが含まれているか確認
      expect(receivedText).toContain('こんにちは！')
      expect(receivedText).toContain('テストメッセージ')
      expect(receivedText).toContain('への応答です。')

      // fetchが正しいパラメータで呼ばれたことを確認
      expect(mockFetch).toHaveBeenCalledWith('http://mock-api.example.com/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer unit_test_key',
        },
        body: JSON.stringify({
          model: 'gpt-4.1-nano',
          messages: [{ role: 'user', content: 'テストメッセージ' }],
          stream: true,
        }),
        signal: expect.any(AbortSignal),
      })
    }
  })

  test('POST /api/chat should handle API error', async () => {
    // fetchのモックレスポンスを設定（エラーケース）
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })

    // 環境変数をモック
    vi.stubEnv('CHAT_BASE_URL', 'http://mock-api.example.com/chat')

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'テストメッセージ' }],
        model: 'gpt-4.1-nano',
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')

    // ストリーミングレスポンスを読み込む
    const reader = res.body?.getReader()
    expect(reader).not.toBeUndefined()

    if (reader) {
      let receivedText = ''
      let isDone = false

      while (!isDone) {
        const { done, value } = await reader.read()
        if (done) {
          isDone = true
          continue
        }

        const chunk = new TextDecoder().decode(value)
        receivedText += chunk
      }

      // エラーメッセージが含まれているか確認
      expect(receivedText).toContain('APIからの応答に失敗しました')
    }
  })

  test('GET /', async () => {
    const res = await app.request('/', {
      method: 'GET',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root"></div>')
  })
})
