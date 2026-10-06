# Web 検索（web_search ツール）

チャットのセッションから Web 検索できるようにする。BFF ローカルの `web_search` ツール（`server/src/web-search-tool.ts`）が、設定で選んだ provider へ検索を 1 回投げ、上位 5 件を出典一覧 + 抜粋へ整形して返す。URL の中身を読むのは従来どおりサンドボックスの `bash` + `curl` で、本文取得（`fetch_content` 相当）は持たない。

- モデルへ公開するのは **単一の `web_search(query)`**。provider の選択はモデルに渡さず、BFF 側で「既定の検索プロバイダー」を解決して実行する
- provider は `server/src/web-search-providers.ts` の adapter。**endpoint・request / response の形式・失敗の分類**を持ち、モデル向けの契約（引数・整形・上限・timeout / abort・マスク）は `web-search-tool.ts` が持つ
- 結果は provider ごとの差を **共通形式 `WebSearchResultItem[]`（`title` / `url` / `excerpt`）へ正規化**する。モデルから見た Tool Schema は provider を変えても変わらない
- ツールは **BFF ローカル**。サンドボックスのリモート定義ではなく、`createRemoteToolDefinitions` / `REMOTE_TOOL_NAMES` の外にあり、`PI_AGENT_TOOLS` の影響を受けない。`configuredTools()` の結果はそのまま `createRemoteToolDefinitions` へ渡り、未知の名前は `UnknownRemoteToolError` になるため、`web_search` を混ぜてはならない（[sandbox.md](sandbox.md)）
- セッションの `tools` へは `withWebSearchTool()`、`customTools` へは `createWebSearchToolDefinitions()` で足す（`server/src/agent.ts`）。**ツール一覧からは外せない**（`PI_AGENT_TOOLS` の対象外）代わりに、[実行時トグル](#実行時トグル設定--モデルの-web-検索タブ)で OFF にできる
- 検索は `fetch` だけで完結し、BFF から子プロセスを起こさない（[secrets.md](secrets.md) のレイヤー 1）
- クエリは既定 provider のホスト（Exa なら `mcp.exa.ai`、Tavily なら `api.tavily.com`）へ渡る。自己ホスト構成でも外部送信先が 1 つ増える
- Remote MCP の Registry とエージェントごとの tool allowlist には載せない（MCP クライアントを介さない BFF の固定ツール）。pi SDK 拡張の読み込みも行わない（`noExtensions: true` を維持する）

## provider

| id | 表示名 | 送信先 | キー | request |
| --- | --- | --- | --- | --- |
| `exa` | Exa | `mcp.exa.ai` | 不要（keyless） | JSON-RPC の `tools/call`（`web_search_advanced_exa`） |
| `tavily` | Tavily | `api.tavily.com` | 必要（`Bearer tvly-...`） | `POST /search` へ `{ query, search_depth, max_results }` |

- 既定は `exa`（既存の挙動を変えない）。保存値が無い / 未知の値のときも `exa` へ畳む
- **provider 間の自動 fallback はしない。** Tavily が失敗しても Exa で再検索しない。外部送信先と課金先が暗黙に変わらず、失敗原因が画面とログから読めるようにするため。Primary / Fallback を明示設定する機能は持たない
- provider を増やすときは adapter と `WEB_SEARCH_PROVIDERS` へ足し、`client/src/lib/providerIcon.ts` にロゴ（無ければ頭文字）を対応づける。選択肢は API の応答（`providers[]`）から作るため、GUI の一覧はサーバーが正

### Exa

- `POST https://mcp.exa.ai/mcp?tools=web_search_advanced_exa` へ JSON-RPC の `tools/call` を 1 回送る。引数は `{ query, type: "auto", numResults: 5, enableHighlights: true, textMaxCharacters: 2000 }`（`numResults` / `type` は固定で、モデルには見せない）
- ヘッダは `Content-Type: application/json` と `Accept: application/json, text/event-stream`。片方だけだと Exa は HTTP 406 で拒否する
- 応答は `text/event-stream`。まず `data:` 行だけを拾って JSON parse し、見つからなければ本文全体を JSON として parse する 2 段（`Accept` で両方を要求する契約なので、どちらでも解釈する）。1 イベントが複数の `data:` 行へ分かれる場合は連結してから解釈する
- 取り出すのは `result.content[0].text` に入った **JSON 文字列**。`JSON.parse` して `results[]` を読む。使うのは `results[].{title, url, text, highlights[]}` で、`highlights` を連結し、無ければ `text` を使う（`id` / `image` / `publishedDate` は使わない）
- Exa は失敗を HTTP ステータスで返さない。未知ツールも無料枠のレート制限も **HTTP 200** で返るため、本文の判定を provider 側に閉じ込める
- advanced ツールが `mcp.exa.ai` から消えた場合は `isError` の分類で失敗する（basic への自動フォールバックは持たない）

### Tavily

- `POST https://api.tavily.com/search` へ `Authorization: Bearer <apiKey>` と `Content-Type: application/json` で送る。本文は `{ query, search_depth: "basic", max_results: 5 }` だけ（詳細オプションは非ゴール）
- 応答の `results[].{title, url, content}` を共通形式へ写す。`answer` / `raw_content` / `score` / `published_date` は使わない
- 失敗は HTTP ステータスで分類する（400 / 401 / 403 / 422 / 429 / 432 / 433 / 5xx）。応答本文の `detail` は分類に使わず、モデル・ログ・UI へ出さない
- キーが未設定のときは `Authorization` を組まずに `key_missing` を返し、上流へ送らない

## 引数とリクエスト

引数は `query` だけ。空文字と空白のみは schema で弾く（`minLength` だけでは `"   "` が通るため `pattern` も付ける）。弾かれたときは execute が呼ばれず、SDK の引数検証の文言がそのままモデルへ返る。

- provider は execute のたびに `readProvider()` で読む。**セッション作成時に凍結しない**ため、既定を変えると既存の会話の次の呼び出しから新しい provider が使われる
- 期限は自前の `AbortController` + タイマーで 60 秒。ユーザー中断（`signal.aborted`）とは別コード・別文言で扱う（`AbortSignal.any()` で包むと区別できない）。signal は provider へそのまま渡す
- `fetchImpl` を注入できる。自動テストは実 API を呼ばず、スタブで検証する

## 応答の解釈

provider ごとの差はここで吸収し、`WebSearchResultItem[]` へ正規化する。欠けたフィールドは空文字にして、整形側の `(no title)` へ委ねる。

- Exa: `result.content[0].text` → JSON → `results[]`（`highlights` 優先、無ければ `text`）
- Tavily: `results[]`（`content`）
- `results` が配列でなければ「想定外の応答」。空配列は **正常系**で「結果が見つかりませんでした」を返す（JSON なので 0 件と解釈不能を区別できる）

## 結果の整形

provider に依存しない共通処理。

- 本文の**先頭に出典一覧**（`[n] <title> — <url>`）を置く。チャットのツール履歴は出力の先頭 900 字しか出さない（`server/src/session-projection.ts` の `SUMMARY_TEXT_MAX`）ため、先頭にまとめると履歴でも出典が残る
- 続けて各件の抜粋を並べる
- 1 件あたり **1,500 字**で切る。Exa の `textMaxCharacters` が切るのは `results[].text` だけで `highlights` は切られない（実測で highlights 1 件が 5,711 字になった）
- **合計 12,000 字**を超えたら末尾を落とし、`... [truncated]` を付ける。SDK は customTool の結果を長さで丸めないため、上限はツール側の責務
- `details` / `structuredContent` / `outputSchema` は持たない（text だけ）
- **切り詰める前にマスクする。** `wrapToolDefinitionWithSecretMasker` が掛かるのは execute の後で、`maskSafe` が拾えるのは先頭が秘密値の末尾と一致する断片と `... [truncated]` の直前だけ（`server/src/redact.ts`）。自前の `slice` の末尾に残った秘密値の前半分は検出されないため、execute が 1 件ずつと全体の切り詰めの前に `masker.mask()` を通す

## 失敗の分類

provider が「成功 / 失敗 / 失敗の種類」を返し、共通側が種類を固定文言へ写す。判定は provider 側で完結させ、共通側は上流の応答本文を見ない。すべての文言は固定で、上流の応答本文・キー値はモデル・ログ・UI へ出さない。

| 種類 | 文言 | Exa | Tavily |
| --- | --- | --- | --- |
| `rate_limited` | 検索が混雑しています（レート制限） | `result._meta["ai.exa/rateLimited"] === true`（HTTP 200） | HTTP 429 |
| `quota_exceeded` | 検索の利用上限に達しました（provider のプラン上限） | — | HTTP 432 / 433 |
| `key_missing` | 検索プロバイダーのAPIキーが未設定です。設定 → モデル → Web 検索 を開いて登録してください。 | — | キー行が無い（上流へ送らない） |
| `key_rejected` | 検索プロバイダーのAPIキーが拒否されました。設定 → モデル → Web 検索 を開いて確認してください。 | — | HTTP 401 / 403 |
| `provider_error` | 検索プロバイダのエラーが発生しました | `result.isError === true`（HTTP 200） / HTTP 406 / 5xx / その他 | HTTP 400 / 422 / 5xx / その他 |
| `unexpected_response` | 検索プロバイダが想定外の応答を返しました | JSON-RPC の `error` / `content[0].text` が JSON でない / `results` が配列でない | 本文が JSON でない / `results` が配列でない |
| （共通の失敗） | 検索プロバイダに接続できませんでした（例外の文言はマスクして 500 字まで添える） | ネットワーク例外 | ネットワーク例外 |
| （共通の失敗） | `web_search` がタイムアウトしました / `web_search` を中断しました | 期限・ユーザー中断 | 期限・ユーザー中断 |

- 共通の文言は `server/src/web-search-tool.ts` の `WEB_SEARCH_*_MESSAGE` が正。キーの登録先を示す 2 つ（`key_missing` / `key_rejected`）だけは GUI の場所を書く
- provider の失敗は **別 provider へ再解釈しない**。`tavily` の 401 は `key_rejected` のまま、Exa のレート制限は `rate_limited` のまま固定文言になる

## 実行時トグル（設定 → モデルの Web 検索タブ）

第三者ホストを**その場で止めたい**ときのための、アプリ全体の OFF スイッチ。環境変数（起動時に固定）ではないので、デプロイも再起動も要らない。

- 正はアプリ DB の `web_search_settings`（id = 1 の 1 行、`enabled` と `provider`）で、**行が無い = 既定（有効 / Exa）**。無効化のためにデプロイを要する設計にしないことが目的なので、既定は ON（[persistence.md](persistence.md#アプリデータsqlite)）
- ツールは `execute` のたびに `readEnabled()` を読む。**セッション作成時に凍結しない**ため、OFF にした瞬間から既存のセッションの次の呼び出しにも効く（ツール一覧は新しい会話にしか効かないので、実行時に拒否する）
- OFF の間は検索も送信もしない。provider の `fetch` を呼ばず、固定文言 `WEB_SEARCH_DISABLED_MESSAGE`（「Web 検索は無効化されています。有効にするには 設定 → モデル → Web 検索 を開いてください。」）で throw する。設定画面は API が返す `disabledMessage` をそのまま出す
- 経路は 設定サービス（`server/src/web-search-settings.ts`）→ `PiBff.setWebSearch()` → ツールの `readEnabled()` / `readProvider()` / `readApiKey()`。書き込みと `applyStored()` は `MutationLock` の内側で直列化する（画像生成と同じ形）
- DB を読めない起動でも**有効 / Exa** で立ち、警告だけを残す（行が無い = 既定と同じ扱いにし、読めないだけで検索を黙って止めない）。設定 API は DB の 503 で気付ける（[persistence.md](persistence.md#アプリデータsqlite)）
- モデルから見るとツールは存在したままなので、無効時もモデルは呼べて、そのたびに固定文言の失敗が返る（無駄な往復を避けたくなったら system prompt / `promptGuidelines` への反映を別途検討する）

## 設定（既定 provider と APIキー）

設定 → モデル → Web 検索タブが、**有効 / 無効 + 既定 provider + provider ごとの APIキー**を 1 面に持つ。provider の選択と kill switch が別の場所にあると、障害時にどちらを見るか分からなくなるため。

- 既定 provider は `web_search_settings.provider` へ保存する。選択肢は API が返す `providers[]`（id / 名前 / 送信先 / キーの要否 / 設定済みか）から作り、**選んだ時点で既定になり保存される**（別の「〜を既定にする」ボタンは置かない）。選択中の provider の設定だけを下に出す
- キーは `web_search_provider_keys`（1 行 1 provider）へ保存し、**値は API の応答へ返さない**（`configured` だけを返す）。削除は行ごと消し、未設定でも 200 の冪等
- キーの保存方式は**平文**（画像生成・プロバイダー APIキーと同じ。暗号化するのは 作業環境 → 環境変数 のシークレットだけ）。保存した値は `retainSecret()` へ渡してマスカーへ登録し、起動時にも全 provider の保存済みキーを登録する。したがって保護されるのは**出力・ログ・会話の時点**で、DB・WAL・バックアップの残存リスクは [secrets.md](secrets.md) を正とする
- キーが未設定のまま provider を既定にすることは**できる**。画面は警告行を出し、検索すると `key_missing` の固定文言で失敗する（選択とキー登録の順序を強制しない）
- 環境変数は増やさない（[.env.example](../.env.example) に変更は無い）
- 常時公開で、`PI_AGENT_TOOLS` などからは外せない
- 検索前の確認ダイアログは持たない。SDK の `ctx.ui.confirm()` は BFF（`noExtensions: true`）では使えない（`ask_user` の待機機構が入ってから別途）

## 非ゴール

- provider ごとの詳細検索オプション（`search_depth` / 期間 / ドメイン絞り込みなど）
- provider の自動選択・自動 fallback・セッション単位の override
- 検索品質・料金・利用量による自動ルーティング、Tavily の credit 使用量表示
- キー付き provider を複数同時に使うこと（`web_search_provider_keys` は provider ごとの行を持つため、キー自体は複数登録できる）

## 検証

実 API は呼ばず、`fetchImpl` のスタブで検証する。

| テスト | 固定すること |
| --- | --- |
| `server/test/web-search-providers.test.ts` | provider の一覧 / 未知の id の畳み込み / Exa の `tools/call` の URL・`Accept`・固定引数 / Exa の `data:` 行の解釈 / `results[]` の正規化（highlights → text）/ Exa の失敗分類（`isError`・レート制限・JSON でない `content[0].text`・HTTP 406 / 500 / 429）/ Tavily の Bearer と本文 / Tavily の `results[]` の正規化 / Tavily のステータス分類（400 / 401 / 422 / 429 / 432 / 433 / 500）/ キー未設定は上流へ送らない |
| `server/test/web-search-tool.test.ts` | 引数 `query`（空文字・空白のみを拒否）/ 出典一覧が先頭・highlights の採用 / 1 件と合計の切り詰め / 既定は Exa / 既定 provider の実行時切り替え / provider が失敗しても別 provider へ fallback しない / キー未設定・拒否の固定文言 / 失敗の種類 → 固定文言 / ネットワーク例外（マスクして 500 字まで）/ タイムアウト / ユーザー中断 / `results: []` が正常系 / 切り詰め前のマスク / 無効の間は送らず、ON に戻ると同じ定義で検索する / 設定の読取失敗は送らずに固定文言 / `web_search` がサンドボックスの allowlist に入らないこと |
| `server/test/web-search-settings.test.ts` | 行が無い = 既定（有効 / Exa）/ PUT の往復と写しの差し替え（enabled / provider / キー）/ 未知の provider とキー不要 provider へのキー操作が 400 / マスカー登録が DB より前 / 応答にキー値を載せない / キー削除の冪等 / 保存できないときは 503 で写しも変えない / 保存後の読取失敗でも 200 / 起動時に DB を読めないときは既定で立つ / 起動時に保存済みのキーを保護対象へ入れる |
| `server/test/web-search-settings-api.test.ts` | `GET` / `PUT /api/settings/web-search`、`PUT /provider`、`PUT`・`DELETE /providers/:provider/key` の往復、`state: "applied"`、再起動後も残ること、Zod 検証での 400、応答にキー値を出さないこと |
| `server/test/app-db.test.ts` | v11 → v12 → v13 の加算移行、`web_search_settings.provider` の既定、`web_search_provider_keys` の往復と upsert・削除 |
| `client/test/selectMenu.test.ts` / `client/test/webSearchSettings.test.ts` / `client/test/webSearchSettingsTab.test.ts` / `client/test/modelSettingsPage.test.ts` | 自前 select の位置とキーボード移動、provider 一覧・送信先・キー状態の文言、有効 / 無効と provider 切替の描画、キー未設定の警告、保存中の disable、タブの語彙と URL |

実セッション（GUI）での受入は手動で 1 回行う。`mcp.exa.ai` / `api.tavily.com` への実到達とデプロイ先コンテナからの到達性、GUI の停止ボタンで中断できること、ツール履歴の先頭 900 字に出典一覧が入ることを確かめる。

## 残る懸念

- 無効化は実行時の拒否なので、モデルから見るとツールは存在したままになる（無駄な往復を避けたい場合の対処は上の「実行時トグル」に書いた）
- 無効の間もチャットのツール履歴には失敗した呼び出しが残る（意図どおり。実行しなかったことは履歴から読み取れる）
- Exa の keyless MCP の可用性・レート制限は第三者ホストへの依存で、SLA も保証もない。Tavily の無料枠・プラン上限も provider 側の契約に従う
- クエリは既定 provider のホストへ渡る（外部送信先が 1 つ増える）。provider を切り替えると送信先もキーも変わるため、GUI は既定 provider の送信先を常時出す
- キーは平文で `u7agent.db` に残る（[secrets.md](secrets.md) の残存リスクと同じ）。暗号化の対象を広げるなら全プロバイダーキーをまとめて移す別 Issue にする
- ツール履歴は出力 900 字で切れるため、出典一覧を先頭に置いても全件は見えない可能性がある（必要になったら専用カードを別途）
- 本文を持たない assistant に属するツール履歴は、同じ user ターン内に表示可能な assistant が無いと復元されない（既存の全ツール共通の制限。[api-sessions.md](api-sessions.md)）
