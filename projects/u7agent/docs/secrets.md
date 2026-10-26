# 秘密情報の扱い（出力マスクと作業フォルダの環境変数）

プロバイダーAPIキーを環境変数や 設定 → モデルの GUI（[model-settings.md](model-settings.md)）で BFF へ渡す運用でも、キーが LLM・ブラウザ・ログへ流れにくくする多層防御。ツール実行自体はサンドボックスへ分離済み（[sandbox.md](sandbox.md)）で、ここで述べるのは BFF 内での出力マスク（キーが作業領域のファイル等へ現れた場合の二次漏洩対策）と、SDK の公開 API だけで実装する縛り。

後半の[作業フォルダの環境変数](#作業フォルダの環境変数)（作業環境 → 環境変数）は、**保存時暗号化と実行時注入**で同じ目的を別の層から支える仕組み。同じ master key を使い、[アプリ DB の APIキー / Webhook URL](#アプリ-db-に保存する-apiキーと-webhook-url) も保存時に暗号化する。暗号化しないのは種別 = 変数の値と、人間用メモ（`provider_memos`）だけである（[平文で残るもの](#平文で残るもの)）。

## 保護対象

- `createRuntimeSecretMasker()`（`server/src/secret-guard.ts`）が `ModelRuntime.getProviders()` の各プロバイダーに対し pi-ai の公開ヘルパー `findEnvKeys()` で「設定済みのキー変数」を解決し、その非空値を保護対象にする。findEnvKeys が解決しない既知プロバイダーのキー変数（Bedrock の `AWS_BEARER_TOKEN_BEDROCK`）は補完テーブルで埋める。独自プロバイダー分は `PI_SECRET_ENV_VARS` で変数名を追加する
- 自動解決された値は 8 文字未満を通常出力の過剰改変防止のため対象外にする。`PI_SECRET_ENV_VARS` で明示指定された変数は運用者の意図なので長さに関係なく保護する。重複・包含する値は長い順に置換する
- 設定 → モデルで登録したキーは `createMutableSecretMasker` の `setSecrets` で保護対象へ足す。登録は **SDK / DB へ渡す前**に行い、起動時は DB から読めた全行（orphan・不正値・適用失敗を含む）を適用前に登録する。削除・上書き後も**プロセス生存中は保護対象から外さない**（`session.jsonl` の raw 入力を再投影しても旧キーを出さないため。入力は 8..2048 文字で、これより短いキーは GUI の対象外）
- 設定 → モデルのカスタムプロバイダーのAPIキーも、SDK / ログへ渡す前に `retainSecret()` で保護対象へ足す。ただし保存先は BFF のメモリだけで、プロセス生存中はマスクし、再起動すると消える。8 文字以上を必須にし、認証のないローカルサーバーにはダミーを使う（`Authorization: Bearer <キー>` として送られる。[model-settings.md](model-settings.md#カスタムプロバイダーオンメモリ)）
- コンテンツ生成のAPIキー（`content_settings`。画像・TTS・[BGM](bgm-generation.md) で共有）も同じ扱いで、`PUT /api/settings/content/key` がDBへ書く前に `retainSecret()` で登録し、起動時の `ContentSettingsService.applyStored()` も保存行のキーを登録する。provider呼出しはBFF内で完結し、キーはサンドボックスへ渡らない。BGMのproviderエラーもマスク後に長さを制限し、ツール定義は `wrapToolDefinitionWithSecretMasker()` を通す。
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
   - アシスタントの差分は `createStreamingSecretMasker` で配信前に「秘密値の前方一致になり得る末尾」を保留し、チャンク境界をまたぐキーが複数回の配信から復元できないようにする。保留分は `message_end`（アシスタント確定時）と `finish()`（完了・エラー・中断のいすれでも）で、**マスク済みの最終本文と突き合わせてから**配る。保留分を先に流すと秘密値の途中までが確定し、マスク済みの最終本文と先頭一致しなくなるため、突き合わせが先で、最終本文が続きを持つときは保留分を捨てる（最終本文が配信済みの本文と食い違うときだけ保留分を流す）

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
- `server/test/run-events-text.test.ts` / `server/test/sdk-steering.test.ts` — アシスタント本文の差分の届き方（全文 / 最終本文のみ / 秘密値の途中で停止）と停止時の確定。秘密値の途中で差分が止まっても live・payload・履歴 API の本文がマスク済みの全文で揃い、完全な値が出ないこと
- `server/test/model-settings.test.ts` / `server/test/model-settings-api.test.ts` — GUI 登録キーのマスカー登録順序、DB 例外にキーが載っても応答・health・ログに出ないこと
- `server/test/content-settings.test.ts` / `server/test/content-settings-api.test.ts` — 画像キーのマスカー登録順序（DB より前・起動時）、DB 例外にキーが載っても応答・health・ログに出ないこと、ローカル定義（`generate_image`）の throw のマスク（`server/test/image-tools.test.ts`）。`web_search` も切り詰めの前のマスクと throw のマスクを `server/test/web-search-tool.test.ts` で、Web 検索キーの登録順序（DB より前・起動時）と応答に値を載せないことを `server/test/web-search-settings.test.ts` / `server/test/web-search-settings-api.test.ts` で固定する
- `server/test/app-db.test.ts` — `sanitizeError` が `#query` のログ・`#error`・`open()` の失敗の両方に効くこと。secrets の加算移行、新しい schema での作り直しでも秘密が消えないこと、並びと値列の排他
- `server/test/secret-crypto.test.ts` — AEAD の往復、nonce を再利用しないこと、AAD 不一致 / 改ざん / 誤鍵 / 未知の鍵版の拒否、master key の書式と解決、アプリ DB 用 AAD（用途 / 所有者の取り違えと、環境変数シークレットとの相互復号の拒否）
- `server/test/app-secrets-api.test.ts` — master key 未設定 / 壊れた宣言でも起動し、DB 保存キーを使う機能だけが 503 / 未設定になり、env / auth.json の認証は使えること
- `server/test/secrets.test.ts` — 名前と値の規則、cwd スコープの照合 (他会話の `secret_id` は 404)、一覧が名前・種別・更新時刻だけを返すこと、世代、並べ替えの正規化と永続、起動 env の解決とマスカー登録 (8 文字未満は登録しない)
- `server/test/secrets-api.test.ts` — API の往復、シークレットの値がどの応答にも載らないこと、別 cwd の参照 / 変更 / 削除の拒否、並べ替えの保存と別 cwd の id の無視、master key 未設定の 503 `not_stored`
- `server/test/serve.test.ts` — 起動時の環境変数がコマンド文字列へ入らず exec の env として渡ること、`secretGeneration` が記録に載り値は載らないこと、解決失敗で起動しないこと
- `server/test/sandbox-service.test.ts` — 注入した env が bash の子プロセスへ入り、予約名 / 不正な名前は 400、master key は子プロセスへ漏れないこと
- `client/test/sessionEnv.test.ts` — 名前のプレビュー、種別ごとの文言、短い値の注記、追加フォームの送信可否、要求元 (sessionId / projectId) の解決、編集 / 変更の語、並べ替えの下書きの合成
- `client/test/envValue.test.ts` — 値が 2 行に収まるかの判定、開閉の文言、`<wbr>` を入れる分割位置
- `server/test/redact.test.ts` — `createMutableSecretMasker` の swap（追加・置換・失敗時の原子性）と、先に作った streaming masker が swap 後の値を保留幅に使うこと

## 残存リスク

- 分割・エンコードされたキーや未登録の秘密情報は検出できない。OAuth トークンは対象外
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれる。ファイル自体はマスクされない
- サンドボックス・作業領域側のリスクは [sandbox.md](sandbox.md) を参照する
- アプリ DB に保存した APIキー / Webhook URL は暗号文（AEAD）で残り、master key は DB に無い。ただし master key を持つ者・稼働中の BFF は復号できる。保存時暗号化は DB・WAL・バックアップの読み取りに対する防御で、実行環境の保護ではない。ログイン認証がないため BFF を LAN / インターネットへ公開しない（詳細は [model-settings.md](model-settings.md#残存リスク)）
- 削除・上書きした旧キーの保護は**プロセス生存中だけ**。再起動後はチャットへ貼り付けた生の入力が再投影で見えうる（tombstone は将来課題）
- ランタイム初期化に失敗したとき（`pi` が null）は可変マスカー自体が作られないため、この状態で起動したプロセスでは DB のキーを新たにマスク対象へ足せない。この場合も認証変更 API と画像キー登録 API は 503 で、キーは新規登録されない

## 作業フォルダの環境変数

作業フォルダ（cwd）単位で名前と値を登録し、サービス（serve）へ実行時だけ渡す。種別は 2 つ。

| 種別 | 保存 | 値が見える範囲 |
| --- | --- | --- |
| 変数 | 平文（`secrets.plaintext`） | エージェントの `bash`（exec ごとの env）と、サービス / デバッグ用 serve の起動時 env、アプリの画面（作業環境 → 環境変数） |
| シークレット | AEAD（`ciphertext` / `nonce` / `keyVersion`） | サービス / デバッグ用 serve の起動時 env だけ |

### 所有者とスコープ

- 所有者は会話ではなく **cwd**（`rootCwd` 相対）。`serve_commands` と同じキー空間で、「そのフォルダで動くサービスにはそのフォルダの env が入る」。プロジェクト所属は登録ディレクトリ、未所属は所属スペースのスクラッチ（既定スペースは `.u7agent/sessions/<id>`）なので、同じ作業フォルダを使う会話は自動的に共有する
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
- 一覧は名前・種別・更新時刻だけを返す。値を返す API は**変数**の詳細（`GET /api/secrets/:secretId`）だけで、シークレットの値は保存後にどの経路でも返らない。画面は一覧のあとに変数行の詳細だけを並列に引いて値を表示する（一覧 API の契約は変えない）
- 並びは `sortOrder`（追加は `MAX + 1`、削除で詰めない）→ 名前順。一覧のグリップで並べ替えられ、`PATCH /api/secrets/order` が渡された順に 1..n を振り直す（未知・重複・別 cwd の id は捨て、渡されなかった行は末尾）。並びは cwd ごとに保存され、値も世代も変えない（注入内容が同じなので、起動中のサービスに「再起動で反映」を出さない）

### 注入経路

- **変数**: エージェントの `bash` へ **exec ごとの env** として渡す（`SandboxExecuteRequestBody.env`）。変更はエージェントの次の `bash` から反映する
- **変数 + シークレット**: `serve` の起動時 env として渡す（`start` と、自分で確かめるための `debug_start` で同じ）。起動スクリプト（`launchScript`）のコマンド文字列へは埋め込まない（base64 化もしない）
- 起動時の解決は**起動元の作業フォルダ**から行い、解決に失敗したら起動しない（平文で保存し直す / 秘密なしで起動する、のどちらもしない）。既に動いているサービスは古い値のままなので、シークレットの変更は次回の起動から反映する
- `[REDACTED]` はマスクが効いた結果で、注入されたことの証明にはならない。マスカーは BFF の起動時に作業環境のシークレットを読み直さないため、値が返っても伏せられないことがある。注入の有無は、値を出さない存在確認（`bash` は変数の有無、起動プロセスは `process.env` のキーの有無）で切り分ける
- `ServeRecord.secretGeneration` に起動時に解決した世代（名前 → `secret_id` / 更新世代のハッシュ）を残し、`GET /api/secrets` の `generation` と比べると「再起動で反映される変更がある」と分かる。UI は一覧上部の凡例までで、行ごとの未反映バッジと再起動ボタンは次のフェーズ
- サンドボックスは受け取った名前を `isInjectableEnvName` で再検証し（BFF を経由しない呼び出しへの防御）、`PI_SANDBOX_TOKEN` と master key の env を子プロセスから剥がす

### master key と保存時の暗号化

- 方式は AES-256-GCM。nonce は保存のたびに作り直し、認証タグは暗号文の末尾に付けて `ciphertext` の 1 つの BLOB として持つ。AAD は `u7agent-secret:<kind>:<name>` で、**cwd / スコープは含めない**（スコープの変更やコピーで復号をやり直さないため。名前と種別は変更できないので固定しても破綻しない）
- master key はアプリ DB と別経路から渡す。`U7AGENT_SECRET_MASTER_KEY`、または `U7AGENT_SECRET_MASTER_KEY_FILE` が指すファイル。書式は `<版>:<base64 の 32 バイト鍵>` をカンマ / 空白区切りで並べる（例 `1:...`）。複数の版を宣言でき、読み出しは行の `keyVersion` で選び、新しい保存は最大の版を使う（rotation の実装は別スコープで、形だけ用意する）
- master key 未設定 / 宣言が壊れている / 未知の鍵版 / 復号失敗 / 保存値の欠落では、シークレットの登録と利用を 503 で拒否する。既存の行を新規鍵で上書きしたり、行を消したりはしない（変数は平文なので影響しない）
- 保存時（BFF が値を受け取った直後）と起動時の復号時に、8 文字以上の値を `retainSecret()` で出力マスカーへ足す（削除・上書き後もプロセス生存中は外さない）。8 文字未満は登録せず、UI に「短い値は自動マスクされません」を出す（短い値を保護すると会話本文が軒並み `[REDACTED]` になるため）。**変数は登録しない**（エージェントに見えてよい値なので `NODE_ENV=production` などで誤爆する）

### アプリ DB に保存する APIキーと Webhook URL

作業フォルダのシークレットと同じ鍵輪・同じ AES-256-GCM で、アプリ DB の秘密値も保存時に暗号化する。**新しい鍵体系は増やさない**（`U7AGENT_SECRET_MASTER_KEY` / `U7AGENT_SECRET_MASTER_KEY_FILE` の 1 つだけ）。

| 対象 | 列 | AAD の所有者 |
| --- | --- | --- |
| `provider_credentials`（設定 → モデル） | `ciphertext` / `nonce` / `keyVersion` | provider id |
| `content_settings`（設定 → コンテンツ生成。画像 / 音声 / BGM で共有） | 同上（3 列 NULL = キー未設定） | `apiKey` |
| `web_search_provider_keys`（設定 → Web 検索） | 同上 | provider id |
| `notification_settings`（Discord Webhook URL） | `webhookCiphertext` / `webhookNonce` / `webhookKeyVersion` | `webhookUrl` |

- AAD は `u7agent-app-secret:<scope>:<owner>` で、環境変数シークレットの `u7agent-secret:<kind>:<name>` とはラベルを分ける。用途（テーブル）と所有者を AAD に含めるため、別の用途・別の行へ差し替えた暗号文は復号できない
- nonce は保存のたびに作り直し、認証タグは暗号文の末尾に付ける。保存形式は `secrets` / `cloudflare_settings` と同じ
- 復号した値は、SDK / DB / ログへ渡す前に `retainSecret()` でマスカーへ登録する。GET は暗号文を復号しない（起動時と保存 / 置換 / 再同期のときだけ評価する）
- 復号の成否はプロセスのメモリだけに持ち、応答は `keyStored`（暗号文がある）/ `keyAvailable`（復号できて使える）/ `keyEvaluated`（復号を試したか）/ `keyErrorMessage`（サーバーの固定文言）で表す。`configured`（行の有無）だけで「キー登録済み」と読ませない
- master key 未設定 / 宣言が壊れているときは、アプリは起動し、DB 保存キーを使う機能だけを 503 / 未設定表示にする。`env` / `auth.json` のプロバイダー認証は影響を受けない。復号を試せない既知の失敗として `keyEvaluated: true` / `keyAvailable: false` / 「master key が未設定」固定文言を返す
- runtime（`pi`）が無い起動では復号しない。暗号文があっても `keyEvaluated: false` の未評価として返し、誤鍵・破損と断定しない。変更系は 503 にし、復号した値をメモリへ残さない
- キーの削除・クリアは復号が要らないため master key 無しでも通す。新規保存・置換・利用だけを master key に依存させる
- キーローテーション UI / 自動再暗号化は非ゴール。`keyVersion` の形だけ既存と同じく持つ
- **既存の平文キーは移行しない**。`APP_DB_SCHEMA_VERSION` 30 → 31 の移行で平文の列を落として値を破棄し、再入力で復旧する。dual-read・平文フォールバック・エクスポート・移行 UI は作らない（[persistence.md](persistence.md#アプリデータsqlite)）
- 移行は「平文の列があるか」で判定する（`user_version` だけで判定しない）。後続のスキーマ変更で移行が再実行されても、暗号化済みの値を消さない
- `content_settings` は旧 `apiKey` と一致・包含する `speechModel` / `speechVoice` を移行時に NULL にする（キー破棄後も応答へキーを出さないため）。保存時もキーと同じ値を音声の語彙へ入れさせない（値を伏せた 400）
- 暗号文を読むクエリは `AppDb.#secretQuery` を通し、SQLite のトリガーなどで例外文言へ値が写っても、ログ・health・503 へは「操作の分類だけ」を渡す（可変マスカーは暗号文の hex / base64 を守れない）

### 平文で残るもの

DB 全体が暗号化されるわけではない。暗号化されるのは環境変数のシークレットと上記の APIキー / Webhook URL だけで、以下は従来どおり平文である。

- カスタムプロバイダーのAPIキー（BFF のメモリのみ。DB・`models.json`・`auth.json` には残らない）
- `provider_memos.memo`（秘密情報として扱わない人間用メモ。マスカーへも登録しない）
- `secrets.plaintext`（種別 = 変数）と、変数の値が現れる詳細 API（`GET /api/secrets/:secretId`）と画面
- `models.json` / `auth.json` / `.env`（アプリ DB の外。SDK / デプロイ設定が持つ）
- セッションの `session.jsonl` / `meta.json`、`agents.systemPrompt`、`serve_commands.command`

### 保証範囲と残存リスク

保証するのは **「エージェントの env と作業フォルダに値そのものを置かない」** ところまで。

- シークレットはエージェントの `bash` の env に入らない（`printenv` / `env` では見えない）。ただし同一サンドボックス・同一 Unix user で動くため、サービスの `/proc/<pid>/environ` や ptrace の設定次第では読める可能性がある（`ptrace_scope` などホスト構成に依存し、未検証。Agent / App Runtime の分離は別 Issue）
- アプリのコードが値を HTTP 応答などへ出せば、エージェントは `curl` / `read` で読める。マスカーは文字列の完全一致と部分一致までで、エンコード・分割は防げない
- ランチャーは `.env` を読まない（現状維持）。パネルの値は実環境変数として起動プロセスへ渡す。アプリが `.env` を読むかはアプリ次第で、`dotenv` / `python-dotenv` / Node の `--env-file` は実 env を上書きしないのが既定だが、`override: true` や Vite のようにプレフィックス無しを `process.env` へ入れないスタックでは挙動が異なる。**同名が `.env` にあった場合の優先順位は保証しない**（衝突検知は別スコープ。値が見えないため逆転を検知できない）
- 8 文字未満のシークレットは自動マスクの対象外
- `pnpm dev` は master key をサンドボックスの子プロセスへ渡さない（BFF だけが受け取る。`bash` の子プロセスからはサンドボックス側でも剥がす）。デプロイ構成で同じことを保証するのは別スコープ
- 削除しても、既にサービスへ渡った値・外部サービスの資格情報は失効しない
- 管理 API の認証（既存の Origin 対策は認証ではない）、egress 制御、key rotation、外部 Secret Manager は別スコープ
