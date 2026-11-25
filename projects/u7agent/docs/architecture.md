# 全体構成

ブラウザ ⇄ BFF（`server/src/app.ts`、Hono）⇄ pi SDK（`server/src/agent.ts`）⇄ サンドボックス（`server/src/sandbox/`、ツール実行）という 4 層構成。エージェントの実行ライフサイクルは HTTP リクエストから完全に切り離され、`server/src/sessions.ts` の `SessionStore` が所有する。LLM 認証情報は BFF 層までで止まり、サンドボックス層へは渡らない。

## 基本原則

1. **実行は裏で続く**: `POST /messages` は 202 で即時返却する。クライアントが切断されても、タブを閉じても、ラン（1 回の `session.prompt()` と、そこへ注入される追加入力）は最後まで続く。
2. **イベントはセッション単位のログに積む**: 全イベントは連番（`seq`）付きでメモリ上のログに追記され、後から購読したクライアントに取りこぼしなくリプレイできる。
3. **停止は明示的に**: SSE 切断では止めない。`POST /stop` のみが実行を中断し、未配信の入力（BFF の配送待ちと SDK の実キュー）を回収して未送信として残す。

## 版の互換の範囲

client・BFF・サンドボックスは同じイメージで配る（`Dockerfile` の `final` を共有し、command だけを変える）。**サポートするのは、同じイメージから配られた組み合わせだけ**とする。版が食い違う組み合わせ（新 client × 旧 BFF、BFF × 旧サンドボックスなど）は互換の契約にせず、片側だけを更新した環境で動くことを約束しない。

この節は「どの分岐を残すか」だけを決める。版だけが理由の分岐はここでは消さず、決定を受けた別の変更で消す。消すコードと、そのコードだけを固定しているテストは同時に消してよい（Epic の共通の制約の例外）。

- **残す**: 版以外の理由でも通る分岐。サーバー再起動・SSE の取りこぼし・保存済みデータの欠け・セッション消滅・`payload.messages` からの初期表示・capability の不一致の診断・`gitConfig` / `networkAccess` の省略・予約名の除去・古い SDK が書いた履歴の値欠けの縮退。
- **消す**: 版だけが理由の分岐。現行のイメージが常に載せる値の「無いとき」の縮退、旧 client 専用の HTTP の互換名、旧 client のためだけに残した DTO のフィールド。
- **保存済みデータの互換**: 旧 meta / JSONL / `sends.json` / DB の移行 / 旧 URL の読み替え / 旧カタログのスキル名の表示は、版の互換とは別に残す。永続ボリュームに残るデータを読めなくしない。
- **旧 SDK**: オブジェクトの形が欠けることは想定しない。依存は固定ではないが、実運用では起こらない。型は SDK とテストのスタブに合わせ、コードは変えない（コメントの整理で直す）。
- **版ずれの案内**: 版が食い違うことを検知して利用者へ再読み込みを促すかは、新しい挙動として別に決める。この節は案内を出さないことを決めていない。

