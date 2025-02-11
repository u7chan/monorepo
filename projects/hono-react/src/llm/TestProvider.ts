import { ReadableStream } from 'node:stream/web'
import type { LLMProvider, Messages, Reader } from './types'

const TEST_DATA = `
これはテスト用のストリームです🤖

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

![画像の代替テキスト](https://via.placeholder.com/150)

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

function createDummyStream(): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0
  let chunkCount = 0

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk = ''
      for (let i = 0; i < CHUNK_SIZE; i++) {
        chunk += TEST_DATA[index]
        index = (index + 1) % TEST_DATA.length
      }
      const data = {
        id: `${chunkCount}`,
        model: 'dummy',
        choices: [{ delta: { content: `${chunk}` }, finishReason: null }],
        usage: null,
      }
      const payload = `data: ${JSON.stringify(data)}\n`
      controller.enqueue(new TextEncoder().encode(payload))
      chunkCount++

      await new Promise((resolve) => setTimeout(resolve, 25)) // delay

      if (chunkCount >= MAX_CHUNKS) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'))
        controller.close()
      }
    },
  })

  return stream.getReader()
}

export class TestProvider implements LLMProvider {
  async chatStream(
    _messages: Messages[],
    _temperature?: number | null,
    _maxTokens?: number | null,
  ): Promise<Reader> {
    await new Promise((resolve) => setTimeout(resolve, 1000)) // delay
    return createDummyStream()
  }
}
