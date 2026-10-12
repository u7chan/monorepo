# SIWC PoC — Phase 1: OpenAI公式SDK + Sign in with ChatGPT

Epic [#1935](https://github.com/u7chan/monorepo/issues/1935) / Issue [#1936](https://github.com/u7chan/monorepo/issues/1936) の Phase 1 です。
Pi に依存せず、**Sign in with ChatGPT（SIWC）で得た OAuth アクセストークンを `openai` SDK の Bearer 認証に使い、公開 Responses API をストリーミングで呼ぶ**範囲を確定します。

Phase 2（Pi SDK）の結果と比較できるよう、認証方式・SDKバージョン・モデル・制約・エラーを実測値で残すことを目的にしています。

## 何ではないか

- `u7agent` への統合や採用判断（Epic の対象外）
- マルチユーザー・マルチテナント・リモートホストでの提供（SIWC の別途利用条件が必要）
- 見栄えのよい Web UI（ローカル単一ユーザーの確認用画面のみ）

## 前提条件

| 項目 | 内容 |
| --- | --- |
| アカウント | **ChatGPT Plus または Pro**（ChatGPT プラン枠で推論するために必要） |
| 利用条件 | SIWC の ChatGPT プラン利用は、公開 OSS とローカルで動く個人プロジェクト向け。外部公開しない |
| ランタイム | Bun 1.3.14（`bun.lock` で固定。Node.js は不要） |
| ブラウザ | 同意操作とコールバックのため、**アプリを動かすマシン上のブラウザ**で開く |
| ポート | 既定 8787（`PORT` で変更可。変更するとコールバック URI も変わります） |

## セットアップと起動

```bash
cd projects/_labs/sign-in-with-chatgpt-poc/openai-sdk
bun install
bun run dev
```

ターミナルに出る `http://127.0.0.1:8787/` をブラウザで開き、**Continue with ChatGPT** を押します。

起動時にブラウザを開く子プロセスは作りません（資格情報を子プロセスへ継承させないため、手動で開いてください）。

### 環境変数

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `PORT` | `8787` | 待ち受けポート。`redirect_uri` もこの値から作る |
| `SIWC_STORAGE_DIR` | `$XDG_CONFIG_HOME/sign-in-with-chatgpt-poc/openai-sdk` | 資格情報の保存先（リポジトリ外） |
| `SIWC_APP_NAME` | `sign-in-with-chatgpt-poc openai-sdk` | 初回登録の `agent_name_hint`。同意画面に出る名前 |
| `SIWC_ENABLE_DEBUG_ACTIONS` | `true`（`false` で無効化） | 失敗系を再現するデバッグ操作の有効/無効 |
| `SIWC_DEFAULT_MODEL` | `gpt-6-luna` | 画面で初期選択するモデル。アカウントのカタログに無い場合は「※カタログに無し」と付けて選択肢に残し、実際の可否は送信で確かめる（モデルの利用可否はアカウント・プラン依存のため） |

### WSL2 で動かす場合

Windows 側のブラウザから `http://127.0.0.1:8787/` を開けるか確認してください。開けない場合は、Windows の `localhost` から WSL2 への転送が効いていないため、`netsh interface portproxy` などで 8787 を転送するか、WSL 内のブラウザを使ってください。コールバックのホストは `127.0.0.1` 固定です（`localhost` への置き換えは SIWC 側で許可されません）。

## 実際の認証方式

公式ドキュメントに沿った **OAuth 2.0 Authorization Code + PKCE（S256）/ OpenID Connect** です。devkit（`@siwc/local`）は npm 未公開かつ非商用ライセンスのため使わず、ドキュメントの仕様どおりに実装しています。

| 段階 | 実装 |
| --- | --- |
| 初回登録 | `client_id=dynamic_agent_client`、`agent_name_hint`、`ext_agent_host_id`（`urn:uuid:...` をファイルへ永続化）を送る。コールバックで返る発行済み `client_id`（`oaiapp_...`）を保存し、`dynamic_agent_client` は保存しない |
| 再認可 | 保存済み `client_id` と `id_token_hint`（保存した ID トークン）・`login_hint`（保存メール）で認可。`agent_name_hint` は送らない。コールバックの `client_id` が進行中の登録と違う場合は拒否する |
| エンドポイント | `https://auth.openai.com/.well-known/openid-configuration` から取得（issuer が想定と違えば拒否） |
| トークン交換 | `POST https://auth.openai.com/api/accounts/oauth/token` に form（`grant_type=authorization_code` / 発行済み `client_id` / `code` / `code_verifier` / `redirect_uri` / `resource`）。client secret は使わない |
| ID トークン検証 | `jose` で JWKS を取得し、署名・issuer・audience（発行済み client_id）・exp・nonce を検証。`sub` をアカウント識別子にする |
| 保存 | `session.json` に登録情報とトークン、`chatgpt-host.json` にホスト ID。ディレクトリ `0700` / ファイル `0600` でアトミックに書き換え |
| 更新 | 期限の 60 秒前に自動更新。同一プロセスの同時更新は直列化し、`scope` は送らない（付与を維持） |
| サインアウト | discovery の `revocation_endpoint` へ `token_type_hint=refresh_token` で form POST（5xx とネットワーク失敗のみ再試行）。失効を確認できなくてもローカルのトークンは削除し、画面に警告を出す |

### 要求するスコープ

| スコープ | 用途 |
| --- | --- |
| `openid` `profile` `email` | アカウントの識別（ID トークン） |
| `offline_access` | 更新トークン |
| `resource.invoke` | `https://api.openai.com/v1` のリソース利用 |
| `chatgpt.tokens.use.direct` | ChatGPT プラン枠での推論。**このスコープが無いと推論できない** |

## 画面と操作方法

| 場所 | 内容 |
| --- | --- |
| 接続 | サインイン状態、`ChatGPT プラン利用` の有効/無効、アクセストークンの残り時間、スコープ、保存先、host ID |
| 操作 | `Continue with ChatGPT`（初回登録）/ `再認可` / `同意をやり直す`（`prompt=consent`）/ `アクセストークンを更新` / `サインアウト` / ChatGPT 設定の使用量 |
| 推論 | モデル選択（`/v1/models` のカタログから。既定は `gpt-6-luna`）、`instructions`、複数ターンの入力、SSE での逐次表示、`中断`。アクセストークンを更新した場合はステータスに表示 |
| デバッグ | `アクセストークンを期限切れにする` / `アクセストークンを偽物にする` / 未対応フィールド（`temperature=0`）の付与 |

## 実測結果

2026-10-13 に、ChatGPT プラン利用を許可したアカウントで測定しました（アカウント種別（Plus / Pro）は未確認）。OAuth ログインと実推論は手動、それ以外は画面と `curl` で確認しています。

| # | 項目（Issue #1936 のチェックリスト） | 期待 | 結果 | 備考 |
| --- | --- | --- | --- | --- |
| 1 | SIWC でサインインし、必要なスコープと利用許可を確認する | 同意画面でプラン利用の許可を求められ、`chatgpt.tokens.use.direct` を含むスコープが付与される | **成功** | 付与されたスコープは `chatgpt.tokens.use.direct` / `email` / `offline_access` / `openid` / `profile` / `resource.invoke` の 6 件。`client_id` は `oaiapp_...` が発行され、`ext_agent_host_id` は `urn:uuid:...` で永続化された |
| 2 | OAuth アクセストークンを `openai` SDK の Bearer 認証に使う | SDK が `Authorization: Bearer` で `/v1/responses` を呼ぶ | **成功** | APIキーなしで推論できた |
| 3 | 利用可能モデルを取得・選択する | `{ models: [...] }` 形式のカタログから `visibility: "list"` のみが並ぶ | **成功** | 生の応答は `{ models: [...] }` で 10 件。`visibility` は `list` と `hide` の 2 値で、`list` の 7 件を返した（下記「モデルカタログの生データ」） |
| 4 | `store:false` / `stream:true` で `response.completed` まで受信する | テキストが途中経過として流れ、`completed` で終わる | **成功** | `completed` のレスポンスに `usage`（`input_tokens` / `output_tokens` / `reasoning_tokens` と `attribution` 内訳）が付いた |
| 5 | 2 ターンの対話 | 履歴を `input` 配列で送り、2 ターン目も文脈が続く | **成功** | 直前のやり取りを `input` に含めて送ると、内容を引き継いだ応答が返った（`Say exactly: Hello, world!` → `ではそれを日本語にしてください。` → `こんにちは、世界！`） |
| 6 | 認証期限切れ / 更新 | 「期限切れにする」後の送信で自動更新され、そのまま成功する | **成功** | 「期限切れにする」後の送信で更新が走り、`savedAt` が更新された。ストリームの先頭に `token` イベント（`refreshed: true`）を出すので、画面上でも自動更新が分かる |
| 7 | 再起動後の再利用 | アプリを再起動しても保存済みトークンで再利用できる（再サインイン不要） | **成功** | プロセスを kill して再起動後も `signedIn: true` / 同じ `client_id` / `ChatGPT プラン利用: 有効` |
| 8 | ログアウト | 失効要求が成功し、ローカルのトークンが消え、再送信は 401 になる | **成功** | 失効は成功（`revoked: true`、HTTP 200）。`tokens` は `null` になり、登録情報（`client_id` / email / host ID）は残った。再送信は `401 not_signed_in` |
| 9 | 権限不足（`chatgpt.tokens.use.direct` なし） | サインインは成立し、画面が `ChatGPT プラン利用: 無効` になる | **部分的に成功** | 同意を拒否した場合は `error=access_denied` として中断する（ドキュメントどおり、コード交換も行わない）。「サインインは成立したがプラン利用だけ許可されない」分岐は未検証（同意画面を再表示する `prompt=consent` を用意したので、プラン利用だけ外せる画面ならそこで確認できる） |
| 10 | 401 | `401` とエラーコード・request ID が画面に出る | **成功** | `status: 401` / `code: invalid_api_key` / `request ID: req_...` が表示された。API 側のメッセージは鍵をマスクした断片を含む（実トークンは含まない）。「アクセストークンを更新」で回復できた |
| 11 | 403 | 制限の内容がコードとヒント付きで出る | 未検証 | アカウント・ワークスペースの状態に依存。検証時は使用量の残りが少なく、上限に当てる検証は行わない方針とした |
| 12 | 429 | `subscription_sharing_usage_limit_exceeded` として表示され、使用量設定へ誘導される | 未検証 | 同上（意図的に上限へ到達させていない） |
| 13 | `response.failed` | ストリーム中の失敗として code / param 付きで表示される | 未検証 | 同上。コード上の処理は `tests/inference.test.ts` で確認済み |
| 14 | 途中切断 | 「中断」で上流リクエストが中断され、画面は中断表示になる | **成功**（クライアント切断で確認） | ストリーム中にクライアントから切断してもプロセスは正常のまま（エラーログなし）で、その後のリクエストも 200。上流は `AbortController` で中断する。画面の「中断」ボタンは同じ経路だが未確認 |
| 15 | 型チェックとテスト | `bun run lint` と `bun test` が通る | **成功**（71 tests） | PR の CI でも同じ経路を実行（`Dockerfile` の `test` ステージ） |
| 16 | 失敗系: 未対応フィールド | `temperature=0` を付けると未対応エラー（400 系）になる | **成功** | `status: 400` / `message: Unsupported parameter: temperature`。`code` と `param` は付かず、request ID も無かった（想定していた `subscription_sharing_unsupported_capability` ではなかった） |

### モデルカタログの生データ（実測）

`GET https://api.openai.com/v1/models` を OAuth アクセストークンで呼んだ結果です。

- トップレベルは `{"models": [...]}` で 10 件。`visibility` は `list`（7 件）と `hide`（3 件）の 2 値
- `display_name` で表示し、`slug` を `model` として送る。並び順はサーバーのまま（`gpt-6.1-sol` → `gpt-6-astra` → `gpt-6-sol` → `gpt-6-luna` → `gpt-5.6-sol` → `gpt-5.6-terra` → `gpt-5.6-luna`）
- 1 件の要素には `slug` / `display_name` / `visibility` のほか、`context_window` / `max_context_window` / `supported_reasoning_levels` / `default_reasoning_level` / `available_in_plans` / `service_tiers` / `supported_in_api` / `base_instructions` / `prefer_websockets` / `truncation_policy` など多数のフィールドが含まれる
- `openai` SDK の `models.list()` は `{ data: [...] }` を前提にするためこの応答を扱えない。このサンプルでは `fetch` で直接読む
- このエンドポイントのレスポンスには request ID ヘッダー（`openai-request-id` / `x-request-id`）が付かなかった

### 実行時の値

| 項目 | 値 |
| --- | --- |
| `openai` SDK | 7.32.0 |
| `hono` | 4.13.13 |
| `jose` | 6.2.12 |
| Bun | 1.3.14 |
| TypeScript | 7.0.2 |
| 使用モデル | `gpt-6-luna`（カタログに含まれ、既定として選択できた） |
| 認可エンドポイント | `https://auth.openai.com/api/accounts/authorize` |
| トークンエンドポイント | `https://auth.openai.com/api/accounts/oauth/token` |
| モデルカタログの応答形式 | `{ models: [{ slug, display_name, visibility, ... }] }`（`visibility: "list"` の 7 件） |
| 付与されたスコープ | `chatgpt.tokens.use.direct` `email` `offline_access` `openid` `profile` `resource.invoke` |

## 確認手順（正常系）

1. `bun run dev` して `http://127.0.0.1:8787/` を開く
2. **Continue with ChatGPT** → ブラウザでサインインし、プラン利用の許可を確認して承認する
3. 戻って `サインイン済み` と `ChatGPT プラン利用: 有効` を確認する（1）
4. モデルを選び、`Say exactly: Hello, world!` を送信する（2・3・4）
5. 続けて `では今の文を日本語にして` を送信し、2 ターン目が文脈を保つことを確認する（5）
6. 「アクセストークンを期限切れにする」→ 送信し、自動更新されて成功することを確認する（6）
7. アプリを再起動し、リロードしてもサインイン済みのままであることを確認する（7）
8. 「サインアウト」→ リロードして未サインインに戻り、送信すると 401 になることを確認する（8）

## 失敗系の再現手順

| 目的 | 手順 | 期待 |
| --- | --- | --- |
| 401 | デバッグの「アクセストークンを偽物にする」→ 送信 | `401` / `invalid_api_key` / request ID が表示される。「アクセストークンを更新」で回復できる |
| 期限切れ / 更新 | 「アクセストークンを期限切れにする」→ 送信 | 送信前に更新が走り、そのまま成功する。画面のステータスに「アクセストークンを自動更新しました」が出る（実測済み） |
| ログアウト | 「サインアウト」→ リロードして送信 | 失効は成功し、ローカルのトークンが消え、送信は `401 not_signed_in` になる（実測済み）。登録情報は残るので再認可できる |
| 権限不足（同意拒否） | 同意画面でプラン利用を許可せず「拒否」を選ぶ | サインインに失敗し「同意が拒否されました」が表示される（実測。`error=access_denied` として中断し、コード交換もしない） |
| 権限不足（プラン利用のみ無効） | 「同意をやり直す」で同意画面を再表示し、プラン利用だけ許可せず完了する | サインインは成立し、`ChatGPT プラン利用: 無効` と再認可の案内が出る（未検証。推論はプラン利用のスコープ不足で拒否される想定） |
| 未対応フィールド | デバッグの `temperature=0` を有効にして送信 | `400 Unsupported parameter: temperature` が表示される（実測。`code` / `param` / request ID は付かない） |
| 途中切断 | 送信直後に「中断」 | 上流のストリームが中断され、画面に「中断しました。」が出る |
| 状態不一致 | 認可を開始した後に別タブで認可をやり直し、古いタブのコールバックを使う | `state` 不一致として拒否される |
| 登録未完了 | コールバックに発行済み `client_id` が含まれない | `missing_issued_client_id` として拒否され、登録を保存しない |
| 別アカウントの混入 | 再認可でコールバックの `client_id` が保存済みと違う | `client_id_mismatch` として拒否し、保存済みの登録を上書きしない |

403 / 429 / `response.failed` はアカウントやワークスペースの状態に依存するため、画面の実測結果欄に「未検証」または実際の値を記録します。

## 公式ドキュメント由来の制約

- 推論は `POST https://api.openai.com/v1/responses` のみ。ChatGPT の `backend-api` は使わない
- `store: false` と `stream: true` を毎回付ける。成功判定は `response.completed` の受信で行い、途中終了は成功にしない
- 履歴は `input` 配列で送る（`previous_response_id` は不可）。`system` ロールの message は受け付けられず、`instructions` を使う
- `background` / `conversation` / `max_output_tokens` / `metadata` / `prompt` / `temperature` / `top_p` / `truncation` などは未対応
- 画像生成・file search・Code Interpreter・native computer use・hosted MCP などは未対応
- 利用上限は ChatGPT 側で管理され、Plus は 5 時間枠の上限を他のアプリと共有する（Pro は対象外）

## 型チェックとテスト

```bash
bun run lint   # tsc --noEmit + biome lint
bun test       # bun test
```

単体テストは PKCE（RFC 7636 のテストベクタ）、認可 URL のパラメータ、ID トークン検証、初回登録・再認可での `client_id` の扱い、資格情報ファイルの権限、トークン交換/更新/失効、モデルカタログの形式、ストリームのイベント変換、ルートの入出力を対象にしています。OAuth ログインと実推論の E2E は手動検証です。

CI（PR）ではルートの `Dockerfile` の `test` ステージで `bun run lint` と `bun test` を実行します。このサンプルはブラウザとホスト上の資格情報ファイルが前提のため、Docker での起動は想定していません（`final` ステージはありません）。

## セキュリティ上の扱い

- トークンはブラウザへ返さない。画面に出るのはメール・スコープ・期限・モデル名のみ
- 認可 URL には `id_token_hint` が含まれるため、URL やクエリをログに出さない（アプリはリクエストログを出力しない）
- 資格情報はリポジトリ外（既定 `~/.config` 配下）に `0600`、ディレクトリは `0700`。アトミックに書き換える
- 子プロセスを起動しないため、ツールやシェルへ資格情報が継承されない
- `SIWC_ENABLE_DEBUG_ACTIONS=false` で、失敗系を再現する操作を無効化できる

### トークンの期限切れ・更新・失効の違い

実際に触ると混同しやすい点なので、実測結果と合わせて残します。

| 操作 | 何が起きるか | アプリの振る舞い |
| --- | --- | --- |
| 「アクセストークンを期限切れにする」（デバッグ） | 保存した `expiresAt` を過去にするだけ。トークン自体は有効 | 送信前（残り 60 秒以下）に更新するため、そのまま会話できる。これが正常な振る舞いで、ストリーム先頭の `token` イベントで更新が分かる |
| 「アクセストークンを偽物にする」（デバッグ） | `access_token` をダミー文字列にし、期限は未来のままにする | 更新が走らないので `401 invalid_api_key` になる。「アクセストークンを更新」で回復できる |
| 「サインアウト」 | 更新トークンを `revocation_endpoint` で失効させ、ローカルのトークンを削除する | 以後は `401 not_signed_in`。登録情報（`client_id` / host ID）は残るので再認可できる |
| ChatGPT 設定で接続を解除 | OpenAI 側でセッションが失効する | 次の更新か推論で `invalid_grant` 系のエラーになり、再サインインが必要になる（**未検証**） |

アクセストークンは短命で自動更新されるため、アプリの利用を止めるには更新トークン（セッション）ごと失効させる必要があります。

## 参考

- [Integrating Sign in with ChatGPT（Cookbook）](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
