import { describe, expect, test } from 'vitest'
import app from '#/server/app'

describe('App', () => {
  test('POST /api/chat should stream text response', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'テストメッセージ' }),
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
      expect(receivedText).toContain('こん\nにちは！')
      expect(receivedText).toContain('「テストメッセージ」とご質問ありがとうございます。')
      expect(receivedText).toContain('お待たせしました！')
      expect(receivedText).toContain('どのようにお手伝いできますか？')
    }
  }, 10000) // 10秒のタイムアウトを設定

  test('GET /', async () => {
    const res = await app.request('/', {
      method: 'GET',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root"></div>')
  })
})
