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

## ロギング

- [pino](https://getpino.io) ベースの構造化ロギング。エージェントログは stdout と `logs/aiagent-YYYYMMDD.log`、アクセスログは stdout と `logs/aiagent-access-YYYYMMDD.log` に同内容の JSONL を出力する（ファイル出力はデフォルト ON）
- アクセスログには `method` / `path` / `status` / `durationMs` を記録する。エージェントログとアクセスログは障害解析対象を分けるため別ファイルに出力する
- 主用途は障害事後調査。タイムスタンプが固定幅ローカルISO（例: `2026-02-15T14:03:21.123+09:00`）のため、次の読み方で解析できる:

```sh
grep '"time":"2026-02-15T14:03' logs/aiagent-20260215.log | grep 'bash'
```

- レベル配分: start/end/tool=info、failed=error、retry=warn、prompt preview=debug
- ローテートは起動時に日付確定・以降追記のみ。日跨ぎランタイムロールは未対応

## 開発

```sh
bun install
cp .env.example .env   # 必要に応じて編集 (Bun が .env を自動で読み込む)
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
docker run -p 3000:3000 \
  -e OPENCODE_API_KEY=sk-... \
  -e AIAGENT_MODEL=opencode-go/deepseek-v4-flash \
  aiagent
```

## 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `AIAGENT_MODEL` | 推奨 | モデルを CLI 形式で固定する (例: `opencode-go/deepseek-v4-flash`、`:low` などの思考レベルサフィックス可)。未指定なら pi の設定・デフォルトに従う |
| `OPENCODE_API_KEY` 等 | 要 | プロバイダ固有の API キー環境変数。Pi SDK が auth.json → 環境変数の順で自動解決する |
| `LOG_LEVEL` | 任意 | ログレベル (default: `info`) |
| `LOG_FILE` | 任意 | ログファイルパス (default: `logs/aiagent-YYYYMMDD.log`)。空文字でファイル出力を無効化 |
| `LOG_ACCESS_FILE` | 任意 | アクセスログファイルパス (default: `logs/aiagent-access-YYYYMMDD.log`)。空文字でファイル出力を無効化 |

コンテナ内には `~/.pi/agent/auth.json` が無いため、API キーは環境変数で渡す。
