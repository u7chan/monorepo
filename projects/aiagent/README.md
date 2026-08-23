# aiagent

Hono + Bun の Web アプリケーション。ハーネス基盤として [Pi SDK](https://pi.dev/docs/latest/sdk) (`@earendil-works/pi-coding-agent`) を採用している。

## API

- `GET /` - 挨拶
- `GET /healthz` - ヘルスチェック
- `POST /prompt` - ハーネスにプロンプトを送り、アシスタントの応答を得る

```sh
curl -X POST localhost:3000/prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "hello"}'
# => {"result":"..."}
```

- プロンプトが空文字・未指定の場合は `400 {"error":"prompt must be a non-empty string"}` を返す

## ハーネス

- `src/harness.ts` の `createHarness()` が Pi SDK の `createAgentSession()` をラップする
- 現時点は最小構成: セッションは in-memory(永続化なし)・ツール無効(会話のみ)
- GUI・ストリーミング・ツールは今後この層に追加する

## 開発

```sh
bun install
bun run dev
```

## チェック

```sh
bun run lint   # tsc --noEmit + biome lint
bun run test   # bun test
```

## Docker

```sh
docker build -t aiagent --target=test .   # CI相当(lint + test)
docker build -t aiagent .                 # 本番イメージ(final)
docker run -p 3000:3000 aiagent
```

