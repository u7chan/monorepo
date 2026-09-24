# Discord 通知

会話（セッション）ごとのトグルが On のとき、エージェントの応答が返ってきたら Discord の Incoming Webhook へ 1 通送る。ブラウザを閉じてもランは BFF で続く（[run-lifecycle.md](run-lifecycle.md)）ため、離席中に終わったことを Discord で知るための仕組み。プロバイダーは Discord だけを対象にする。

正は `server/src/notifications.ts`（設定の読み書き・宛先検証・送信・直近結果・専用マスク）で、ルートは `server/src/routes/notifications.ts`、per-session のトグルは `server/src/sessions.ts` の `setNotify()` が持つ。設定画面は `client/src/components/NotificationSettingsPage.tsx` と `client/src/components/notifications/`。

## 送るタイミング

- トリガーは `SessionStore.finish()` が `run_end` を記録する 1 点だけ。`status === "completed"` かつ最終 assistant の本文が空でないとき、**1 通**送る
- 送信は fire-and-forget で、`run_end` の記録・`persist`・キューの pump を待たせない。fetch の例外はすべて捕捉し、失敗してもランは完了する。プロセス終了時に未完了の送信は破棄する（結果も記録しない）
- 送るかどうかは **finish 時点の `notify`** で決まる。本文はそのランで確定した最終 assistant テキストだけで、履歴は遡らない（assistant を生成しなかったランで前の応答を再送しない）
- エラー / 停止 / 圧縮の通知は送らない。通知履歴は直近 1 件だけ保存する

### 送る内容

```
✅ 完了  <会話のタイトル>
<エージェント名> ・ <実行時間> ・ ツール <n>件
<最終 assistant テキストの先頭 200 文字>
<ベース URL>/s/<sessionId>          ← ベース URL 未設定なら行ごと出さない
```

- 本文は **mask → truncate** の順（逆順だと上限の境界でキーの末尾が欠ける）。mask は APIキーの masker と Webhook URL の専用マスクの両方
- メンションは本文ではなく `allowed_mentions` だけで決める（なし = `parse: []` / @here = `parse: ["everyone"]`）。本文中の `@everyone` やロールメンションは無効
- **会話のタイトル・エージェント名・応答本文の先頭 200 文字が Discord へ送られる。** 機微な内容を扱う会話は通知を Off にする
- テスト送信は実通知と区別できる本文（`🧪 テスト通知  u7agent`）で、保存済み設定を使って 1 通送る。通知の有効 / 無効には関係しない

## API 契約

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/notifications` | `{ enabled, provider: "discord", configured, webhookHint?, baseUrl?, mention, lastResult? }` |
| PUT | `/api/notifications` | `{ enabled?, webhookUrl?（null で解除）, baseUrl?（null で解除）, mention? }`。宛先とベース URL を検証し、保存時に送信テストはしない |
| POST | `/api/notifications/test` | 保存済み設定で 1 通。`{ ok, status, latencyMs, message?, code?, at }` を 200 で返す（アプリ側のエラーだけ 4xx）。タイムアウトは 5 秒 |
| PATCH | `/api/sessions/:id/notify` | `{ notify: boolean }` → `{ sessionId, notify }` を 200 で返す |
| POST | `/api/sessions` | `notify?: boolean`（新規チャットで選んだ値を、作成されるセッションへ引き継ぐ） |
| GET | `/api/sessions` / `/api/sessions/:id` | `notify: boolean`（サーバーは常に載せ、読む側は省略を false として扱う） |

- `PATCH /api/sessions/:id/notify` は専用経路。Model / Effort の `PATCH /settings` には相乗りせず、SDK の設定変更も busy 判定も通さないため実行中でも切り替えられる。live / 未ロードのどちらでも同じ応答で、会話全文は返さない（未ロードでは SDK セッションを開かない）。未知の id は 404
- 直近結果（`lastResult`）は通常通知とテスト送信で共通の 1 件。送信開始の世代で新しい方を優先し、古い完了で新しい結果を上書きしない。Webhook URL を変えるとクリアする。再起動後は SQLite から復元する
- 失敗の表示に使うのは status と Discord の `message` / `code` だけ。リクエスト URL とレスポンス原文は API 応答にも画面にも出さない

## セキュリティ

### Webhook URL は write-only

- `GET /api/notifications` は `configured` と `webhookHint`（末尾 4 文字）だけを返し、保存済み URL は API 応答にも画面にも再表示しない。変更するときは空の入力から入れ直す
- URL 全体と `/api/webhooks/…` 以降を `[REDACTED]` へ置換する専用マスクを `server/src/notifications.ts` に置き、API 応答・ログ・エラー本文・fetch 例外へ通す。変更直後も旧 URL をマスクできるよう、メモリ上に直前の値を数件保持する

### 宛先の制限（SSRF / リダイレクト）

- `PUT /api/notifications` が許可するのは `https://discord.com/api/webhooks/<id>/<token>` の形だけ。host は `discord.com` 固定（`discordapp.com` やサブドメインは不可）、パスは `/api/webhooks/` で始まる 2 セグメントで、userinfo / クエリ / フラグメント / 非標準ポートは 400
- 送信は `redirect: "error"` でリダイレクトを追わない（3xx でもトークンを転送しない）。例外のメッセージへ URL を入れない（`server/src/app.ts` の onError がそのまま応答本文へ載せる経路があるため）
- ベース URL は `http` / `https` の origin だけを許可する。`/s/<id>` の組み立ては `new URL()` + `encodeURIComponent` で行う

