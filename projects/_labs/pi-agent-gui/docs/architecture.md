# 非同期実行とセッション管理の設計

ブラウザ ⇄ BFF（`server/src/app.ts`、Hono）⇄ pi SDK（`server/src/agent.ts`）という 3 層構成。エージェントの実行ライフサイクルは HTTP リクエストから完全に切り離され、`server/src/sessions.ts` の `SessionStore` が所有する。

## 基本原則

1. **実行は裏で続く**: `POST /messages` は 202 で即時返却する。クライアントが切断されても、タブを閉じても、ラン（1 回の `session.prompt()`）は最後まで続く。
2. **イベントはセッション単位のログに積む**: 全イベントは連番（`seq`）付きでメモリ上のログに追記され、後から購読したクライアントに取りこなしなくリプレイできる。
3. **停止は明示的に**: SSE 切断では止めない。`POST /stop` のみが実行を中断し、キューを破棄する。

## ランのライフサイクル

```
POST /api/sessions/:id/messages { text }
  ├─ アイドル → SessionStore.startRun() → 202 { queued: false, runId }
  └─ 実行中   → キューに積む           → 202 { queued: true, queueDepth }
                    （キューは最大 10 件。超過は 429）

startRun():
  1. run オブジェクト生成（status: "running"）
  2. run_start イベントを記録
  3. session.subscribe() で pi のイベントを変換して記録
     - message_update / text_delta → text
     - tool_execution_start/end    → tool_start / tool_end
     - agent_settled               → 終了判定
  4. session.prompt(text) を fire-and-forget で呼ぶ（await しない）
  5. agent_settled（または prompt の解決）で finish():
     - 最終テキストの取りこぼし補完（delta が来なかった場合の差分送出）
     - run.status を completed / stopped / error に確定
     - run_end イベントを記録
     - キューがあれば 200ms 後に pump() で次のメッセージを実行
```

## 状態

セッションの状態は `SessionStore.statusOf()` が導出する。

| 状態 | 意味 |
| --- | --- |
| `idle` | ランなし |
| `running` | ラン実行中 |
| `queued` | 待機メッセージあり |
| `completed` | 最後のランが完了 |
| `stopped` | 最後のランがユーザー停止 |
| `error` | 最後のランがエラー |

## イベントログと SSE

- ログは `{ seq, type, data, at }` の配列。セッションごとに直近 2000 件を保持。
- `GET /api/sessions/:id/events?after=N` が SSE 購読エンドポイント。
  - `seq > N` のエントリをリプレイしてからライブ配信に合流する。
  - 各イベントは `id: seq` 付きで送出するため、ブラウザの `EventSource` は自動再接続時に `Last-Event-ID` ヘッダを送り、サーバはこれを `after` のフォールバックとして使う。
  - クライアントのカーソルがバッファより古い（取りこぼしが埋められない）場合は、ログをリプレイせず `resync` イベント 1 件（セッション全体のペイロードを含む）を送り、クライアントは再描画する。
- 接続はハートビート（`: ping`、15 秒ごと）で維持する。購読は複数タブから可能で、切断してもランには影響しない。

## 会話履歴

- 履歴の正は pi セッション（`SessionManager.inMemory`）の `messages`。`GET /api/sessions/:id` が user / assistant のテキストに整形して返す。
- タイトルは最初のユーザーメッセージ（60 文字）から自動生成。セッション一覧 `GET /api/sessions` は状態・件数・最終使用時刻付きで返す。
- ラン中に再接続したクライアント向けに、`payload.run.toolCalls` で進行中ランのツールカード状態も返す。

## 停止

`POST /api/sessions/:id/stop`（旧 `/abort` もエイリアスとして有効）:

1. 待機キューを破棄し `queue_cleared` イベントを記録
2. `session.abort()` を呼ぶ（pi が `agent_settled` / stopReason `aborted` を返す）
3. `finish()` が `run_end`（status: `stopped`）を記録。キューは破棄済みなので次のランは起動しない

`DELETE /api/sessions/:id` は停止 + 破棄 + 購読者への `session_deleted` 通知を行う。

## ライフサイクル / 制限

