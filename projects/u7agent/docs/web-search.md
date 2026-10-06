# Web 検索（web_search ツール）

チャットのセッションから Web 検索できるようにする。BFF ローカルの `web_search` ツール（`server/src/web-search-tool.ts`）が keyless な Exa MCP へ JSON-RPC の `tools/call` を 1 回送り、上位 5 件を出典一覧 + 抜粋へ整形して返す。URL の中身を読むのは従来どおりサンドボックスの `bash` + `curl` で、本文取得（`fetch_content` 相当）は持たない。

- 依存先は **keyless な Exa MCP**（`https://mcp.exa.ai/mcp`）で、v1 はこの固定。API キーの登録・provider 選択は持たず、アプリ DB の行は有効 / 無効のトグル（下の「実行時トグル」）だけ
- ツールは **BFF ローカル**。サンドボックスのリモート定義ではなく、`createRemoteToolDefinitions` / `REMOTE_TOOL_NAMES` の外にあり、`PI_AGENT_TOOLS` の影響を受けない。`configuredTools()` の結果はそのまま `createRemoteToolDefinitions` へ渡り、未知の名前は `UnknownRemoteToolError` になるため、`web_search` を混ぜてはならない（[sandbox.md](sandbox.md)）
- セッションの `tools` へは `withWebSearchTool()`、`customTools` へは `createWebSearchToolDefinitions()` で足す（`server/src/agent.ts`）。**ツール一覧からは外せない**（`PI_AGENT_TOOLS` の対象外）代わりに、[実行時トグル](#実行時トグル設定--モデルの-web-検索タブ)で OFF にできる
- 検索は `fetch` だけで完結し、BFF から子プロセスを起こさない（[secrets.md](secrets.md) のレイヤー 1）
- クエリは `mcp.exa.ai` へ渡る。自己ホスト構成でも外部送信先が 1 つ増える
- Remote MCP の Registry とエージェントごとの tool allowlist には載せない（MCP クライアントを介さない BFF の固定ツール）。pi SDK 拡張の読み込みも行わない（`noExtensions: true` を維持する）

## 引数とリクエスト

引数は `query` だけ。空文字と空白のみは schema で弾く（`minLength` だけでは `"   "` が通るため `pattern` も付ける）。弾かれたときは execute が呼ばれず、SDK の引数検証の文言がそのままモデルへ返る。

- `POST https://mcp.exa.ai/mcp?tools=web_search_advanced_exa` へ JSON-RPC の `tools/call` を 1 回送る。引数は `{ query, type: "auto", numResults: 5, enableHighlights: true, textMaxCharacters: 2000 }`
- `numResults` / `type` は固定で、モデルには見せない（`recencyFilter` / `domainFilter` / `queries` は非ゴール）
- ヘッダは `Content-Type: application/json` と `Accept: application/json, text/event-stream`。片方だけだと Exa は HTTP 406 で拒否する
- 期限は自前の `AbortController` + タイマーで 60 秒。ユーザー中断（`signal.aborted`）とは別コード・別文言で扱う（`AbortSignal.any()` で包むと区別できない）
- `fetchImpl` を注入できる。自動テストは実 API を呼ばず、スタブで検証する

## 応答の解釈

- 応答は `text/event-stream`。まず `data:` 行だけを拾って JSON parse し、見つからなければ本文全体を JSON として parse する 2 段（`Accept` で両方を要求する契約なので、どちらでも解釈する）。1 イベントが複数の `data:` 行へ分かれる場合は連結してから解釈する
- 取り出すのは `result.content[0].text` に入った **JSON 文字列**。`JSON.parse` して `results[]` を読む
- 使うのは `results[].{title, url, text, highlights[]}`。`enableHighlights: true` で `highlights: string[]` が付く。`id` / `image` / `publishedDate` は v1 では使わない

## 結果の整形

- 本文の**先頭に出典一覧**（`[n] <title> — <url>`）を置く。チャットのツール履歴は出力の先頭 900 字しか出さない（`server/src/session-projection.ts` の `SUMMARY_TEXT_MAX`）ため、先頭にまとめると履歴でも出典が残る
- 続けて各件の抜粋を並べる。`highlights` を連結し、無ければ `text` を使う
- 1 件あたり **1,500 字**で切る。`textMaxCharacters` が切るのは `results[].text` だけで `highlights` は切られない（実測で highlights 1 件が 5,711 字になった）
- **合計 12,000 字**を超えたら末尾を落とし、`... [truncated]` を付ける。SDK は customTool の結果を長さで丸めないため、上限はツール側の責務
- `details` / `structuredContent` / `outputSchema` は持たない（text だけ）
- **切り詰める前にマスクする。** `wrapToolDefinitionWithSecretMasker` が掛かるのは execute の後で、`maskSafe` が拾えるのは先頭が秘密値の末尾と一致する断片と `... [truncated]` の直前だけ（`server/src/redact.ts`）。自前の `slice` の末尾に残った秘密値の前半分は検出されないため、execute が 1 件ずつと全体の切り詰めの前に `masker.mask()` を通す

## 失敗の分類

Exa MCP は失敗を HTTP ステータスで返さない。すべて固定文言にし、上流の応答本文はモデル・ログ・UI へ出さない。判定は **HTTP ステータスを先に見て**、200 のときだけ本文を見る（406 は JSON-RPC の `error` としても返るが、HTTP の行で分類する）。

| 条件 | 文言 |
| --- | --- |
| JSON-RPC の `error` | 検索プロバイダが想定外の応答を返しました |
| `result.isError === true`（未知ツール・引数不正。HTTP 200） | 検索プロバイダのエラーが発生しました |
| `result._meta["ai.exa/rateLimited"] === true`（無料枠の制限。HTTP 200） | 検索が混雑しています（無料枠のレート制限） |
| `content[0].text` が JSON として parse できない / `results` が配列でない | 検索プロバイダが想定外の応答を返しました |
| `results` が空配列 | **正常系。**「結果が見つかりませんでした」を返す（JSON なので 0 件と解釈不能を区別できる） |
| HTTP 406 / 5xx / その他 | 検索プロバイダのエラーが発生しました（406 は実装ミスの検知にも効く） |
| ネットワーク例外 | 検索プロバイダに接続できませんでした（例外の文言はマスクして 500 字まで添える） |
| タイムアウト | `web_search` がタイムアウトしました |
| `signal.aborted` | `web_search` を中断しました |

- advanced ツールが `mcp.exa.ai` から消えた場合は `isError` の固定文言で失敗する（basic への自動フォールバックは持たない）
- レート制限は HTTP 200 で返るため、判定を実装しないと制限の文言を検索結果として整形してしまう

## 実行時トグル（設定 → モデルの Web 検索タブ）

第三者ホスト（keyless な Exa MCP）を**その場で止めたい**ときのための、アプリ全体の OFF スイッチ。環境変数（起動時に固定）ではないので、デプロイも再起動も要らない。

- 正はアプリ DB の `web_search_settings`（id = 1 の 1 行、`enabled`）で、**行が無い = 既定（有効）**。無効化のためにデプロイを要する設計にしないことが目的なので、既定は ON（[persistence.md](persistence.md#アプリデータsqlite)）
- ツールは `execute` のたびに `readEnabled()` を読む。**セッション作成時に凍結しない**ため、OFF にした瞬間から既存のセッションの次の呼び出しにも効く（ツール一覧は新しい会話にしか効かないので、実行時に拒否する）
- OFF の間は検索も送信もしない。`mcp.exa.ai` への `fetch` を呼ばず、固定文言 `WEB_SEARCH_DISABLED_MESSAGE`（「Web 検索は無効化されています。有効にするには 設定 → モデル → Web 検索 を開いてください。」）で throw する。設定画面は API が返す `disabledMessage` をそのまま出す
- 経路は 設定サービス（`server/src/web-search-settings.ts`）→ `PiBff.setWebSearchEnabled()` → ツールの `readEnabled()`。書き込みと `applyStored()` は `MutationLock` の内側で直列化する（画像生成と同じ形）
- DB を読めない起動でも**有効**で立ち、警告だけを残す（行が無い = 既定と同じ扱いにし、読めないだけで検索を黙って止めない）。設定 API は DB の 503 で気付ける（[persistence.md](persistence.md#アプリデータsqlite)）
- モデルから見るとツールは存在したままなので、無効時もモデルは呼べて、そのたびに固定文言の失敗が返る（無駄な往復を避けたくなったら system prompt / `promptGuidelines` への反映を別途検討する）

## 設定

- 有効 / 無効のほかは API キー・provider 選択（Brave / Tavily 等）を持たない（v1 は keyless な Exa 固定）。有料キーによるレート制限回避も非ゴール（provider の抽象化と選択は #1776）
- 環境変数は増やさない（[.env.example](../.env.example) に変更は無い）
- 常時公開で、`PI_AGENT_TOOLS` などからは外せない
- 検索前の確認ダイアログは持たない。SDK の `ctx.ui.confirm()` は BFF（`noExtensions: true`）では使えない（`ask_user` の待機機構が入ってから別途）

## 検証

実 API は呼ばず、`fetchImpl` のスタブで検証する。

| テスト | 固定すること |
| --- | --- |
| `server/test/web-search-tool.test.ts` | 無効の間は `fetch` を呼ばず固定文言で throw し、同じ定義のまま ON に戻すと検索すること / 引数 → リクエスト body（`tools/call` / `query` / `numResults: 5` / `type: "auto"` / `enableHighlights` / `textMaxCharacters`）と URL・`Accept` ヘッダ / `text/event-stream` の解釈（`data:` 行のみ・複数行・本文全体が JSON）/ 結果の整形（出典一覧が先頭・highlights の採用・`text` フォールバック）/ 1 件と合計の切り詰め / 失敗の分類（`isError`・レート制限・JSON でない `content[0].text`・HTTP 406・5xx・ネットワーク例外・タイムアウト・ユーザー中断）/ `results: []` が正常系 / `query` の空文字・空白のみ / 切り詰め前のマスク / `web_search` がサンドボックスの allowlist に入らないこと |
| `server/test/web-search-settings.test.ts` | 行が無い = 既定（有効）/ PUT の往復と写しの差し替え / 保存できないときは 503 で写しも変えない / 起動時に DB を読めないときは有効で立つ |
| `server/test/web-search-settings-api.test.ts` | `GET` / `PUT /api/settings/web-search` の往復、`state: "applied"`、再起動後も残ること、Zod 検証での 400 |
| `server/test/app-db.test.ts` | v11 → v12 の加算移行と `web_search_settings` の往復（id = 1 の 1 行） |
| `client/test/webSearchSettings.test.ts` / `client/test/webSearchSettingsTab.test.ts` / `client/test/modelSettingsPage.test.ts` | 状態バッジと文言、有効 / 無効の描画（OFF では固定文言も出す）、保存中の disable、タブの語彙と URL |

実セッション（GUI）での受入は手動で 1 回行う。`mcp.exa.ai` への実到達とデプロイ先コンテナからの到達性、GUI の停止ボタンで中断できること、ツール履歴の先頭 900 字に出典一覧が入ることを確かめる。

## 残る懸念

- 無効化は実行時の拒否なので、モデルから見るとツールは存在したままになる（無駄な往復を避けたい場合の対処は上の「実行時トグル」に書いた）
- 無効の間もチャットのツール履歴には失敗した呼び出しが残る（意図どおり。実行しなかったことは履歴から読み取れる）
- keyless Exa MCP の可用性・レート制限は第三者ホストへの依存で、SLA も保証もない
- クエリは `mcp.exa.ai` へ渡る（外部送信先が 1 つ増える）
- ツール履歴は出力 900 字で切れるため、出典一覧を先頭に置いても全件は見えない可能性がある（必要になったら専用カードを別途）
- 本文を持たない assistant に属するツール履歴は、同じ user ターン内に表示可能な assistant が無いと復元されない（既存の全ツール共通の制限。[api-sessions.md](api-sessions.md)）