## 保存先と再起動後

- 会話ごとの `notify` は `SessionMeta`（`meta.json`）に保存する。`version: 1` のまま optional フィールドとして足し、boolean 以外は無視する。live な record は in-memory の meta を更新し、既存の書込みキューで永続化する。一覧（live / 未ロードの descriptor）・`SessionPayload`・`resync` は同じ値を使う。保存に失敗したら 500 を返し、成功扱いにしない
- グローバル設定はアプリデータの SQLite（`PI_SESSION_STORE/u7agent.db`）の `notification_settings`（1 行）に保存する。`APP_DB_SCHEMA_VERSION` は 2 で、移行は `CREATE TABLE IF NOT EXISTS` + `user_version` 更新の**加算的**なもの。既存のエージェント / スキル / プロジェクトは消えない（[persistence.md](persistence.md)）
- どちらも会話ストアと同じ永続ボリュームに載るため、再起動後も復元される

## 設定画面（設定 → 通知）

- **Discord カード**: 有効トグルと Webhook URL。保存済みなら「登録済み（末尾 xxxx）」+ `[変更]` を出し、`[変更]` を押したときだけ入力欄を出す（保存済みの値は入れない）。`[取り消し]` で編集をやめる
- **テスト送信カード**: 未設定なら無効 + 「Webhook URL を保存するとテストできます。」。URL に未保存の変更があるときはラベルが「保存してテスト」になり、保存してから送る。直近結果（日時 / status / latencyMs）と失敗理由を出す
- **リンクカード**: 通知から会話を開く URL のベース。`[今開いている URL を使う]` で `location.origin` を入れる。空にするとリンク行を載せない
- **メッセージカード**: メンション（なし / @here）とプレビュー。プレビューは見本で、実データはサーバーが組み立てる
- 編集はすべて下書きで、`[保存]` が PUT、`[破棄]` が保存済みの値へ戻す。`webhookUrl` は「変更」で新しく入力したときだけ送り、空にすると解除（null）。`baseUrl` は空なら null
- 設定ナビの「通知」の行には、直近の送信が失敗しているときだけ ⚠ を出す。直近結果は 4 秒ごとに取り直すため、バックグラウンドのラン完了で失敗してもリロードなしで反映される

### リンクの制約

- 既定の `http://127.0.0.1:5173` は**同じ端末のブラウザでしか開けない**（スマホから開くにはトンネル / VPN が要る）
- このアプリには認証がない。**LAN / インターネットへ公開しない**（[README](../README.md#セキュリティ) の警告と同じ）

## 非ゴール

- Slack / メール等の他プロバイダー、複数チャンネル、プロジェクト別の振り分け
- 実行時間の下限・まとめ送り・「タブを開いている間は送らない」などの配信制御
- エラー / 停止 / 圧縮の通知（「エラーも送る」は将来）
- 通知履歴の保存（直近 1 件だけ）と本文のカスタムテンプレート
