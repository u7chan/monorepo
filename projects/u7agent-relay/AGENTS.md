# AGENTS.md

モノレポの `projects/u7agent-relay`。リポジトリ共通の規約は [ルートの AGENTS.md](../../AGENTS.md) を参照する。

u7agent の会話へ外部クライアントから投稿し、最終応答と生成物を取得する中継。接続先と API キーは管理 GUI で作る。
`u7agent` の BFF には認証が無いため、この中継は LAN / VPN の内側でだけ動かす。

## Tech Stack

- Bun 1.4（runtime / package manager / bundler / test）
- TypeScript（strict）+ Preact 11（client）
- Hono（BFF）
- `bun:sqlite`（ORM なし）
- 素の CSS
- oxlint / oxfmt / tsc / bun:test

## 構成

- `src/server.ts` が `Bun.serve` の入口。`index.html` の HTML import を `/` に、それ以外を Hono に渡す。
- `src/server/app.ts` が API の Hono app。管理 API は PIN セッション cookie、中継 API は Bearer キーで認証する。
- `src/server/relay.ts` が投稿と返信の状態遷移。接続先ごとに 1 実行だけ通し、終了済みの結果は SQLite に残す。
- `src/server/mcp.ts` が MCP の入口。`/v1` と同じ `relay` を呼ぶ 2 つ目の入口で、stateless の Streamable HTTP として動く。
- `src/server/assets.ts` が生成物の抽出と cwd 相対パスの正規化。`files` の一覧とダウンロードの許可判定を共有する。
- `src/server/files.ts` が生成物のダウンロード。cwd 配下の `stat` 再確認、Range / status の写像、サイズ上限、同時実行の制限を持つ。
- `src/server/run-reconciler.ts` が 30 秒ごとに実行中 / 回答待ちの上流状態を取り込み、90 日を過ぎた履歴を削除する。クライアントの返信取得に依存させない。
- `src/server/upstream.ts` が u7agent の API 呼び出し。応答の `sessionId` / `spaceId` が接続先と一致しなければ 502 にする。
- `src/server/targets.ts` が会話 URL の解釈と API URL の組み立て。上流は HTTPS だけを受け付ける。
- 認証状態とデータは `DATA_DIR` 配下（`pin-hash` / `session-key` / `relay.sqlite`）。PIN は Argon2id、セッションは HMAC 署名 cookie。
- キーの平文は発行時に一度だけ返し、保存は SHA-256。失効は `revoked_at` を立て、削除とは分ける。

## 規約

- 上流の認証が無い前提を崩さない。接続先 URL とキーをログ・エラー本文・管理 API の応答へ載せない（`ConnectionView` は origin / URL を持たない）。cwd の絶対パスも応答・ログへ出さない。
- 生成物の取得は接続先セッションの cwd 配下だけに閉じる。`stat` が返す realpath で境界を確認し、クライアントが渡した path をそのまま上流へ渡さない。
- 接続先の会話は登録後に変えない。名前だけを編集可能にし、会話を変えるときは接続先とキーを作り直す。
- 入口は `/v1` と `/mcp` の 2 つで、サービス層は 1 つ。`/mcp` は自分自身の `/v1` を HTTP で呼ばず、`relay` / `files` を直接呼ぶ。片方の入口だけを直す事態を避けるため、振る舞いの契約テストはサービス層に置く。
- 管理 API の変更系は同一 origin の要求だけ通す（`app.ts` の `/api/*` ミドルウェア）。
- `relay.sqlite` のスキーマを変えるときは、既存の volume を壊さないよう `CREATE TABLE IF NOT EXISTS` の範囲で足す。生成物の一覧は `run_assets` に保存し、`runs` の削除に `ON DELETE CASCADE` で追随させる。
- 同時ダウンロードの制限と cwd キャッシュはプロセス内で持つ。relay を 2 インスタンス以上で動かさない。
