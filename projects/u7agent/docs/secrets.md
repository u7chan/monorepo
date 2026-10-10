# 秘密情報の扱い（出力マスクと作業フォルダの環境変数）

プロバイダーAPIキーを環境変数や 設定 → モデルの GUI（[model-settings.md](model-settings.md)）で BFF へ渡す運用でも、キーが LLM・ブラウザ・ログへ流れにくくする多層防御。ツール実行自体はサンドボックスへ分離済み（[sandbox.md](sandbox.md)）で、ここで述べるのは BFF 内での出力マスク（キーが作業領域のファイル等へ現れた場合の二次漏洩対策）と、SDK の公開 API だけで実装する縛り。

後半の[作業フォルダの環境変数](#作業フォルダの環境変数)（作業環境 → 環境変数）は、**保存時暗号化と実行時注入**で同じ目的を別の層から支える仕組み。暗号化の対象はこの機能で登録したシークレットだけで、プロバイダー / コンテンツ生成（画像 / 音声） / Web 検索の APIキーは従来どおり平文である（[平文で残るもの](#平文で残るもの)）。

## 保護対象

- `createRuntimeSecretMasker()`（`server/src/secret-guard.ts`）が `ModelRuntime.getProviders()` の各プロバイダーに対し pi-ai の公開ヘルパー `findEnvKeys()` で「設定済みのキー変数」を解決し、その非空値を保護対象にする。findEnvKeys が解決しない既知プロバイダーのキー変数（Bedrock の `AWS_BEARER_TOKEN_BEDROCK`）は補完テーブルで埋める。独自プロバイダー分は `PI_SECRET_ENV_VARS` で変数名を追加する
- 自動解決された値は 8 文字未満を通常出力の過剰改変防止のため対象外にする。`PI_SECRET_ENV_VARS` で明示指定された変数は運用者の意図なので長さに関係なく保護する。重複・包含する値は長い順に置換する
- 設定 → モデルで登録したキーは `createMutableSecretMasker` の `setSecrets` で保護対象へ足す。登録は **SDK / DB へ渡す前**に行い、起動時は DB から読めた全行（orphan・不正値・適用失敗を含む）を適用前に登録する。削除・上書き後も**プロセス生存中は保護対象から外さない**（`session.jsonl` の raw 入力を再投影しても旧キーを出さないため。入力は 8..2048 文字で、これより短いキーは GUI の対象外）
- コンテンツ生成の APIキー（`content_settings`。画像と音声で 1 つを共有する）も同じ扱いで、`PUT /api/settings/content/key` が DB へ書く前に `retainSecret()` で登録し、起動時の `ContentSettingsService.applyStored()` も保存行のキーを登録する（[image-generation.md](image-generation.md#キーの扱い)）。画像 / 音声の provider 呼び出しは BFF 内で完結し、キーはサンドボックスへ渡らない
- SQLite の失敗文言にキーが載る経路（`AppDb.#query` と `open()`）は `AppDb.open({ sanitizeError })` でマスカーを通してからログ・`#error`（health / 503）へ渡す。`model-settings.ts` は固定文言だけを応答へ返し、ログには provider id と分類だけを残す
- 設定 → モデルの provider メモは秘密情報ではないため保護対象へ足さない（`retainSecret` に渡さない）。任意の自由文を登録すると、短いメモでも `createMutableSecretMasker` が値をマスクし、よくある単語が会話表示で赤塗りされる誤爆の方が実害より大きい。代わりに `model-settings.ts` はログ・health・エラー文言のどの経路にもメモ値を載せない（値は API 応答と画面にだけ出す）
- ユーザーがチャットへ直接入力したキーはモデルへはそのまま渡る（対象はツール出力由来の値）。ただしエコー（タイトル・プロンプト表示・メッセージ履歴・text delta・未送信メッセージの表示本文 `pendingSends[].text`）はマスクする
- 会話は BFF 専用ストアの `session.jsonl` / `meta.json` に保存される。生のユーザー入力・モデル出力を含むが、ツール出力は LLM・履歴へ渡す前にマスクされるため保存後も `[REDACTED]` のままになる。ストアはサンドボックスへマウントしない（[persistence.md](persistence.md)）
- ツール引数・出力の要約は、切り詰めの前にマスクする。先に切り詰めると要約上限の境界でキーの末尾が欠け、大部分がそのまま残るため
- スキル読み込みの導出値（`ChatMessage.skillLoads[].name` / `path`、`ToolCall.skill.name` / `path`）もマスクしてから配る。ただし basename の判定は raw path で行う必要があるため、**解決 → 分類 → mask** の順を守る（先にマスクすると、`/` を含む秘密値で `SKILL.md` 判定が壊れ、行ごと消える）
- `ask_user` の質問 / 回答（`ToolCall.questions` / `ToolCall.answers`）も mask してから配る。質問はツール引数、回答は toolResult の `details` 由来で、content に掛かる後述の layer 3 を通らないため（[ask-user.md](ask-user.md#mask-規則)）

## レイヤー

1. **実行の分離（`server/src/sandbox/`）**
   - 作業用ツールは全てサンドボックス（別プロセス・別コンテナ）で実行する。BFF は子プロセスを起こさないため、子プロセスの環境変数を絞る旧 child-env.ts は役目を終えて廃止した
   - サンドボックスには LLM 認証情報を渡さない。bash が何を読んでも（`BASH_ENV`・`~/.bashrc` 等）、キーはそこに存在しない
2. **ツール定義のフック（`server/src/secret-guard.ts`）**
   - `createRemoteToolDefinitions` が作るリモート定義を `wrapToolDefinitionWithSecretMasker` で包み、途中出力（`onUpdate`。bash は累積スナップショットが来るので末尾保留・先頭部分一致付きでマスク）・最終結果・エラーメッセージをマスクする。エラーは完全一致のときのみ元の Error を保持する
   - BFF ローカルの `generate_image`（`server/src/image-tools.ts`）、`web_search`（`server/src/web-search-tool.ts`）、`investigate`（`server/src/investigate-tool.ts`）も同じヘルパーで包む。ローカル定義は layer 2 のリモート定義生成を通らないため、execute が throw する文言（provider の失敗分類・設定の読取失敗・接続例外）をここでマスクする。`investigate` は子の進捗（`onUpdate`）もここでマスクし、SSE の `tool_progress` としてブラウザへ渡る前に落とす
3. **tool_result 拡張（同ファイル）**
   - インライン拡張（`DefaultResourceLoader` の `extensionFactories`）で `tool_result` を購読し、全ツールの最終結果を LLM・履歴・`tool_execution_end` イベントへ渡る前にマスクする。`noExtensions: true` でもインラインファクトリは読み込まれる。シェル以外のツール（read / grep 等）もここで一括して掛かる
   - 対象は `content` だけで、`details` は掛からない。`details` から DTO を作る導出値（`ask_user` の質問 / 回答）は、載せる前に `run-events` / `session-projection` 側で個別にマスクする
   - ユーザーが `ask_user` の回答に登録済みの秘密値を書くと、モデルにも `[REDACTED]` が届く（回答では作業を続けられない。既知の制限）
4. **BFF の送出層（`server/src/sessions.ts` / `server/src/run-events.ts`）**
   - SSE / イベントログへ出すテキスト（text delta、メッセージ、ツール引数・出力、`tool_progress` の進捗本文、エラー、プロンプトのエコー、タイトル）を防御的にマスクする。`tool_progress` は累積スナップショットとして扱い、末尾の不完全な秘密値もこの層で保留する（[subagent.md](subagent.md#進捗)）
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
- `server/test/sessions-secrets.test.ts` — SSE イベント・payload・エラー経路のマスクと、秘密を含まない出力が改変されないこと。スキル読み込みの `ToolCall.skill` / `ChatMessage.skillLoads` も対象
- `server/test/model-settings.test.ts` / `server/test/model-settings-api.test.ts` — GUI 登録キーのマスカー登録順序、DB 例外にキーが載っても応答・health・ログに出ないこと
- `server/test/content-settings.test.ts` / `server/test/content-settings-api.test.ts` — 画像キーのマスカー登録順序（DB より前・起動時）、DB 例外にキーが載っても応答・health・ログに出ないこと、ローカル定義（`generate_image`）の throw のマスク（`server/test/image-tools.test.ts`）。`web_search` も切り詰めの前のマスクと throw のマスクを `server/test/web-search-tool.test.ts` で、Web 検索キーの登録順序（DB より前・起動時）と応答に値を載せないことを `server/test/web-search-settings.test.ts` / `server/test/web-search-settings-api.test.ts` で固定する
- `server/test/app-db.test.ts` — `sanitizeError` が `#query` のログ・`#error`・`open()` の失敗の両方に効くこと。secrets の加算移行、新しい schema での作り直しでも秘密が消えないこと、並びと値列の排他
- `server/test/secret-crypto.test.ts` — AEAD の往復、nonce を再利用しないこと、AAD 不一致 / 改ざん / 誤鍵 / 未知の鍵版の拒否、master key の書式と解決
- `server/test/secrets.test.ts` — 名前と値の規則、cwd スコープの照合 (他会話の `secret_id` は 404)、一覧が名前・種別・更新時刻だけを返すこと、世代、起動 env の解決とマスカー登録 (8 文字未満は登録しない)
- `server/test/secrets-api.test.ts` — API の往復、シークレットの値がどの応答にも載らないこと、別 cwd の参照 / 変更 / 削除の拒否、master key 未設定の 503 `not_stored`
- `server/test/serve.test.ts` — 起動時の環境変数がコマンド文字列へ入らず exec の env として渡ること、`secretGeneration` が記録に載り値は載らないこと、解決失敗で起動しないこと
- `server/test/sandbox-service.test.ts` — 注入した env が bash の子プロセスへ入り、予約名 / 不正な名前は 400、master key は子プロセスへ漏れないこと
- `client/test/sessionEnv.test.ts` — 名前のプレビュー、種別ごとの文言、短い値の注記、追加フォームの送信可否、要求元 (sessionId / projectId) の解決
- `server/test/redact.test.ts` — `createMutableSecretMasker` の swap（追加・置換・失敗時の原子性）と、先に作った streaming masker が swap 後の値を保留幅に使うこと

## 残存リスク

- 分割・エンコードされたキーや未登録の秘密情報は検出できない。OAuth トークンは対象外
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれる。ファイル自体はマスクされない
- サンドボックス・作業領域側のリスクは [sandbox.md](sandbox.md) を参照する
- 設定 → モデルで登録したキーは `PI_SESSION_STORE/u7agent.db` に**平文**で残る。WAL・バックアップ・ボリュームの読み取り権限を持つ者は読める。ログイン認証がないため BFF を LAN / インターネットへ公開しない（詳細は [model-settings.md](model-settings.md#残存リスク)）
- 削除・上書きした旧キーの保護は**プロセス生存中だけ**。再起動後はチャットへ貼り付けた生の入力が再投影で見えうる（tombstone は将来課題）
- ランタイム初期化に失敗したとき（`pi` が null）は可変マスカー自体が作られないため、この状態で起動したプロセスでは DB のキーを新たにマスク対象へ足せない。この場合も認証変更 API と画像キー登録 API は 503 で、キーは新規登録されない

## 作業フォルダの環境変数

作業フォルダ（cwd）単位で名前と値を登録し、サービス（serve）へ実行時だけ渡す。種別は 2 つ。

| 種別 | 保存 | 値が見える範囲 |
| --- | --- | --- |
| 変数 | 平文（`secrets.plaintext`） | エージェントの `bash`（exec ごとの env）と、サービスの起動時 env |
| シークレット | AEAD（`ciphertext` / `nonce` / `keyVersion`） | サービスの起動時 env だけ |

### 所有者とスコープ

- 所有者は会話ではなく **cwd**（`rootCwd` 相対）。`serve_commands` と同じキー空間で、「そのフォルダで動くサービスにはそのフォルダの env が入る」。プロジェクト所属は登録ディレクトリ、未所属は所属スペースのスクラッチ（通常スペースは `.u7agent/sessions/<id>`）なので、同じ作業フォルダを使う会話は自動的に共有する
- 一覧・変更・削除は、要求元セッション（`sessionId`）または未作成のプロジェクト起点の会話（`projectId`）を cwd へ解決し、行の `cwd` と照合する（`server/src/secrets.ts` の `createSecretScope` と `SecretService#find`）。他会話の `secret_id` を指定しても 404 で拒否される
- プロジェクト行の登録解除（`DELETE /api/projects/:id`）では秘密を消さない。`cwd` がキーなので、同じディレクトリを再登録すれば設定はそのまま戻る
- cwd が決まっている会話ではタブを出す（プロジェクト起点の新規会話でも保存できる）。未所属の新規会話は `sessionId` の採番後から。設定ページでは出さない（[ui-layout.md](ui-layout.md#作業環境パネル)）

### 名前と値の規則

名前（`process.env.<name>` の名前そのもの。`server/src/env-names.ts` が正）:

- 使用可能文字は半角英数字と `_` だけ（先頭は英字か `_`）。長さは正規化後 1〜64 文字。前後の空白は trim してから検証する
- trim → 大文字化して保存・一意性判定・注入・表示を揃える。UI は入力中に正規化後の名前をプレビューする。**変更はできず**、変えたいときは削除して作り直す
- `PI_*` / `PI_SANDBOX_*` / `U7AGENT_*` と、実行制御系（`PATH` / `HOME` / `NODE_OPTIONS` / `NODE_PATH` / `LD_PRELOAD` / `LD_LIBRARY_PATH` / `PYTHONPATH` / `PYTHONSTARTUP` / `BASH_ENV` / `IFS` / `SHELLOPTS` / `PS4`）は拒否する
- `VITE_*` / `NEXT_PUBLIC_*` / `REACT_APP_*` / `PUBLIC_*` は、値がブラウザのバンドルへ入るスタックのため**シークレットでは拒否**する（変数では許可する）

値:

- 変数は 1〜4096 文字、シークレットは 1〜8192 バイト（UTF-8）。NUL は拒否し、CRLF は LF へ正規化する
- 前後の空白 / 改行は除去して保存する。除去したときだけ応答の `trimmed` が true になり、UI が「前後に空白 / 改行があったため除去しました」を 1 行出す（無言で加工しない）
- 空値は不可（未設定にしたいときは削除する）
- 一覧は名前・種別・更新時刻だけを返す。値を返す API は**変数**の詳細（`GET /api/secrets/:secretId`）だけで、シークレットの値は保存後にどの経路でも返らない
- 並びは `sortOrder`（追加は `MAX + 1`、削除で詰めない）→ 名前順。並べ替え UI は無い（列だけ用意する）

### 注入経路

- **変数**: エージェントの `bash` へ **exec ごとの env** として渡す（`SandboxExecuteRequestBody.env`）。変更はエージェントの次の `bash` から反映する
- **変数 + シークレット**: `serve` の起動時 env として渡す。起動スクリプト（`launchScript`）のコマンド文字列へは埋め込まない（base64 化もしない）
- 起動時の解決は**起動元の作業フォルダ**から行い、解決に失敗したら起動しない（平文で保存し直す / 秘密なしで起動する、のどちらもしない）。既に動いているサービスは古い値のままなので、シークレットの変更は次回の起動から反映する
- `ServeRecord.secretGeneration` に起動時に解決した世代（名前 → `secret_id` / 更新世代のハッシュ）を残し、`GET /api/secrets` の `generation` と比べると「再起動で反映される変更がある」と分かる。UI はタブ上部の説明 1 行までで、行ごとの未反映バッジと再起動ボタンは次のフェーズ
- サンドボックスは受け取った名前を `isInjectableEnvName` で再検証し（BFF を経由しない呼び出しへの防御）、`PI_SANDBOX_TOKEN` と master key の env を子プロセスから剥がす

### master key と保存時の暗号化

- 方式は AES-256-GCM。nonce は保存のたびに作り直し、認証タグは暗号文の末尾に付けて `ciphertext` の 1 つの BLOB として持つ。AAD は `u7agent-secret:<kind>:<name>` で、**cwd / スコープは含めない**（スコープの変更やコピーで復号をやり直さないため。名前と種別は変更できないので固定しても破綻しない）
- master key はアプリ DB と別経路から渡す。`U7AGENT_SECRET_MASTER_KEY`、または `U7AGENT_SECRET_MASTER_KEY_FILE` が指すファイル。書式は `<版>:<base64 の 32 バイト鍵>` をカンマ / 空白区切りで並べる（例 `1:...`）。複数の版を宣言でき、読み出しは行の `keyVersion` で選び、新しい保存は最大の版を使う（rotation の実装は別スコープで、形だけ用意する）
- master key 未設定 / 宣言が壊れている / 未知の鍵版 / 復号失敗 / 保存値の欠落では、シークレットの登録と利用を 503 で拒否する。既存の行を新規鍵で上書きしたり、行を消したりはしない（変数は平文なので影響しない）
- 保存時（BFF が値を受け取った直後）と起動時の復号時に、8 文字以上の値を `retainSecret()` で出力マスカーへ足す（削除・上書き後もプロセス生存中は外さない）。8 文字未満は登録せず、UI に「短い値は自動マスクされません」を出す（短い値を保護すると会話本文が軒並み `[REDACTED]` になるため）。**変数は登録しない**（エージェントに見えてよい値なので `NODE_ENV=production` などで誤爆する）

### 平文で残るもの

DB 全体が暗号化されるわけではない。暗号化されるのは今回のシークレットだけで、以下は従来どおり平文である。

- `provider_credentials.apiKey` / `content_settings.apiKey`（画像 / 音声で共有） / `web_search_provider_keys.apiKey`（[model-settings.md](model-settings.md#残存リスク)、[image-generation.md](image-generation.md#キーの扱い)、[web-search.md](web-search.md#設定既定-provider-と-apiキー)）
- `provider_memos.memo`（秘密情報として扱わない人間用メモ。マスカーへも登録しない）
- `secrets.plaintext`（種別 = 変数）と、変数の値が現れる API 応答（変更フォーム用の詳細）

### 保証範囲と残存リスク

保証するのは **「エージェントの env と作業フォルダに値そのものを置かない」** ところまで。

- シークレットはエージェントの `bash` の env に入らない（`printenv` / `env` では見えない）。ただし同一サンドボックス・同一 Unix user で動くため、サービスの `/proc/<pid>/environ` や ptrace の設定次第では読める可能性がある（`ptrace_scope` などホスト構成に依存し、未検証。Agent / App Runtime の分離は別 Issue）
- アプリのコードが値を HTTP 応答などへ出せば、エージェントは `curl` / `read` で読める。マスカーは文字列の完全一致と部分一致までで、エンコード・分割は防げない
- ランチャーは `.env` を読まない（現状維持）。パネルの値は実環境変数として起動プロセスへ渡す。アプリが `.env` を読むかはアプリ次第で、`dotenv` / `python-dotenv` / Node の `--env-file` は実 env を上書きしないのが既定だが、`override: true` や Vite のようにプレフィックス無しを `process.env` へ入れないスタックでは挙動が異なる。**同名が `.env` にあった場合の優先順位は保証しない**（衝突検知は別スコープ。値が見えないため逆転を検知できない）
- 8 文字未満のシークレットは自動マスクの対象外
- `pnpm dev` は master key をサンドボックスの子プロセスへ渡さない（BFF だけが受け取る。`bash` の子プロセスからはサンドボックス側でも剥がす）。デプロイ構成で同じことを保証するのは別スコープ
- 削除しても、既にサービスへ渡った値・外部サービスの資格情報は失効しない
- 管理 API の認証（既存の Origin 対策は認証ではない）、egress 制御、key rotation、外部 Secret Manager は別スコープ