| 想定 | 組み合わせ | 扱い | 理由 |
| --- | --- | --- | --- |
| 送信IDを持たない応答を、run id → 本文の順に突き合わせる縮退 | 新 client × 旧サーバー | 残す | 版以外でも通る（サーバー再起動・保存前に再起動した履歴・応答IDが片方にしか無い保存済みの履歴） |
| 履歴 API の 404 で `payload.messages` の全量へ表示を戻す | 新 client × 旧サーバー | 残す | 版以外でも通る（セッション消滅） |
| 開始時刻・所要時間を載せない応答（`startedAt` / `durationMs`） | 新 client × 旧サーバー | 消す | 版だけが理由。現行は常に載せる |
| SSE の識別子の省略（`initialSendId` / `assistantId` / `sendId` / `sendIds` / `model`） | 新 client × 旧サーバー | 消す | 版だけが理由。現行は常に載せる（`model` の `null` は「生成元が不明」で、欠けではない） |
| payload と一覧の省略（`pendingSends` / `canHandoff` / `hasRawLog` / `networkAccess` / `notify` / `titleSummary` / `historyGeneration` / `pinned`） | 新 client × 旧サーバー | 消す | 版だけが理由。現行は常に載せる |
| `tool_end.endedAt` を載せないツール | 新 client × 旧サーバー | 残す | 版以外でも通る（開始を観測しなかったツール。run の外で始まった・取りこぼした） |
| `pendingSends[].position` を載せない送信 | 新 client × 旧サーバー | 残す | 版以外でも通る（キューに無い送信。steering へ移った・注入済み） |
| `assistantMeta` のキー省略 | 新 client × 旧サーバー | 残す | 版以外でも通る（載せる応答が無い） |
| 保存済みデータの欠け（`pinned` / `parentSessionId` / `handoff` / 履歴の `model` と usage など） | — | 残す | 永続ボリュームに残るデータを読めなくしない。`null` と「生成元が不明」は区別して残す |
| SSE カーソルの数値のみ | 旧 client × 新サーバー | 残す | 現行 client も世代が空なら数値だけを送る。どちらも resync に収束する |
| notifications の部分更新（省略 = 据え置き） | 旧 client × 新サーバー | 残す | `enabled` と同じ部分更新の契約で、版に依らない |
| `resendRunId`（`resendSendId` の互換名） | 旧 client × 新サーバー | 消す | 版だけが理由。現行 client は `resendSendId` を送る |
| `POST /api/sessions/:id/abort` のエイリアス | 旧 client × 新サーバー | 消す | 版だけが理由。現行 client は `POST /stop` を呼ぶ |
| `usedBy.builtin` | 旧 client × 新サーバー | 消す | 版だけが理由。サーバーは常に `false` を返すので、client の `promptUsageLabel` の「（組み込み）」は出ない |
| `gitConfig` / `networkAccess` の省略 | BFF × 旧 sandbox / 旧 BFF | 残す | 現行の BFF も、serve の起動・停止や identity を注入できない実行では省略する |
| 予約名（Git identity を差し替える環境変数）の除去 | BFF × 旧 sandbox / 旧 BFF | 残す | 保存済みの環境変数の行を守る。`gitConfig` 付きの実行は現行でも剥がす |
| capability の不一致の診断（`git-config-v1` / `egress-policy-v1`） | BFF × 旧 sandbox / 旧 BFF | 残す | サンドボックスを差し替えた環境でも診断は害が無く、bash を止めない |
| `network-access.ts` の既定 `allow` | — | 残す | 版以外でも通る（承認 UI を持たない API 直叩きの経路） |
| 旧 SDK のオブジェクトの形の欠け | 旧 SDK | 想定しない | 実運用では起こらない。型は SDK とテストのスタブに合わせ、コードは変えない |

表に無い「旧〜」の分岐を新しく足さない。版以外の理由が無いことを確かめずに、版だけの分岐を残さない。

## 責務の所在

