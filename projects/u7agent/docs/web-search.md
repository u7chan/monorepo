# Web 検索（web_search ツール）

チャットのセッションから Web 検索できるようにする。BFF ローカルの `web_search` ツール（`server/src/web-search-tool.ts`）が keyless な Exa MCP へ JSON-RPC の `tools/call` を 1 回送り、上位 5 件を出典一覧 + 抜粋へ整形して返す。URL の中身を読むのは従来どおりサンドボックスの `bash` + `curl` で、本文取得（`fetch_content` 相当）は持たない。

- 依存先は **keyless な Exa MCP**（`https://mcp.exa.ai/mcp`）。キーが無ければこの URL へ落ちる。API キーの登録・アプリ DB の行・設定タブ・provider 選択は作らない
- ツールは **BFF ローカル**。サンドボックスのリモート定義ではなく、`createRemoteToolDefinitions` / `REMOTE_TOOL_NAMES` の外にあり、`PI_AGENT_TOOLS` の影響を受けない。`configuredTools()` の結果はそのまま `createRemoteToolDefinitions` へ渡り、未知の名前は `UnknownRemoteToolError` になるため、`web_search` を混ぜてはならない（[sandbox.md](sandbox.md)）
- **常時公開。** v1 では設定で切る導線を持たない（`ask_user` と同じ扱い）。セッションの `tools` へは `withWebSearchTool()`、`customTools` へは `createWebSearchToolDefinitions()` で足す（`server/src/agent.ts`）
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

## 設定

- API キー・アプリ DB の行・設定タブ・provider 選択（Brave / Tavily 等）を持たない。有料キーによるレート制限回避も非ゴール
- 環境変数は増やさない（[README.md](../README.md) の環境変数表に変更は無い）
- 常時公開で、`PI_AGENT_TOOLS` などからは外せない
- 検索前の確認ダイアログは持たない。SDK の `ctx.ui.confirm()` は BFF（`noExtensions: true`）では使えない（`ask_user` の待機機構が入ってから別途）

## 検証

実 API は呼ばず、`fetchImpl` のスタブで検証する。

| テスト | 固定すること |
| --- | --- |
| `server/test/web-search-tool.test.ts` | 引数 → リクエスト body（`tools/call` / `query` / `numResults: 5` / `type: "auto"` / `enableHighlights` / `textMaxCharacters`）と URL・`Accept` ヘッダ / `text/event-stream` の解釈（`data:` 行のみ・複数行・本文全体が JSON）/ 結果の整形（出典一覧が先頭・highlights の採用・`text` フォールバック）/ 1 件と合計の切り詰め / 失敗の分類（`isError`・レート制限・JSON でない `content[0].text`・HTTP 406・5xx・ネットワーク例外・タイムアウト・ユーザー中断）/ `results: []` が正常系 / `query` の空文字・空白のみ / 切り詰め前のマスク / `web_search` がサンドボックスの allowlist に入らないこと |

実セッション（GUI）での受入は手動で 1 回行う。`mcp.exa.ai` への実到達とデプロイ先コンテナからの到達性、GUI の停止ボタンで中断できること、ツール履歴の先頭 900 字に出典一覧が入ることを確かめる。

## 残る懸念

- keyless Exa MCP の可用性・レート制限は第三者ホストへの依存で、SLA も保証もない
- クエリは `mcp.exa.ai` へ渡る（外部送信先が 1 つ増える）
- ツール履歴は出力 900 字で切れるため、出典一覧を先頭に置いても全件は見えない可能性がある（必要になったら専用カードを別途）
- 本文を持たない assistant に属するツール履歴は、同じ user ターン内に表示可能な assistant が無いと復元されない（既存の全ツール共通の制限。[api-sessions.md](api-sessions.md)）