- セッションはプロセスのメモリ内のみ。1 時間未使用のアイドルセッションは SWEEP で破棄（実行中・キューありは対象外）。
- サーバ終了時は全セッションを abort + dispose する。
- テスト（`server/test/`）は pi をスタブし、`createBffApp({ pi })` に注入して検証する。HTTP 層は `app.request()` で叩き（listen なし）、store 挙動は直接検証する。実 API は呼ばない。

## API 契約と型安全化

- 入出力の DTO は `server/src/schema.ts`（zod）が正。リクエストボディは `@hono/zod-validator` で検証し、レスポンス型はハンドラの戻り値から推論される。
- `server/src/app.ts` はルートをチェーン形式で定義し `AppType` を export。client は `hc<AppType>(location.origin)` で型付きクライアントを構築する（`client/src/api.ts`）。SSE は型付け対象外で、`EventEntry` のみ server から型 import する。
- server / client の両 tsconfig は `moduleResolution: bundler` + noEmit。server は tsx で実行するため拡張子なし import で統一し、client は workspace package `server` のソースを型として直接参照する。
- カタログ CRUD の body はわざと pass-through（zod 厳格化しない）。エージェント名の必須チェックなど日本語エラー文言を伴う正規化は `agents.ts` 側が正のため。

## フロントエンド

チャット UI は `client/` ワークスペースに切り出し、React 19 + Vite + TypeScript + Tailwind CSS v4 で実装している。ソースは `client/src` 配下に置き、エントリは `main.tsx`（`index.html` から読み込む）。SSE イベントは reducer で状態に変換し、旧実装（命令的な DOM 操作）の挙動を忠実に再現する。

### テーマシステム

- テーマは `html` 要素の `data-theme` 属性で決定し、各プリセットが CSS 変数（`--c-*`）を定義する。Tailwind v4 の `@theme inline` で CSS 変数をセマンティックトークンにマップし、コンポーネントはトークンクラス（背景色・文字色など）だけで書く。プリセットの追加・変更は CSS 変数定義だけで完結する。
- プリセットは 6 種類（ミッドナイト / デイライト / モカ / フォレスト / サクラ / ターミナル）に加え、`prefers-color-scheme` に追従する「システム」を選択できる。
- 状態は `ThemeProvider`（`useTheme` フックで参照・変更）が持ち、選択は `localStorage` に保存される。
- `client/public/theme-init.js` は React 初回描画より前に `data-theme` を適用する外部 classic script。ここを React 側でやると初期化完了までテーマなしで点滅するため、意図的に React の外に置いている。ロジック（localStorage のキー、system 追従の解決）は `ThemeProvider` と同じ選択結果になるよう同期を取る。
- BFF の CSP は `style-src 'self'`（インラインスタイル不可）のため、テーマはすべて外部 CSS + 属性切替で実装する。`<style>` の注入やインライン `style` 属性には頼らない。

### チャット状態とレンダリング

- SSE イベント（`text` / `tool_start` / `tool_end` / `run_end` など）を React の reducer で受け、イベントログから UI 状態（メッセージ列、ツールカード、実行状態）を導出して仮想 DOM へ反映する。旧 `app.js` のようにイベントハンドラで DOM を直接書き換えるのではなく、「イベントの適用」を純粋な状態遷移として書くことで、再接続時のリプレイ / `resync` も同じ reducer で処理できる。
- 接続管理（`EventSource` の再接続、`Last-Event-ID`、`resync` の検知）はカスタムフックに集約し、コンポーネントは描画に集中する。

### 開発フローと配信

- 開発時は `pnpm dev`（BFF :4317）と `pnpm dev:web`（Vite :5173、HMR 付き）を併用する。Vite は `/api` を 4317 へプロキシするため、フロントエンドは同一オリジンの API としてそのまま動く。
- 本番は `pnpm build` の産物 `client/dist/` を BFF が配信する。静的配信はリクエストパスを `client/dist` 内のファイルに解決し（ディレクトリ外は 404）、`index.html` は `no-cache`、Vite のハッシュ付き `assets/` 配下は `immutable` でキャッシュする。未ビルドのときは 503 で案内を出す。CSP は変わらず `default-src 'self'` のため、ビルド産物も同一オリジンのアセットだけで動く。
