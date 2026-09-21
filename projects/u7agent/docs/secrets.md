# APIキー漏洩の抑制

プロバイダーAPIキーを環境変数で BFF へ渡す運用でも、キーが LLM・ブラウザ・ログへ流れにくくする多層防御。ツール実行自体はサンドボックスへ分離済み（[sandbox.md](sandbox.md)）で、ここで述べるのは BFF 内での出力マスク（キーが作業領域のファイル等へ現れた場合の二次漏洩対策）と、SDK の公開 API だけで実装する縛り。

## 保護対象

- `createRuntimeSecretMasker()`（`server/src/secret-guard.ts`）が `ModelRuntime.getProviders()` の各プロバイダーに対し pi-ai の公開ヘルパー `findEnvKeys()` で「設定済みのキー変数」を解決し、その非空値を保護対象にする。findEnvKeys が解決しない既知プロバイダーのキー変数（Bedrock の `AWS_BEARER_TOKEN_BEDROCK`）は補完テーブルで埋める。独自プロバイダー分は `PI_SECRET_ENV_VARS` で変数名を追加する
- 自動解決された値は 8 文字未満を通常出力の過剰改変防止のため対象外にする。`PI_SECRET_ENV_VARS` で明示指定された変数は運用者の意図なので長さに関係なく保護する。重複・包含する値は長い順に置換する
- ユーザーがチャットへ直接入力したキーはモデルへはそのまま渡る（対象はツール出力由来の値）。ただしエコー（タイトル・プロンプト表示・メッセージ履歴・text delta）はマスクする
- 会話は BFF 専用ストアの `session.jsonl` / `meta.json` に保存される。生のユーザー入力・モデル出力を含むが、ツール出力は LLM・履歴へ渡す前にマスクされるため保存後も `[REDACTED]` のままになる。ストアはサンドボックスへマウントしない（[persistence.md](persistence.md)）
- ツール引数・出力の要約は、切り詰めの前にマスクする。先に切り詰めると要約上限の境界でキーの末尾が欠け、大部分がそのまま残るため

## レイヤー

1. **実行の分離（`server/src/sandbox/`）**
   - 作業用ツールは全てサンドボックス（別プロセス・別コンテナ）で実行する。BFF は子プロセスを起こさないため、子プロセスの環境変数を絞る旧 child-env.ts は役目を終えて廃止した
   - サンドボックスには LLM 認証情報を渡さない。bash が何を読んでも（`BASH_ENV`・`~/.bashrc` 等）、キーはそこに存在しない
2. **ツール定義のフック（`server/src/secret-guard.ts`）**
   - `createRemoteToolDefinitions` が作るリモート定義を `wrapToolDefinitionWithSecretMasker` で包み、途中出力（`onUpdate`。bash は累積スナップショットが来るので末尾保留・先頭部分一致付きでマスク）・最終結果・エラーメッセージをマスクする。エラーは完全一致のときのみ元の Error を保持する
3. **tool_result 拡張（同ファイル）**
   - インライン拡張（`DefaultResourceLoader` の `extensionFactories`）で `tool_result` を購読し、全ツールの最終結果を LLM・履歴・`tool_execution_end` イベントへ渡る前にマスクする。`noExtensions: true` でもインラインファクトリは読み込まれる。シェル以外のツール（read / grep 等）もここで一括して掛かる
4. **BFF の送出層（`server/src/sessions.ts` / `server/src/run-events.ts`）**
   - SSE / イベントログへ出すテキスト（text delta、メッセージ、ツール引数・出力、エラー、プロンプトのエコー、タイトル）を防御的にマスクする
   - アシスタントの差分は `createStreamingSecretMasker` で配信前に「秘密値の前方一致になり得る末尾」を保留し、チャンク境界をまたぐキーが複数回の配信から復元できないようにする。保留分は `message_end`（アシスタント確定時）と `finish()`（完了・エラー・中断のいすれでも）でフラッシュする

## 切り詰め境界への対応

SDK はツール出力をいくつかの方法で切り詰める。キーが切り詰め境界に跨ると、結果のテキストには完全一致が現れなくなり完全一致の置換だけでは検出できない。このため `maskSafe`（最終結果）と `maskAccumulated`（累積スナップショット）は次の部分一致も置換する。

- **先頭の欠落**: bash ツールの末尾 50KiB / 2000 行切り詰めで、結果のテキストがキーの途中から始まるケース。先頭の部分一致（4 文字以上）を `[REDACTED]` へ置換する
- **行境界の欠落**: grep が一致行を 500 文字へ切り詰めて `... [truncated]` マーカーを付与するケース。マーカー直前のテキストがキーの前方一致で終わる場合、その断片（4 文字以上）を `[REDACTED]` へ置換する

4 文字未満は再構成リスクが小さく、通常出力への誤置換を避けるため対象外とする。

## 検証

実APIは呼ばず、ダミーキーとスタブで検証する。

- `server/test/sandbox-service.test.ts` — 実行APIの認証（未認証 401・未知ツール 404）、実SDKのbash/read/write/grepによる実行とNDJSON、rootCwd 基準のパス解決、cancel による中断と速やかなストリーム閉鎖、セッションメタ変数・トークンが子プロセス出力へ出ないこと、close での全実行中断
- `server/test/sandbox-client.test.ts` — NDJSON 解釈（start/update/result/error）、abort 時の cancel エンドポイント発火と `Operation aborted`、HTTP エラーの文言変換
- `server/test/secret-guard.test.ts` — リモート定義を包むマスカーの出力マスク、途中出力とエラーのマスク、SDKの切り詰めで先頭が欠けたケース、実SDKのgrepで行切り詰め境界に跨った断片のマスク、`tool_result` 拡張
- `server/test/redact.test.ts` — マスク本体（重複値、チャンク境界、中断時のフラッシュ）
- `server/test/sessions-secrets.test.ts` — SSE イベント・payload・エラー経路のマスクと、秘密を含まない出力が改変されないこと

## 残存リスク

- 分割・エンコードされたキーや未登録の秘密情報は検出できない。OAuth トークンは対象外
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれる。ファイル自体はマスクされない
- サンドボックス・作業領域側のリスクは [sandbox.md](sandbox.md) を参照する
