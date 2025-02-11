import { ReadableStream } from 'node:stream/web'
import type { LLMProvider, Messages, Reader } from './types'

const TEST_DATA = `
これはテスト用のストリームです🤖

何回か繰り返しテキストを出力します。

---

# 見出し1
## 見出し2
### 見出し3
#### 見出し4
##### 見出し5

これは通常のテキストです。

**太字テキスト**

*斜体テキスト*

~~取り消し線テキスト~~

- リスト項目1
- リスト項目2
    - ネストされたリスト項目1
    - ネストされたリスト項目2
- リスト項目3

1. 番号付きリスト項目1
2. 番号付きリスト項目2
    1. ネストされた番号付きリスト項目1
    2. ネストされた番号付きリスト項目2
3. 番号付きリスト項目3

> これは引用です。
> 複数行に渡る引用の例です。

\`インラインコード\`

\`\`\`
コードブロックです。
複数行にわたることもできます。
\`\`\`

[リンクテキスト](https://example.com)

画像です。

![画像の代替テキスト](https://picsum.photos/200)

---

テーブルの例です。

| 商品名  | 価格    |
|---------|---------|
| りんご  | ¥100    |
| みかん  | ¥80     |
| バナナ  | ¥120    |

Pythonのコードブロックです。

\`\`\`python
def hello():
    output = "Hello, World!"
    print(output)

if __name__ == "__main__":
    hello()
\`\`\`

TypeScriptのコードブロックです。

\`\`\`ts
interface Person {
  name: string;
  age: number;
  isStudent: boolean;
}
\`\`\`
`
const CHUNK_SIZE = 5
const MAX_CHUNKS = (TEST_DATA.length / CHUNK_SIZE) * 3

function createDummyStream(messages: Messages[]): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0
  let chunkCount = 0

  const createResponsePayload = ({
    id,
    model = 'dummy',
    content,
    finish_reason = null,
    usage = null,
  }: {
    id: string
    model?: string
    content: string
    finish_reason?: 'length' | 'stop' | null
    usage?: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
    } | null
  }): string => {
    const data = {
      id,
      model,
      choices: [{ delta: { content }, finish_reason }],
      usage,
    }
    return `data: ${JSON.stringify(data)}\n`
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk = ''
      for (let i = 0; i < CHUNK_SIZE; i++) {
        chunk += TEST_DATA[index]
        index = (index + 1) % TEST_DATA.length
      }

      controller.enqueue(
        new TextEncoder().encode(
          createResponsePayload({
            id: `${chunkCount}`,
            content: chunk,
          }),
        ),
      )
      chunkCount++

      await new Promise((resolve) => setTimeout(resolve, 25)) // delay

      if (chunkCount >= MAX_CHUNKS) {
        const sloppyInputToken = messages.map((x) => x.content).join('').length // 適当なトークン数
        controller.enqueue(
          new TextEncoder().encode(
            createResponsePayload({
              id: `${chunkCount}`,
              content: 'Test stream end 🚀',
              finish_reason: 'stop',
              usage: {
                // テスト用に適当に値を埋める
                prompt_tokens: sloppyInputToken,
                completion_tokens: chunkCount,
                total_tokens: sloppyInputToken + chunkCount,
              },
            }),
          ),
        )
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'))
        controller.close()
      }
    },
  })

  return stream.getReader()
}

export class TestProvider implements LLMProvider {
  async chatStream(
    messages: Messages[],
    _temperature?: number | null,
    _maxTokens?: number | null,
  ): Promise<Reader> {
    await new Promise((resolve) => setTimeout(resolve, 1000)) // delay
    return createDummyStream(messages)
  }
}
