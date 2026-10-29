# Web 検索（web_search ツール）

チャットのセッションから Web 検索できるようにする。BFF ローカルの `web_search` ツール（`server/src/web-search-tool.ts`）が、設定で選んだ provider へ検索を 1 回投げ、上位 5 件を現在日時行 + 検索プロバイダー行 + 出典一覧 + 抜粋へ整形して返す。URL の中身を読むのは従来どおりサンドボックスの `bash` + `curl` で、本文取得（`fetch_content` 相当）は持たない。

- モデルへ公開するのは **単一の `web_search(query)`**。provider の選択はモデルに渡さず、BFF 側で「既定の検索プロバイダー」を解決して実行する
- provider は `server/src/web-search-providers.ts` の adapter。**endpoint・request / response の形式・失敗の分類**を持ち、モデル向けの契約（引数・整形・上限・timeout / abort・マスク）は `web-search-tool.ts` が持つ
- 結果は provider ごとの差を **共通形式 `WebSearchResultItem[]`（`title` / `url` / `excerpt` / 任意の `publishedDate`）へ正規化**する。モデルから見た Tool Schema は provider を変えても変わらない
- ツールは **BFF ローカル**。サンドボックスのリモート定義ではなく、`createRemoteToolDefinitions` / `REMOTE_TOOL_NAMES` の外にあり、`PI_AGENT_TOOLS` の影響を受けない。`configuredTools()` の結果はそのまま `createRemoteToolDefinitions` へ渡り、未知の名前は `UnknownRemoteToolError` になるため、`web_search` を混ぜてはならない（[sandbox.md](sandbox.md)）
- セッションの `tools` へは `withWebSearchTool()`、`customTools` へは `createWebSearchToolDefinitions()` で足す（`server/src/agent.ts`）。`PI_AGENT_TOOLS` の対象外だが、**エージェント定義の `toolNames`（[api-catalog.md](api-catalog.md#ツール許可リスト)）で外せる**。アプリ側の実効（実行時トグル）と許可リストの積で公開が決まる
- 検索は `fetch` だけで完結し、BFF から子プロセスを起こさない（[secrets.md](secrets.md) のレイヤー 1）
- クエリは既定 provider のホスト（Exa なら `mcp.exa.ai`、Tavily なら `api.tavily.com`）へ渡る。自己ホスト構成でも外部送信先が 1 つ増える
- Remote MCP の Registry とエージェントごとの tool allowlist には載せない（MCP クライアントを介さない BFF の固定ツール）。ここでの「エージェントごとの tool allowlist」は SDK / MCP 側の機構で、このアプリのエージェント定義の `toolNames`（[api-catalog.md](api-catalog.md#ツール許可リスト)）とは別物（同じ英語を使うため、ツールの許可リストはこのアプリでは `toolNames` と呼ぶ）。pi SDK 拡張の読み込みも行わない（`noExtensions: true` を維持する）

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
- 取り出すのは `result.content[0].text` に入った **JSON 文字列**。`JSON.parse` して `results[]` を読む。使うのは `results[].{title, url, text, highlights[], publishedDate}` で、`highlights` を連結し、無ければ `text` を使い、`publishedDate` は公開日として取り込む（`id` / `image` は使わない）
- Exa は失敗を HTTP ステータスで返さない。未知ツールも無料枠のレート制限も **HTTP 200** で返るため、本文の判定を provider 側に閉じ込める
- advanced ツールが `mcp.exa.ai` から消えた場合は `isError` の分類で失敗する（basic への自動フォールバックは持たない）

### Tavily

- `POST https://api.tavily.com/search` へ `Authorization: Bearer <apiKey>` と `Content-Type: application/json` で送る。本文は `{ query, search_depth: "basic", max_results: 5 }` だけ（詳細オプションは非ゴール）
- 応答の `results[].{title, url, content, published_date}` を共通形式へ写し、`published_date` は公開日として取り込む。`answer` / `raw_content` / `score` は使わない
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
- 公開日は Exa の `publishedDate` / Tavily の `published_date` を `publishedDate`（string）として取り込む。無い / 非文字列は `publishedDate` を付けない（結果自体は残し、表示は下の「結果の整形」で括弧ごと省く）。provider 固有のフィールド名はここで吸収する
- `results` が配列でなければ「想定外の応答」。空配列は **正常系**で「結果が見つかりませんでした」を返す（JSON なので 0 件と解釈不能を区別できる）

## 結果の整形

provider に依存しない共通処理。

- 本文の**先頭に現在日時行**（`現在日時: 2026-10-07 (Asia/Tokyo)`）を置く。モデルが「今」を知る唯一の材料で、時間依存の質問の年誤りを防ぐ（検索を呼ばない質問には届かない。下の「残る懸念」）
- 続けて**検索プロバイダー行**（`検索プロバイダー: Exa`）を置く。クエリの外部送信先は会話に残す価値があり、`key_missing` / `key_rejected` の固定文言が provider 名を持たないため、キーを複数登録しているときにどちらの provider の話かがツール履歴から読める。値は adapter（`server/src/web-search-providers.ts`）の `name` で、provider を解決できなかった呼び出し（設定読取失敗 / 無効化）には付けない（[チャットのチップ](#チャットのチップ)）
- 続けて**出典一覧**（`[n] <title> — <url> (<publishedDate>)`）を置く。チャットのツール履歴は出力の先頭 900 字しか出さない（`server/src/session-projection.ts` の `SUMMARY_TEXT_MAX`）ため、先頭にまとめると履歴でも日時行・provider 行と出典が残る
- タイムゾーンは `Asia/Tokyo` 固定（`server/src/jst.ts` の `JST_TIME_ZONE`）。UI は日本語で利用者は JST だが、デプロイ先コンテナは `TZ` 未設定（`Dockerfile`、base は `node:26-trixie-slim`）でサーバのローカル時刻には任せられず、設定化（環境変数 / GUI）は非ゴール
- locale は `en-US` に固定し、`Intl.DateTimeFormat.formatToParts` から `YYYY-MM-DD` を組む。locale 未指定だと実行環境の LANG / ICU で数字や暦が変わり得るため固定し、`en-CA` の出力書式にも依存しない。formatter はモジュールスコープで 1 回だけ作る
- 日時行は**日付まで**で時刻（時分秒）は出さない。「今年」の判断には足り、表示と prefix cache が安定する
- 公開日は JST の `YYYY-MM-DD` へ直して括弧に出す。値が無い / parse できない / 空文字のときは括弧ごと省く（公開日を持たない結果が実在する）。**生の文字列を出典行へ入れない**（マスクと切り詰めの順序の議論を持ち込まないため）
- 続けて各件の抜粋を並べる
- 1 件あたり **1,500 字**で切る。Exa の `textMaxCharacters` が切るのは `results[].text` だけで `highlights` は切られない（実測で highlights 1 件が 5,711 字になった）
- **合計 12,000 字**を超えたら末尾を落とし、`... [truncated]` を付ける。日時行と provider 行が先頭なので切り詰めても残る。SDK は customTool の結果を長さで丸めないため、上限はツール側の責務
- 0 件（`WEB_SEARCH_NO_RESULTS_MESSAGE`）にも日時行と provider 行を付ける。年を変えて再検索する判断材料になり、どの provider へ送ったかも残る
- `details` / `structuredContent` / `outputSchema` は持たない（text だけ）
- **切り詰める前にマスクする。** `wrapToolDefinitionWithSecretMasker` が掛かるのは execute の後で、`maskSafe` が拾えるのは先頭が秘密値の末尾と一致する断片と `... [truncated]` の直前だけ（`server/src/redact.ts`）。自前の `slice` の末尾に残った秘密値の前半分は検出されないため、execute が 1 件ずつと全体の切り詰めの前に `masker.mask()` を通す
- 指針（`WEB_SEARCH_TOOL_GUIDELINES`）で、日時行を「今日」の正とすることと、ユーザーが年を言わないときは**初回に年を入れずに検索**し、結果が古ければ日時行の年を明示して再検索することを指示する。年が分かるのは最初の結果の日時行を見た後なので、初回に記憶から現在年を推測させない（この指針は `promptGuidelines` として全ターンの system prompt へ展開されるため、検索を呼ぶ前から目に入る）

日時を `appendSystemPrompt`（`addendum` section）や `before_agent_start` の prompt 差し替えで system prompt へ入れる案は採らない。pi は system prompt を system message + `sections` として保持し、section の変更を **patch として履歴へ追記する**（`server/src/session-store.ts`）ため、日付が変わるたびに addendum 全文（数 KB）の patch がセッションへ積み上がる。prompt 側を採るかは、この結果側の変更を入れたうえで別途判断する。

## チャットのチップ

provider 行をクライアントが読んで、ツール履歴を展開しなくてもどの provider へ検索したかが分かるようにする。抽出は `client/src/lib/webSearchInfo.ts` の純関数で、ライブも復元後も同じ本文（`ToolCard.output`）を入力にする（サーバー / DB / API は変えない）。

- ツール履歴のヘッダ（畳んでいても見える）と各行に出す。ヘッダは全行が同じ provider なら 1 つ、混在は 1 つにまとめて内訳を hover に置く（片方の provider だけを見せない）。どの行がどの provider かは行のチップが担う
- チップは provider の表示名だけを持つ。送信先ホスト（`mcp.exa.ai`）は 設定 → Web 検索（`/settings/web-search`）が正で、履歴のチップには載せない
- 値は本文に書かれた表示名のまま出す。provider の一覧 API を引かないのは、会話ごとに provider が違い得るため（本文に書かれた値だけがその検索の送信先として正しい）。表示名を後で変えると過去の履歴は当時の名前のまま残る（[画像生成のバッジ](image-generation.md#チャットのバッジ)がカタログ表示名へ解決しないのと同じ性質）
- 本文の上のバッジ（`GenerationBadgeList`）は足さない。あれは「そのターンに何を生成したか」の要約で、`web_search` は生成物を持たない
- 失敗したカードでも読む（throw の文言にも provider 行が入る）。出さない条件は `web_search` 以外のカードと、本文に provider 行が無いカード（provider を解決できなかった呼び出し・provider 行を書く前のセッション）。抽出は結果本文の先頭 3 行だけを読み、改行で終わらない行は値にしない（投影で切れた断片を確定値にしない規則は [画像生成のバッジ](image-generation.md#チャットのバッジ)と同じ）
- 「すべてコピー」の本文は変えない（args / output の生テキストと `#N` の対応を保つ）

## 失敗の分類

provider が「成功 / 失敗 / 失敗の種類」を返し、共通側が種類を固定文言へ写す。判定は provider 側で完結させ、共通側は上流の応答本文を見ない。すべての文言は固定で、上流の応答本文・キー値はモデル・ログ・UI へ出さない。

| 種類 | 文言 | Exa | Tavily |
| --- | --- | --- | --- |
| `rate_limited` | 検索が混雑しています（レート制限） | `result._meta["ai.exa/rateLimited"] === true`（HTTP 200） | HTTP 429 |
| `quota_exceeded` | 検索の利用上限に達しました（provider のプラン上限） | — | HTTP 432 / 433 |
| `key_missing` | 検索プロバイダーのAPIキーが未設定です。設定 → Web 検索 を開いて登録してください。 | — | キー行が無い（上流へ送らない） |
| `key_rejected` | 検索プロバイダーのAPIキーが拒否されました。設定 → Web 検索 を開いて確認してください。 | — | HTTP 401 / 403 |
| `provider_error` | 検索プロバイダのエラーが発生しました | `result.isError === true`（HTTP 200） / HTTP 406 / 5xx / その他 | HTTP 400 / 422 / 5xx / その他 |
| `unexpected_response` | 検索プロバイダが想定外の応答を返しました | JSON-RPC の `error` / `content[0].text` が JSON でない / `results` が配列でない | 本文が JSON でない / `results` が配列でない |
| （共通の失敗） | 検索プロバイダに接続できませんでした（例外の文言はマスクして 500 字まで添える） | ネットワーク例外 | ネットワーク例外 |
| （共通の失敗） | `web_search` がタイムアウトしました / `web_search` を中断しました | 期限・ユーザー中断 | 期限・ユーザー中断 |

- 共通の文言は `server/src/web-search-tool.ts` の `WEB_SEARCH_*_MESSAGE` が正。キーの登録先を示す 2 つ（`key_missing` / `key_rejected`）だけは GUI の場所を書く
- provider の失敗は **別 provider へ再解釈しない**。`tavily` の 401 は `key_rejected` のまま、Exa のレート制限は `rate_limited` のまま固定文言になる
- 失敗（表のすべて + 設定読取失敗・タイムアウト・ネットワーク / 中断）の文言には現在日時行を前置して throw する。**検索に失敗したときこそモデルは記憶で答える**ため、日付が最も要る。`WEB_SEARCH_DISABLED_MESSAGE` だけは対象外（モデルの時間感覚と無関係で、すべきことは設定を開くこと）
- provider を解決できた失敗（表のすべて + タイムアウト・ネットワーク / 中断）の文言には、日時行の次に provider 行を足す（「どちらのキーが問題か」をツール履歴から読めるようにする。成功本文と同じ並び）。**provider を解決していない 2 つ（設定読取失敗・無効化）には付けない**（[チャットのチップ](#チャットのチップ)）

## 実行時トグル

第三者ホストを**その場で止めたい**ときのための、アプリ全体の OFF スイッチ。環境変数（起動時に固定）ではないので、デプロイも再起動も要らない。

- 正はアプリ DB の `web_search_settings`（id = 1 の 1 行、`enabled` と `provider`）で、**行が無い = 既定（有効 / Exa）**。無効化のためにデプロイを要する設計にしないことが目的なので、既定は ON（[persistence.md](persistence.md#アプリデータsqlite)）
- ツールは `execute` のたびに `readEnabled()` を読む。**セッション作成時に凍結しない**ため、OFF にした瞬間から既存のセッションの次の呼び出しにも効く（ツール一覧は新しい会話にしか効かないので、実行時に拒否する）
- OFF の間は検索も送信もしない。provider の `fetch` を呼ばず、固定文言 `WEB_SEARCH_DISABLED_MESSAGE`（「Web 検索は無効化されています。有効にするには 設定 → Web 検索 を開いてください。」）で throw する。設定画面は API が返す `disabledMessage` をそのまま出す
- 経路は 設定サービス（`server/src/web-search-settings.ts`）→ `PiBff.setWebSearch()` → ツールの `readEnabled()` / `readProvider()` / `readApiKey()`。書き込みと `applyStored()` は `MutationLock` の内側で直列化する（コンテンツ生成と同じ形）
- DB を読めない起動でも**有効 / Exa** で立ち、警告だけを残す（行が無い = 既定と同じ扱いにし、読めないだけで検索を黙って止めない）。設定 API は DB の 503 で気付ける（[persistence.md](persistence.md#アプリデータsqlite)）
- モデルから見るとツールは存在したままなので、無効時もモデルは呼べて、そのたびに固定文言の失敗が返る（無駄な往復を避けたくなったら system prompt / `promptGuidelines` への反映を別途検討する）。日時依存の質問を `web_search` へ誘導する指針のぶん、OFF 中の空振り呼び出しは増える

## 設定（既定 provider と APIキー）

設定 → Web 検索（`/settings/web-search`）が、**有効 / 無効 + 既定 provider + provider ごとの APIキー**を 1 面に持つ。provider の選択と kill switch が別の場所にあると、障害時にどちらを見るか分からなくなるため。

- 既定 provider は `web_search_settings.provider` へ保存する。選択肢は API が返す `providers[]`（id / 名前 / 送信先 / キーの要否 / 設定済みか）から作り、**選んだ時点で既定になり保存される**（別の「〜を既定にする」ボタンは置かない）。選択中の provider の設定だけを下に出す
- キーは `web_search_provider_keys`（1 行 1 provider）へ保存し、**値は API の応答へ返さない**（`configured` だけを返す）。削除は行ごと消し、未設定でも 200 の冪等
- キーは **AEAD で暗号化して保存する**（コンテンツ生成・プロバイダー APIキーと同じ方式。AAD は `u7agent-app-secret:web_search_provider_keys:<provider>`）。保存した値は復号直後に `retainSecret()` へ渡してマスカーへ登録し、起動時にも全 provider の保存済みキーを「復号 → 登録」の順で登録する。master key の制約と残存リスクは [secrets.md](secrets.md#アプリ-db-に保存する-apiキーと-webhook-url) を正とする
- キーが未設定のまま provider を既定にすることは**できる**。画面は警告行を出し、検索すると `key_missing` の固定文言で失敗する（選択とキー登録の順序を強制しない）
- 外部送信の注意（クエリがどこへ出るか・キーの暗号化保存・ログイン無しで公開しない）は、設定を変える前に読めるよう既定で畳んで出す。折りたたみ中も `webSearchNoticeSummary()` が送信先とキーの扱いを 1 行で見せる
- 環境変数は増やさない（[.env.example](../.env.example) に変更は無い）
- 常時公開だが、エージェント定義の `toolNames` からは外せる（外すと新しい会話でこのツールが公開されない）。エージェントの変更は既存の会話に遡及しない
- 検索前の確認ダイアログは持たない。SDK の `ctx.ui.confirm()` は BFF（`noExtensions: true`）では使えない（`ask_user` の待機機構が入ってから別途）

## テスト検索（設定画面）

設定 → Web 検索（`/settings/web-search`）から、保存済みの設定で 1 回だけ検索して結果を確かめられる。目的は
「キーが通るか」「整形はどう見えるか」を、会話を作らずに確認すること。

- ツールと同じ runner（`createWebSearchRunner`）を共有する。整形・失敗の固定文言・マスク・期限（60 秒）は
  ツール側の 1 実装だけで、画面とチャットで結果が食い違わない
- 応答の `output` は **モデルへ返る本文（成功）/ throw する文言（失敗）そのもの**で、画面はコードブロック風の
  枠にそのまま出す（コピー付き）。出典を別のリンク一覧へ解釈し直さない（整形の二重実装を作らない）
- `provider`（実際に送った id / 表示名 / 送信先）・`resultCount`・`durationMs` は応答が返す。画面の選択ではなく
  **送った時点の provider** を出す（チャットのチップと同じ方針）
- 無効の間は **送らない**。画面はボタンを押せなくし、API も上流へ送らずに `WEB_SEARCH_DISABLED_MESSAGE` を
  `ok: false` で返す（kill switch をテストだけ迂回させない）。キー未設定も provider 側で止まり、上流へは送らない
- 会話・履歴・設定・DB へは何も書かない。失敗も 200 の `ok: false` で返し、`state` は持たない
- クエリは自由文なので URL ではなく本文で受ける（アクセスログに残さない）。上限は 500 文字で、これは GUI の
  入力欄のための制限。モデルへ公開する `web_search` の引数には上限を置かない
- タイムアウトはツールと同じ 60 秒。画面は経過秒数を出す（テストだけ短い期限にすると、チャットとの差が
  そのまま「テストは通るのに失敗する」に見える）
- 保存していない APIキーの下書きがあるときは、保存してから試すよう画面で促す（自動保存はしない）
- 結果は画面の state だけで、再読み込み・設定変更で消える（古い設定の結果を新しい設定の証拠にしない）。
  検索待ちの間に設定が変わった場合も、遅れて届いた応答は採用しない

## 非ゴール

- provider ごとの詳細検索オプション（`search_depth` / 期間 / ドメイン絞り込みなど）
- チップへの送信先ホスト（`mcp.exa.ai`）の表示（チップは provider の表示名だけを持つ）
- provider の自動選択・自動 fallback・セッション単位の override
- テスト検索の結果から出典のリンク一覧を組み立てること・実行のキャンセル・履歴への保存
- 検索品質・料金・利用量による自動ルーティング、Tavily の credit 使用量表示
- キー付き provider を複数同時に使うこと（`web_search_provider_keys` は provider ごとの行を持つため、キー自体は複数登録できる）
- 現在日時の精度を上げること（時刻・秒）と、タイムゾーンの設定化（`Asia/Tokyo` 固定）
- `publishedDate` が上流で誤っている場合の検証

## 検証

実 API は呼ばず、`fetchImpl` のスタブで検証する。

| テスト | 固定すること |
| --- | --- |
| `server/test/web-search-providers.test.ts` | provider の一覧 / 未知の id の畳み込み / Exa の `tools/call` の URL・`Accept`・固定引数 / Exa の `data:` 行の解釈 / `results[]` の正規化（highlights → text）/ 公開日（Exa `publishedDate` / Tavily `published_date` の string / 非文字列 / 空文字 / 無し）/ Exa の失敗分類（`isError`・レート制限・JSON でない `content[0].text`・HTTP 406 / 500 / 429）/ Tavily の Bearer と本文 / Tavily の `results[]` の正規化 / Tavily のステータス分類（400 / 401 / 422 / 429 / 432 / 433 / 500）/ キー未設定は上流へ送らない |
| `server/test/web-search-tool.test.ts` | 引数 `query`（空文字・空白のみを拒否）/ 結果の整形（先頭の現在日時行と provider 行（既定 Exa / 切り替え後 Tavily / 0 件 / 失敗文言 / 設定読取失敗・無効化では無し / 投影の切詰め内に残る）・JST 境界・公開日の JST 変換と欠落 / parse 不能 / 非文字列 / 空文字・出典一覧・highlights の採用）/ 1 件と合計の切り詰め（日時行込み）/ 既定は Exa / 既定 provider の実行時切り替え / provider が失敗しても別 provider へ fallback しない / キー未設定・拒否の固定文言 / 失敗の種類 → 日時行付きの固定文言 / ネットワーク例外（マスクして 500 字まで）/ タイムアウト / ユーザー中断 / `results: []` が正常系（日時行付き）/ 切り詰め前のマスク / 指針の文言 / 無効の間は送らず、ON に戻ると同じ定義で検索する / 設定の読取失敗も日時行付きで送らずに固定文言 / `web_search` がサンドボックスの allowlist に入らないこと |
| `server/test/web-search-settings.test.ts` | 行が無い = 既定（有効 / Exa）/ PUT の往復と写しの差し替え（enabled / provider / キー）/ 未知の provider とキー不要 provider へのキー操作が 400 / マスカー登録が DB より前 / 応答にキー値を載せない / キー削除の冪等 / 保存できないときは 503 で写しも変えない / 保存後の読取失敗でも 200 / 起動時に DB を読めないときは既定で立つ / 起動時に保存済みのキーを保護対象へ入れる |
| `server/test/web-search-settings-api.test.ts` | `GET` / `PUT /api/settings/web-search`、`PUT /provider`、`PUT`・`DELETE /providers/:provider/key` の往復、`state: "applied"`、再起動後も残ること、Zod 検証での 400、応答にキー値を出さないこと |
| `server/test/web-search-test-api.test.ts` | `POST /api/settings/web-search/test` の本文（日時行・provider 行・出典・抜粋）と `provider` / `resultCount` / `durationMs`、クエリの trim、会話も設定も変えないこと、無効・キー未設定は上流へ送らないこと、失敗も 200 の固定文言、応答にキー値を出さないこと、空 / 空白 / 上限超過 / JSON でない本文の 400（上限ちょうどは 200）、実行環境が無いときの 503 |
| `server/test/app-db.test.ts` | v11 → v12 → v13 の加算移行、`web_search_settings.provider` の既定、`web_search_provider_keys` の往復と upsert・削除 |
| `client/test/webSearchInfo.test.ts` / `client/test/liveToolCall.test.ts` | provider 行の抽出（あり / なし / 空白のみ / 改行で終わらない断片は採らない / 先頭 3 行より後ろは読まない / 対象外ツール / 失敗カードでも読む / `output` が空）/ 行とヘッダのチップ（同一 provider は 1 つ・混在は `複数プロバイダー` と内訳・provider 行の無いカードでは出さない・生成モデルのチップとの同居） |
| `client/test/selectMenu.test.ts` / `client/test/webSearchSettings.test.ts` / `client/test/webSearchSettingsTab.test.ts` / `client/test/webSearchSettingsPage.test.ts` | 自前 select の位置とキーボード移動、provider 一覧・送信先・キー状態の文言、有効 / 無効と provider 切替の描画、キー未設定の警告、保存中の disable、ページの見出しと取得前の出し分け、セクションの語彙と URL、テスト検索の既定クエリと入力の規則、OFF で押せないこと、結果（成功 / 失敗）の状態行とコピー |

実セッション（GUI）での受入は手動で 1 回行う。`mcp.exa.ai` / `api.tavily.com` への実到達とデプロイ先コンテナからの到達性、GUI の停止ボタンで中断できること、ツール履歴の先頭 900 字に現在日時行と provider 行と出典一覧が入ることを確かめる。チップの見た目は有料 API を使わない GUI fixture（[testing.md](testing.md#有料-api-を使わない-gui-fixture)）で見る。

## 残る懸念

- 無効化は実行時の拒否なので、モデルから見るとツールは存在したままになる（無駄な往復を避けたい場合の対処は上の「実行時トグル」に書いた）
- 無効の間もチャットのツール履歴には失敗した呼び出しが残る（意図どおり。実行しなかったことは履歴から読み取れる）
- Exa の keyless MCP の可用性・レート制限は第三者ホストへの依存で、SLA も保証もない。Tavily の無料枠・プラン上限も provider 側の契約に従う
- クエリは既定 provider のホストへ渡る（外部送信先が 1 つ増える）。provider を切り替えると送信先もキーも変わるため、GUI は既定 provider の送信先を折りたたみ中の 1 行にも出す
- 保存済みのキーを復号できないとき（誤鍵・未知の鍵版・改ざん・master key 未設定）は、平文へフォールバックせず `keyAvailable: false` とサーバーの固定文言で利用不可にする。検索は失敗し、キーの削除は復号が要らないため通る
- 未評価（runtime 無し / 起動時に DB を読めなかった）のキーは `keyEvaluated: false` として返し、誤鍵・破損と断定しない。評価は起動・保存 / 置換・再起動のときだけで、GET では復号しない
- keyless の provider はキー行も master key も無い状態で利用できる（`configured: true` / `keyStored: false` / `keyAvailable: true` / `keyEvaluated: true`）
- ツール履歴は出力 900 字で切れるため、出典一覧を先頭に置いても全件は見えない可能性がある（必要になったら専用カードを別途）
- 検索を呼ばない時間依存の質問には日付が届かない。指針で検索を促すが強制はできず、検索不要と判断された場合・compaction 直後は届かない
- Web 検索が OFF の間も「今年」を誤る余地は残る（`WEB_SEARCH_DISABLED_MESSAGE` に日付を付けないため）。指針は日付依存の質問を `web_search` へ誘導するので、OFF 中は空振り呼び出しが増える方向に働く
- ツール結果本文が provider 名を含むため、モデルが回答本文で provider 名に触れ得る（実害は無いが、増えるなら `promptGuidelines` で抑える）
- ツール履歴のヘッダは singleColumn で幅が厳しい。生成モデルのチップと provider のチップが同居するとプレビューが縮むため、GUI 受入で見る
- 単一利用者・JST 前提。client の時刻表示はブラウザ既定のタイムゾーンで整形する（`client/src/lib/messageTime.ts`）ため、非 JST 利用では表示と日時行が食い違い得る