| 責務 | 正 | 変更テーマ |
| --- | --- | --- |
| ラン / 未配信入力（送信ID）の配送 / 購読 / セッション状態 | `server/src/sessions.ts` | [run-lifecycle.md](run-lifecycle.md) |
| 調査の子セッション（investigate） | `server/src/investigate-tool.ts`、`server/src/investigate-runner.ts` | [subagent.md](subagent.md) |
| 会話ストア（永続化 / 復元） | `server/src/session-store.ts` | [session-files.md](session-files.md)、[persistence.md](persistence.md) |
| 会話の引き継ぎ（ファイルの移動 / メモの書込み / 確定と巻き戻し） | `server/src/handoff-move.ts` | [run-lifecycle.md](run-lifecycle.md#引き継ぎと復旧) |
| 会話履歴のクリア（meta の書換え / 履歴と実測の削除 / 確定と片付け） | `server/src/history-clear.ts` | [session-files.md](session-files.md#ライフサイクルと排他)、[api-session-state.md](api-session-state.md#post-apisessionsidhistoryclear) |
| 会話の分岐（親の読み直し / 境界までの複製 / 子の保存と巻き戻し） | `server/src/fork-session.ts` | [run-lifecycle.md](run-lifecycle.md#分岐) |
| 会話タイトルの AI 要約の進行（1 会話 1 試行 / 順番待ち / 適用 / 取消） | `server/src/title-summary-progress.ts` | [session-title.md](session-title.md) |
| pi イベント → SSE イベント変換 | `server/src/run-events.ts` | [run-lifecycle.md](run-lifecycle.md) |
| 履歴 / payload / compaction の DTO 組み立て | `server/src/session-projection.ts`、`session-payload.ts`、`compaction-view.ts` | [run-lifecycle.md](run-lifecycle.md)、[compaction.md](compaction.md) |
| HTTP 契約（DTO の正） | `server/src/schema.ts` | [api.md](api.md) |
| ルート登録のフェーズと `AppType` | `server/src/app.ts`、`server/src/routes/` | [api.md](api.md) |
| pi ランタイム / モデル解決 | `server/src/agent.ts`、`server/src/model-state.ts` | [model-effort.md](model-effort.md) |
| 組み込みツール（Web 検索 / 画像生成 / 音声生成） | `server/src/web-search-tool.ts`、`server/src/image-tools.ts`、`server/src/speech-tools.ts` | [web-search.md](web-search.md)、[image-generation.md](image-generation.md)、[speech-generation.md](speech-generation.md) |
| プロジェクトと cwd | `server/src/projects.ts` | [projects.md](projects.md) |
| ツール実行のサンドボックス | `server/src/sandbox/` | [sandbox.md](sandbox.md) |
| 同梱のヘッドレスブラウザ | `server/src/browser/` | [browser.md](browser.md) |
| サービスの状態と起動・停止 | `server/src/serve.ts`、`server/src/serve-tool.ts`、`server/src/routes/serve.ts` | [sandbox.md](sandbox.md)、[api-sharing.md](api-sharing.md#サービスserveの状態と起動停止) |
| 共有した静的コンテンツの記録と公開（Cloudflare） | `server/src/shared-content-repository.ts`（`shared_contents` / `shared_content_settings`）、`server/src/app-db.ts`（`cloudflare_settings`）、`server/src/shared-contents.ts`、`server/src/shared-content-rules.ts`、`server/src/cloudflare-api.ts` | [static-sharing.md](static-sharing.md) |
| サービス オリジンの転送と公開ポート | `server/src/service-proxy.ts`、`server/src/preview-port.ts`、`server/src/index.ts` | [sandbox.md](sandbox.md#serveサービスの公開と起動停止) |
| 秘密値のマスク | `server/src/redact.ts`、`server/src/secret-guard.ts` | [secrets.md](secrets.md) |
| クライアント（状態 / テーマ / レイアウト） | `client/src/` | [frontend.md](frontend.md)、[ui-layout.md](ui-layout.md) |

セッション状態の所有者は `SessionStore` 1 つに保つ（create と project 削除・settings 変更中の送信抑止・未配信入力 / run / subscriber は複数箇所へ分けると競合を追えなくなる）。pi イベント変換と DTO 組み立ては純関数・アダプタとして外へ出し、ストア本体はライフサイクルだけを持つ。引き継ぎのファイルと保存の手順も `handoff-move` へ出し、`SessionStore` は予約・確定・配信の順序だけを呼ぶ。履歴クリアの保存と削除の手順は `history-clear` へ出し、同じく `SessionStore` は検証と予約・確定・配信の順序を持つ。分岐のファイルと保存の手順は `fork-session` へ出し、`SessionStore` は予約（`lifecycle` / `pendingMoves`）・確定・配信の順序だけを呼ぶ。会話の読み書きは `session-store` へ出し、SDK セッションは `SessionManager.inMemory` + entries として扱う（ファイルは SDK に持たせない）。

## ドキュメントの読み方

変更テーマ別の入口は [README.md](README.md) の索引にまとめている。個別の設計は次のドキュメントを正とする。

- ランとセッション: [run-lifecycle.md](run-lifecycle.md)
- 調査の委譲: [subagent.md](subagent.md)
- プロジェクトと cwd: [projects.md](projects.md)
- モデル / Effort: [model-effort.md](model-effort.md)
- アプリ側の組み込みツール: [web-search.md](web-search.md) / [image-generation.md](image-generation.md) / [speech-generation.md](speech-generation.md)
- サンドボックス: [sandbox.md](sandbox.md) / [sandbox-api.md](sandbox-api.md) / [browser.md](browser.md)
- 静的コンテンツ共有: [static-sharing.md](static-sharing.md)
- APIキー保護: [secrets.md](secrets.md)
- フロントエンド: [frontend.md](frontend.md) / [ui-layout.md](ui-layout.md)
- 圧縮表示: [compaction.md](compaction.md)
- 永続化: [persistence.md](persistence.md)
