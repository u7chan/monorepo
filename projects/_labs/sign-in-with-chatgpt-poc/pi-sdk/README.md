# SIWC PoC — Phase 2: Pi SDK + Sign in with ChatGPT

Epic [#1935](https://github.com/u7chan/monorepo/issues/1935) / Issue [#1937](https://github.com/u7chan/monorepo/issues/1937) の Phase 2 です。
**Sign in with ChatGPT（SIWC）で得た OAuth アクセストークンを使い、`@earendil-works/pi-coding-agent` の最小のエージェントセッションで実際に推論できるか**を確定します。

Phase 1（OpenAI 公式 SDK）のサンプル・トークン・生成物には依存せず、単独で起動・動作します。

## 何ではないか

- `u7agent` への統合や採用判断（Epic の対象外）
- マルチユーザー・マルチテナント・リモートホストでの提供（SIWC の別途利用条件が必要）
- 見栄えのよい Web UI（確認用の CLI のみ）
- Pi SDK の fork、未公開 API への依存

## 結論（先に要点）

- **Pi SDK に SIWC の受け口が組み込みで存在し、SDK 改変・未公開 API なしで推論できた。** `openai` provider の OAuth ログインが SIWC 実装で、公開 API（`ModelRuntime.login`）から呼べる。
- 推論は `https://api.openai.com/v1/responses` へ `store: false` / `stream: true` で送られ、SIWC 側の未対応フィールド（`prompt_cache_retention` / `prompt_cache_options` / `max_output_tokens` / `temperature`）は provider 実装が自動で落とす。
- ツール（`bash`）呼び出し、2 ターンの会話継続、thinking level の on/off、アクセストークン期限切れ時の自動更新まで通った。
- 一方で **運用上の注意**が 3 つある。Pi の `/logout` はローカルの資格情報を削除するだけで provider 側の失効要求を送らない。資格情報ファイルは同一 OS ユーザーのツールから読める。資格情報を環境変数で渡すとツール子プロセスへ継承される。詳細は「セキュリティ上の扱い」。

## 前提条件

| 項目 | 内容 |
| --- | --- |
| アカウント | **ChatGPT Plus または Pro**（ChatGPT プラン枠で推論するために必要） |
| 利用条件 | SIWC の ChatGPT プラン利用は、公開 OSS とローカルで動く個人プロジェクト向け。外部公開しない |
| ランタイム | Bun 1.3.14（`bun.lock` で固定。Node.js は不要） |
| ブラウザ | 同意操作のため、アプリを動かすマシン上のブラウザで認可 URL を開く |
| ポート | Pi の OAuth コールバックは `127.0.0.1:1455` 固定。他の Pi / Codex CLI のログインが使用中だと失敗する |

## セットアップと起動

```bash
cd projects/_labs/sign-in-with-chatgpt-poc/pi-sdk
bun install
bun run start login     # 表示された URL をブラウザで開いて承認する
bun run start status    # 認証経路とモデルを確認する
bun run start ask "Say exactly: Hello, world!"
```

起動時にブラウザを開く子プロセスは作りません（資格情報を子プロセスへ継承させないため、手動で開いてください）。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `login` | Pi 組み込みの SIWC OAuth でサインインする。認可 URL を表示し、コールバックを待つ |
| `logout` | 保存済み資格情報を削除する（provider 側の失効は行わない） |
| `status` | 認証経路・SDK バージョン・モデル・`openai-codex` の状態を表示する（`client_id` は先頭のみ） |
| `ask "<prompt>" [--tools bash,read] [--follow "<prompt>"]` | 最小のエージェントセッションで推論する。`--tools` でツール有効化、`--follow` で同一セッションの 2 ターン目 |
| `expire` | アクセストークンの期限だけを過去にずらす（更新の確認用） |
| `fake-token` | アクセストークンをダミー値にし、期限は未来のままにする（401 の確認用） |
| `check-tools` | ダミー資格情報がツール子プロセスへ継承されないか確認する |

### 環境変数

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `SIWC_PI_STORAGE_DIR` | `$XDG_CONFIG_HOME/sign-in-with-chatgpt-poc/pi-sdk` | 資格情報とホスト ID の保存先（リポジトリ外） |
| `SIWC_PI_MODEL` | `gpt-6-luna` | 使用モデル。Pi 同梱の `openai` カタログ（44 チャットモデル）から選ぶ |
| `SIWC_PI_THINKING` | `medium` | thinking level（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`） |
| `SIWC_PI_AGENT_NAME` | `sign-in-with-chatgpt-poc pi-sdk` | 初回登録の `agent_name_hint`。同意画面に出る名前 |
| `SIWC_PI_WORKSPACE` | カレントディレクトリ | `--tools` 使用時の作業ディレクトリ |

## 認証方式（Pi 組み込みの SIWC を使用）

SIWC の OAuth は **Pi 本体の実装をそのまま使います**。このサンプルはトークンを保持せず、`ModelRuntime.login("openai", "oauth", interaction, { getDeviceId, agentName })` を呼ぶだけです。エンドポイント・スコープ・更新はすべて Pi 側にあります。

| 項目 | 実測 / 実装 |
| --- | --- |
| プロバイダ ID | `openai`（`openai-codex` ではない） |
| 認可 | `https://auth.openai.com/api/accounts/authorize`、`client_id=dynamic_agent_client`、PKCE(S256)、`ext_agent_host_id` は UUID をファイルへ永続化 |
| コールバック | `http://127.0.0.1:1455/auth/callback`（ホストは `PI_OAUTH_CALLBACK_HOST` で変更可、ポートは固定） |
| トークン交換 / 更新 | `https://auth.openai.com/api/accounts/oauth/token`。更新時は発行済み `client_id`（`oaiapp_...`）を使い、`resource=https://api.openai.com/v1` |
| 付与されたスコープ | `chatgpt.tokens.use.direct` `email` `offline_access` `openid` `profile` `resource.invoke`（ドキュメントどおりプラン利用が含まれる） |
| 保存 | `<storage>/auth.json`（ファイル 0600 / ディレクトリ 0700。Pi の `AuthStorage`） |
| 更新タイミング | 期限の 3 分前に前倒しで更新（Pi 実装の `EXPIRY_MARGIN_MS`） |
| ID トークン | Pi は `sub` などを読まず、存在確認のみ（このサンプルもメール等は表示しない） |

### Pi の `openai-codex` との区別

`openai-codex` は ChatGPT の backend-api（`https://chatgpt.com/backend-api`）へ送る別経路で、SIWC のアクセストークンでは使えません。このサンプルは次の 3 点で「どちらで推論したか」を記録します。

1. セッションの `provider` / `api` / `baseUrl` を表示する（SIWC 経路なら `openai` / `openai-responses` / `https://api.openai.com/v1`）
2. `runtime.isUsingOAuth("openai")` と `isUsingSubscription("openai")` を表示する
3. `openai-codex` の資格情報が未設定であることを表示する（実測時は未設定のまま）

## 実測結果

2026-10-13 に、ChatGPT プラン利用を許可したアカウントで測定しました。OAuth ログインと実推論は手動、それ以外は CLI と `bun test` で確認しています。

| # | 項目（Issue #1937 のチェックリスト） | 期待 | 結果 | 備考 |
| --- | --- | --- | --- | --- |
| 1 | 検証時点の公開 API・バージョン確認 | SDK の公開 API だけで組める | **成功** | `pi-coding-agent` 1.2.0（`pi-ai` 1.2.0）。使用したのは `ModelRuntime` / `createAgentSession` / `DefaultResourceLoader` / `SessionManager` / `SettingsManager` / `ExtensionAPI` |
| 2 | Phase 1 に依存せず SIWC からトークンを得る | 単独でログインできる | **成功** | 独立した保存先（`~/.config/sign-in-with-chatgpt-poc/pi-sdk/`）へ保存。Phase 1 のファイルは読まない |
| 3 | SIWC 経路と `openai-codex` を区別して記録 | どちらで推論したか分かる | **成功** | `provider=openai` / `credential type=oauth` / `isUsingSubscription=true` / `openai-codex` は未設定 |
| 4 | SIWC トークンで最小のエージェントセッション推論 | テキストが返る | **成功** | `Say exactly: Hello, world!` → `Hello, world!`。リクエストは `input` + `store` + `stream` + `reasoning` + `include` + `prompt_cache_key` のみ |
| 5 | エンドポイント・`store: false` / `stream: true`・モデル指定 | Responses API へ送る | **成功** | `https://api.openai.com/v1` の `openai-responses`。`store=false` / `stream=true` を毎回付与。`model=gpt-6-luna` |
| 6 | 会話継続（2 ターン） | 文脈が続く | **成功** | `--follow` で同一セッションに送信。`input` が 2 → 4 アイテムに増え、`こんにちは、世界！` と文脈を保った |
| 7 | ストリーミング | 逐次表示される | **成功** | `session.subscribe` の `text_delta` / `thinking_delta` で逐次出力 |
| 8 | ツール互換性 | ツール宣言が通り、結果を返せる | **成功** | `tools: [bash]` を送信 → モデルが `bash` を呼び、実行結果を次のリクエストへ返して最終回答。2 リクエストとも 200 |
| 9 | thinking level 互換性 | on/off とも成立する | **成功** | `medium`: `reasoning.effort=medium` + `include=["reasoning.encrypted_content"]`。`off`: `reasoning.effort=none` で `include` なし。どちらも 200 |
| 10 | トークン期限切れ / 更新 | 自動更新して継続できる | **成功** | 期限を -3 秒にして送信 → 事前に更新が走り 3417 秒へ。同じ `client_id` のまま推論も成功 |
| 11 | 再起動後の再利用 | 再サインイン不要 | **成功** | `ask` / `status` は毎回別プロセスだが、保存済み資格情報でそのまま推論できた |
| 12 | 401 | 失敗が分かる形で出る | **成功** | `fake-token` 後の送信で `stopReason=error` と `OpenAI API error (401): ... "code":"invalid_api_key"`。マスクされた断片のみで実トークンは出ない |
| 13 | 失敗からの回復 | 更新で再開できる | **成功** | `fake-token` → `expire` → `ask` で更新が走り、200 で推論できた |
| 14 | ログアウト | ローカルの資格情報が消える | **成功** | `auth.json` のキーが空になり、`configured=false`。以後の `ask` は「SIWC 経路の OAuth 資格情報がありません」で停止し、リクエストを送らない |
| 15 | API キーへのフォールバック防止 | SIWC 以外の資格情報で推論しない | **成功** | `OPENAI_API_KEY` だけを設定した状態で `ask` が実行前に停止することを確認（SIWC 経路の証跡を崩さないため） |
| 16 | 資格情報がツールへ継承されない | 継承されない | **成功**（条件付き） | 保存済み access token は推論に使われ、かつツール子プロセスの env に現れない。ただし env で渡した値は継承される（後述） |
| 17 | 型チェックとテスト | `lint` と `test` が通る | **成功**（31 tests） | PR の CI でも同じ経路を実行（`Dockerfile` の `test` ステージ） |
| 18 | 403 / 429 / `response.failed` / 途中切断 | エラー内容が出る | 未検証 | アカウント・ワークスペースの状態に依存。検証時は使用量の残りを消費する検証を行わない方針とした |
| 19 | ログアウト後の再ログイン | 再登録・再認可できる | 未検証 | Pi は logout で `client_id` ごと削除するため、次回は新規登録になる（実装からの読み取り。実測はしていない） |
| 20 | ChatGPT 設定からの接続解除 | `invalid_grant` 系になる | 未検証 | OpenAI 側でセッションを失効させた場合の挙動 |

### 実際に送られたリクエスト（wire の実測）

`before_provider_request` で受け取った payload を JSON 化した形（= 実際に送られるキー）です。トークン・ヘッダー値は記録していません。

| 条件 | トップレベルキー | 備考 |
| --- | --- | --- |
| 1 ターン / thinking `medium` | `input` `model` `prompt_cache_key` `reasoning` `store` `stream` `include` | `input=[developer, user]`、`reasoning={effort:"medium",summary:"auto"}`、`include=["reasoning.encrypted_content"]` |
| 1 ターン / thinking `off` | `input` `model` `prompt_cache_key` `reasoning` `store` `stream` | `reasoning={effort:"none"}`、`include` なし |
| `--tools bash` | 上に `tools` が追加 | 2 リクエスト目で `input=[developer, user, assistant(function_call), function_call_output]` |

- SIWC 側が拒否する `prompt_cache_retention` / `prompt_cache_options` / `max_output_tokens` / `temperature` は、`openai` provider の実装がキーごと落としていた（`Object.keys` ではなく JSON 化後のキーで確認）
- `prompt_cache_key`（会話のキャッシュキー）は送られる。`instructions` は使われず、system prompt は `input[0]` に入る。reasoning モデルでは `role: "developer"`（ローカルのスタブと `openai` provider の組み合わせで `inputRoles=["developer","user"]` を実測。`reasoning: false` のモデルでは `system`）
- `after_provider_response` で見えたのは `status=200` のみ。`openai-request-id` / `x-request-id` / `openai-version` は付かなかった

## 失敗系の再現手順

| 目的 | 手順 | 期待 / 実測 |
| --- | --- | --- |
| 401 | `bun run start fake-token` → `ask "..."` | `stopReason=error` と `401 invalid_api_key`（実測）。アクセストークンは `dummy-ac**************-poc` のようにマスクされる |
| 回復 | `bun run start expire` → `ask "..."` | 更新が走って 200（実測） |
| 未サインイン | `bun run start logout` → `ask "..."` | リクエストを送る前に「SIWC 経路の OAuth 資格情報がありません」で停止（実測） |
| API キーしか無い | `OPENAI_API_KEY=... ask "..."` | 同じく実行前に停止する（実測。SIWC 経路の証跡を崩さないため） |
| 資格情報の継承 | `bun run start check-tools` | 保存済みトークンは子プロセスの env に出ない（実測） |
| 同意拒否 | 同意画面でキャンセルする | Pi のログインが `access_denied` で失敗する（**未検証**。Pi 実装は `error` をそのまま例外にする） |
| コールバックポート競合 | 別の Pi / Codex CLI がログイン中の状態で `login` | `Port 1455 is in use...` で失敗する（**未検証**。Pi 実装のメッセージ） |

## Pi 実装由来の制約

- 推論は `POST https://api.openai.com/v1/responses` のみ。`openai-codex` の `chatgpt.com/backend-api` は別経路で、SIWC トークンでは使えない
- `openai` provider は OAuth 資格情報のとき classifier モデル（GPT-6 Luna の Decisions API）を一覧から除外する。Decisions API は API キー専用
- `store: false` / `stream: true` は provider 実装が常に付ける。保存はしない前提で、Pi 側は reasoning の署名を `include: ["reasoning.encrypted_content"]` で持ち回る
- Pi のコールバックは `127.0.0.1:1455` 固定（`localhost` への置き換えは不可）。ログイン中はポートを占有する
- `logout` はローカル削除のみで、`revocation_endpoint` を呼ばない。失効させたい場合は ChatGPT 設定側で接続を解除する必要がある
- アクセストークンは Pi が保持・更新する。サンプルはトークンに触れない（`ModelRuntime.login` に委譲）
- ホストアプリが独自に得たトークンを渡す場合は `ModelRuntime.setRuntimeApiKey("openai", token)` が公開 API として使える。ただしプロセス寿命の間キャッシュされ、Pi の OAuth 更新経路には乗らないため、更新はホスト側の責任になる（このサンプルではローカルのスタブ provider で経路のみ確認）

## 型チェックとテスト

```bash
bun run lint   # tsc --noEmit + biome lint
bun test       # bun test（31 tests）
```

テストは、設定の解決、ホスト ID の永続化（0600）、ログイン対話の分岐（TTY / 非 TTY の abort 含む）、SIWC 資格情報の要求、`auth.json` からの資格情報の読み取り（トークンを含まないレポート）、リクエスト payload の要約（`store` / `stream` / `tools` / `include`、トークンらしき値の除外）、アクセストークン期限の書き換えを対象にしています。

実推論の代わりに、`127.0.0.1` のローカル Responses API スタブ（`src/stub-responses.ts`）に対して実際のエージェントセッションを 1 ターン走らせ、**ツール呼び出し → bash 実行 → 続きの推論**まで通すテストを含みます。このとき保存済みの OAuth 資格情報（ダミー値）を `openai` provider の推論に実際に使わせ、`Authorization` ヘッダーの指紋で使用を確認したうえで、その値がツール子プロセスの環境変数に現れないことを実測しています（ヘッダーは値ではなく sha256 のみを保持します）。OAuth ログインと実推論の E2E は手動検証です。

CI（PR）ではルートの `Dockerfile` の `test` ステージで `bun run lint` と `bun test` を実行します。このサンプルはブラウザとホスト上の資格情報ファイルが前提のため、Docker での起動は想定していません（`final` ステージはありません）。

## セキュリティ上の扱い

- 通常のログイン・推論ではアクセストークンを保持・表示せず、SDK（`ModelRuntime`）に管理を委譲する。検証補助コマンド（`expire` / `fake-token` / `check-tools`）だけが `auth.json` を読み書きする
- 画面に出るのは provider / 種別 / 有効期限 / スコープ / モデル名など。`client_id` は先頭 4 文字のみ（`oaiapp_xxxx...`）
- 認可 URL（ホスト ID を含む）は手動でサインインするためにターミナルへ表示するが、ファイルや README / PR には記録しない
- `check-tools` は環境変数の**値**を表示せず、設定の有無と継承の boolean だけを出す
- 資格情報はリポジトリ外（既定 `~/.config` 配下）に Pi が `0600` / ディレクトリ `0700` で保存する
- リクエスト記録（`before_provider_request`）はヘッダーを取らず、本文も主要フィールドだけを要約する。トークンは残らない

### ツール子プロセスへの資格情報の継承（実測）

`bun run start check-tools` は、ローカルのスタブ provider で実際のエージェントセッションを動かし、`bash` ツールの子プロセスの env をそのまま読み取ります。保存済み SIWC 資格情報を実際に使う検証（`Authorization` の指紋照合）は `bun test` 側で行います。

| 確認 | 実測 |
| --- | --- |
| 保存済み SIWC access token が env に出るか | 出ない（`bun test` では推論に実際に使われることまで `Authorization` の指紋で確認。CLI の `check-tools` はスタブ provider の資格情報を使う） |
| アプリが env に置いたダミー値が子プロセスへ届くか | 届く（Pi のシェル env は親プロセスの env を引き継ぐ） |
| `auth.json` をツールから読めるか | 読める（同じ OS ユーザー。`0600` は read を防がない） |
| `bash` ツールへ Pi が注入する変数 | `PI_PROVIDER` `PI_MODEL` `PI_REASONING_LEVEL` `PI_SESSION_ID` |

このため、**SIWC トークンを環境変数で渡すとツールへ継承されます**。このサンプルは `auth.json` のみを使い、env では渡しません。また、同一 OS ユーザーで動くツールはファイルを読めるため、出力マスクは安全境界になりません。Pi 自体の分離方針（コンテナや専用ユーザー）は [Run Pi safely](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) を参照してください。

## 未対応 / 要追加実装

**SDK 改変なしで動作しました。** 追加実装が必要だった箇所はありません。

検討した代替経路と、その扱い:

| 経路 | 判断 |
| --- | --- |
| `ModelRuntime.login("openai", "oauth")`（採用） | Pi 組み込みの SIWC 実装。更新・保存も Pi 側 |
| `ModelRuntime.setRuntimeApiKey("openai", token)` | ホストが得たトークンを渡せる。ただし更新はホスト側。ローカルのスタブ provider で経路のみ確認 |
| provider extension で独自の OAuth / `stream` を実装 | 不要と判断（組み込みで足りる） |
| `openai-codex` の利用 | 別経路のため対象外 |

## 参考

- [Integrating Sign in with ChatGPT（Cookbook）](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [SIWC: Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [SIWC: Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) / [Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
