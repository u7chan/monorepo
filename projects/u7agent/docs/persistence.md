# データの永続化と再デプロイ時の挙動

何がどこに残り、再作成・再デプロイで何が消えるかの契約。保存の実装は `server/src/session-store.ts` と `server/src/app-db.ts`（テーブル定義と移行は `server/src/app-db-schema.ts`、ドメイン別の SQL は `server/src/shared-content-repository.ts` へ分けている）、セッション別の置き場は [session-files.md](session-files.md) を参照する。

## 現状

BFF とツール実行サンドボックスを別コンテナで動かす構成を対象とする。
サンドボックスの `/workspace` はホストの専用作業領域へ永続マウントし、
GUI の会話履歴は **BFF 専用の会話ストア**（`PI_SESSION_STORE`）へ JSONL で保存する。
会話と作業ディレクトリは同じセッション id で対応し、別の場所に置く。未所属チャットのスクラッチと添付は所属スペースの置き場（[session-files.md](session-files.md#スペースごとの配置)）を使い、プロジェクト所属セッションは登録ディレクトリそのものを使う（[projects.md](projects.md#セッション-cwd)）。

| データ | 再作成・再デプロイ後 |
|---|---|
| `/workspace` 内のファイル・Gitリポジトリ・worktree | 残る |
| 共通スキル（`<workspace>/.agents/skills`） | 残る |
| セッションの作業ディレクトリ（未所属チャットのスクラッチ。既定スペースは `<workspace>/.u7agent/sessions/<id>`） | 残る |
| プロジェクト所属セッションの作業ディレクトリ（登録ディレクトリそのもの） | 残る（登録したディレクトリが永続マウント配下なら） |
| プロジェクトスキル（`<project>/.agents/skills`） | 残る（登録したディレクトリが永続マウント配下なら） |
| 添付ファイル（既定スペースは `<workspace>/.u7agent/uploads/<id>`） | 残る |
| 会話履歴・セッション一覧・タイトル（`PI_SESSION_STORE/<id>/{meta.json,session.jsonl,sends.json}`） | 残る（ストアを永続ボリュームに置いた場合） |
| 応答メタの実測（アプリデータの SQLite、`assistant_metrics`） | 残る（ストアを永続ボリュームに置いた場合）。消えても JSONL の記録値から概算を再導出する（[api-sessions.md](api-sessions.md#get-apisessionsid)） |
| エージェント定義と定型プロンプトのマスタ（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合） |
| アーカイブの除外名（アプリデータの SQLite、上書きしたときだけ） | 残る（ストアを永続ボリュームに置いた場合） |
| 設定 → モデルで登録したプロバイダーAPIキー（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合。暗号化・[model-settings.md](model-settings.md)） |
| 設定 → モデルで保存したプロバイダーのメモ（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合。平文・[model-settings.md](model-settings.md#プロバイダーごとのメモ)） |
| 設定 → モデルのカスタムプロバイダー（定義とAPIキー。アプリデータの SQLite、`custom_providers`） | 残る（ストアを永続ボリュームに置いた場合。キーは暗号化・[model-settings.md](model-settings.md#カスタムプロバイダー)） |
| コンテンツ生成の provider / 画像モデル / 音声モデルとボイス / 共有APIキー（アプリデータの SQLite、`content_settings`） | 残る（キーは暗号化・選択は平文）。[BGM](bgm-generation.md) も同じキーを読み、専用列や移行は追加しない |
| コンテンツ生成の試行の履歴とキー世代（アプリデータの SQLite、`content_trials` / `content_key_epoch`） | 残る（ストアを永続ボリュームに置いた場合）。[image-generation.md](image-generation.md#設定画面) |
| 音声の応答形式の学習結果（アプリデータの SQLite、`speech_formats`） | 残る（ストアを永続ボリュームに置いた場合）。消えても形式違いの 400 の 1 往復が戻るだけで、[speech-generation.md](speech-generation.md#形式の選択と再試行) |
| コンテンツ生成の試行の成果物（`PI_SESSION_STORE/trials/<trialId>.<ext>`。画像は png / jpg / webp、音声は mp3 / wav、BGM は mp3） | 残る（ストアを永続ボリュームに置いた場合）。DB の行と同じ領域の兄弟で、時間ベースの自動削除はしない。容量は DB のバイト数を合計して出す |
| Web 検索の有効 / 無効と既定 provider（アプリデータの SQLite、`web_search_settings`） | 残る（ストアを永続ボリュームに置いた場合・[web-search.md](web-search.md#実行時トグル)） |
| 会話タイトルの AI 要約の設定（アプリデータの SQLite、`title_summary_settings`） | 残る（ストアを永続ボリュームに置いた場合・[session-title.md](session-title.md#設定)） |
| Git のグローバル identity（アプリデータの SQLite、`git_settings`） | 残る（ストアを永続ボリュームに置いた場合。サンドボックスへは次の bash から・[sandbox.md](sandbox.md#git-identity)） |
| Web 検索の provider ごとのAPIキー（アプリデータの SQLite、`web_search_provider_keys`） | 残る（ストアを永続ボリュームに置いた場合。暗号化・[web-search.md](web-search.md#設定既定-provider-と-apiキー)） |
| Discord の Webhook URL（アプリデータの SQLite、`notification_settings`） | 残る（ストアを永続ボリュームに置いた場合。暗号化・[notifications.md](notifications.md)） |
| OAuth サインインの資格情報（`<agentDir>/auth.json`） | 残る（agent dir を永続マウントした場合）。マウントしていなければ消え、サインインし直しが要る（[model-settings.md](model-settings.md#oauth-サインイン)） |
| モデル定義の上書き（`<agentDir>/models.json`。カスタム provider / モデルの定義） | 残る（agent dir を永続マウントした場合）。マウントしていなければ消える |
| モデルカタログのキャッシュ（`<agentDir>/models-store.json`。SDK が書く） | 残る（agent dir を永続マウントした場合）。マウントしていなければ同梱カタログへ戻る（[モデルカタログのキャッシュ](#モデルカタログのキャッシュsdk)） |
| OAuth サインインの agent host ID（`<agentDir>/u7agent/device-id`） | 残る（agent dir を永続マウントした場合）。マウントしていなければ消え、次のサインインで別の ID になる（BFF が書く Pi 側のファイル・[model-settings.md](model-settings.md#oauth-サインイン)） |
| アプリデータの DB（`PI_SESSION_STORE/u7agent.db`） | 残る（ストアを永続ボリュームに置いた場合） |
| 公開した静的コンテンツ（アプリデータの SQLite、`shared_contents`） | 残る（ストアを永続ボリュームに置いた場合）。Cloudflare 側の公開物は別に残る（[static-sharing.md](static-sharing.md)） |
| 共有物のサムネイル（`PI_SESSION_STORE/shared-thumbnails/<id>.<version>.png`） | 残る（ストアを永続ボリュームに置いた場合）。行はアプリデータの SQLite が持ち、実体は DB の兄弟に置く。会話の削除では消さず、共有物を削除したときだけ片付ける。バックアップには含まれない（[backup.md](backup.md)） |
| Cloudflare の資格情報（アプリデータの SQLite、`cloudflare_settings`） | 残る（ストアを永続ボリュームに置いた場合）。master key を失うと復号できず、トークンの再登録が要る |
| `/workspace` 以外に保存したデータ・後からインストールしたツール | 原則残らない |
| 実行中のプロセス | 中断される |
| プロジェクトの登録 | 残る（アプリデータの SQLite。所属は `projectCwd` から読み取り時に解決する） |

この表は永続マウントを設定したデプロイ環境での挙動を示す。
イメージ単体で起動するだけでは `/workspace` と会話ストアの永続化は保証されない。
単なるコンテナ停止・再開では書き込み層が残る場合があるが、再作成後の保持は保証しない。

BFF の agent dir（`PI_CODING_AGENT_DIR`。未設定なら `$HOME/.pi/agent`）はアプリが置き場所を決めず、永続マウントするかもデプロイ側の設定で決まる。マウントしていない構成では、表の agent dir 配下のファイルがコンテナの書き込み層に置かれ、再作成のたびに消える。

## スペース

スペースはデモ用の会話の表示区分であり、認証・権限・実行隔離ではない。共通設定、カタログ、API キー、ワークスペース全体のファイル、通知先、公開サービスの枠は共有する。追加スペースは会話専用で、プロジェクトは既定スペースだけで利用する。

- 既定スペースの予約 ID は `default`。旧会話の `meta.json` に `spaceId` が無い場合だけ既定として読む。不正な保存値は既定へ読み替えず、壊れた meta として一覧から除く。
- 追加スペースはアプリ DB の `spaces(id, name, createdAt, sortOrder)` に保存する。内部 ID は `space-` + 16 桁の hex、表示名とは独立して固定する。既定スペースは固定の選択肢でテーブルへ保存しない。v13 → v14 はテーブル追加だけの加算移行で、既存データを移動・削除しない。並びは `sortOrder` に保存し、一覧は `sortOrder` → `rowid` の順で返す。v21 → v22 は列追加だけの加算移行で、既存行の `sortOrder` は `NULL` のまま（同じ `NULL` 同士は `rowid` = 作成順で並ぶ）。並べ替えは 1 トランザクションで `sortOrder` を 1..n に振り直し、追加は `MAX + 1` で末尾に付く（エージェントと同じ。[api.md](api.md#スペース)）。
- 会話ログは従来の `<PI_SESSION_STORE>/<sessionId>/` のまま。追加スペースの所属は meta に保存し、live・未ロード・sweep 後・再起動後で保持する。JSONL の SDK 形式は変えない。
- 既定の作業先・添付は既存パスのまま。追加スペースの作業フォルダと添付は所属スペース配下（[session-files.md](session-files.md#スペースごとの配置)）。
- 未所属セッションは `POST /api/sessions/:id/move` で別のスペースへ引き継げる（プロジェクト所属は同じスペースへのエージェント交代だけ）。meta の `spaceId` とエージェントのスナップショットを書き換え、別スペースなら作業フォルダ / 添付を移動先のパスへ物理移動する（会話ログのフォルダは `<PI_SESSION_STORE>/<sessionId>/` のままで、履歴の `session.jsonl` / `sends.json` は破棄する。`secrets` / `serve_commands` は cwd をキーにするため移動先へ付け替える。[api-session-state.md](api-session-state.md#post-apisessionsidmove)）。
- 追加スペースは `DELETE /api/spaces/:id` で削除できる。会話（live / 未ロード）・履歴・作業フォルダ / 添付（`<workspace>/.u7agent/spaces/<spaceId>`）・`secrets` / `serve_commands` の cwd キー行・`spaces` 行を消し、`spaces` 行の削除を最後に置いて途中で失敗しても行が残るようにする（そのまま再試行できる）。既定スペースは対象外（400）。削除中はそのスペースを対象にする scoped API が読み取りも含めて 404 になる（[api.md](api.md#スペース)）。
- 切り替えは会話や実行中ランを消さない。改名は `spaces.name`（表示名）だけを変え、会話の所属・作業フォルダ・添付・`?space=` の値は変えない。リセットは設けず、削除だけができる。空のデモを始めるときは新しいスペースを作成する。

## 作業領域

作業領域は次の配置で扱う。ホスト側の実パスはデプロイ側が決める。

| 場所 | パス |
|---|---|
| サンドボックス内 | `/workspace` |
| ホスト上 | デプロイ側の永続ボリューム（サンドボックスの `/workspace` へマウントする） |
| 会話ストア（BFF 専用） | BFF コンテナの `PI_SESSION_STORE`（例 `/session-store`）。サンドボックスへはマウントしない |
| agent dir（BFF 専用） | BFF コンテナの `PI_CODING_AGENT_DIR`（未設定なら `$HOME/.pi/agent`）。OAuth の `auth.json` が入る。永続マウントするかはデプロイ側の設定 |

- BFF には作業領域をマウントしない。ファイル操作・シェル実行はサンドボックス側で行う。
- 会話ストアはサンドボックスと共有しない。共有すると、サンドボックスから symlink を差し替えて BFF のファイルを壊したり読み出したりできてしまう。`PI_SESSION_STORE` が `PI_APP_CWD` の中なら起動時に拒否する。
- agent dir もサンドボックスと共有しない。共有すると、ツール実行（`read` / `bash`）から OAuth の資格情報を読めてしまう。
- Gitリポジトリ本体と worktree は両方 `/workspace` 配下に配置する。外部パスへの参照先は永続化対象にならない。
- 後からインストールするツールも、保存先が `/workspace` 内ならそのファイルは残る。ただし外部の依存ファイル・設定まで復元されるとは限らない。
- 常用するツールはイメージへ組み込み、再作成後も利用できるようにする。
- 永続マウントはバックアップではない。作業ファイルの削除やホスト障害からの復旧は別途備える。
- サービスの稼働記録とログは作業領域の `.u7agent/serve/`（`state.json` / `app.log`、デバッグ用は `debug/<port>.log`）に置く。会話ストア（BFF 専用）へは置かない（BFF 再起動後の復元はサンドボックス経由で読む）。プロジェクトのディレクトリには作らない（[session-files.md](session-files.md#添付ファイルチャットからのアップロード)）。

配置・所有権・Compose の正本はデプロイ側で管理する。

- [Compose 定義](https://github.com/u7chan/self-hosted-runner/blob/main/deploy/u7agent.yml)
- [target 設定](https://github.com/u7chan/self-hosted-runner/blob/main/deploy/targets.json)
- [運用手順](https://github.com/u7chan/self-hosted-runner/blob/main/docs/u7agent.md)

分岐した会話は作業フォルダと添付を共有する（[session-files.md](session-files.md#共有する作業フォルダと添付)）。会話の削除はストアのフォルダだけを消して作業フォルダを残すため、片方を消してももう片方は開ける（分岐元は「削除済み」として表示する）。スペースの削除は根ごと消すので両方消える。共有中の会話の別スペースへの引き継ぎは 409 で断る（フォルダを運ぶと共有相手のパスが消えるため）。

## アプリデータ（SQLite）

プロジェクトの登録とエージェント定義は BFF の SQLite に保存する（`server/src/app-db.ts`）。
スキル定義は**ファイル（`.agents/skills`）を唯一の正**とし、DB へは保存しない（[スキルの扱い](#スキルの扱い)）。
会話は従来どおり `session.jsonl` のままで、DB には入れない。

- 置き場所は会話ストアと同じディレクトリの `PI_SESSION_STORE/u7agent.db`。新しい環境変数は増やさない。
- メモリ DB（`:memory:`）になるのは `sessionStoreDir: null` を明示したとき（テスト）だけ。パス解決に失敗したときは DB を使えない状態にし、メモリへは逃がさない。
- テーブル説明に残る「メンション」は旧 `notification_settings.mention` 列。既存 DB との互換性のため列は残すが、現行アプリは値を読まず、保存時は `none` に戻す。
- BGMも `content_settings` の共有キーを読み、追加のDB列・カタログ・移行は持たない。画像・TTS・BGMの最終的な公開条件は、この行によるコンテンツ生成ゲートとエージェントの `toolNames` の積（[bgm-generation.md](bgm-generation.md#キー公開ゲート設定)）。
- テーブルの一覧・列・`DROP_TABLES` の可否は `server/src/app-db-schema.ts` を正とし、テーブルごとの理由もその定義のコメントに置く。ここには、複数の module が同じ判断をするために要る契約だけを持つ。
- `assistant_metrics` は応答 1 件ごとの実測（`duration_ms` / `ttft_ms` / usage の各トークン数 / `cost_usd` / `stop_reason`）を `(session_id, assistant_id)` で持ち、`provider` / `model` / `at` でモデル別・期間別に絞れる。**正は JSONL で、このテーブルは派生データ**なので、JSONL を手で編集して `assistant_id` が引けなくなった応答には何も出さない（間違った値を出すよりは出さない）。保存するのは数値とモデル識別子だけで、本文・ツール引数・プロンプトは持たない（他のアプリデータと同じく平文・永続ボリューム）。**tok/s は列にせず**、`duration_ms` / `ttft_ms` / `output_tokens` から導出する（分母の定義を変えたときに再計算できるようにする）。NULL は「プロバイダが報告していない」で、0 と区別する（既存の `usage` の扱いと同じ）。集計（プロバイダ / モデルごとの生成速度の推移）はこのテーブルの実測だけを使い、SDK 記録値は使わない（[api-sessions.md](api-sessions.md#get-apisessionsid)）。**行の削除は履歴の削除に追随させる**（セッション削除・引き継ぎの片付け・`move`・履歴のクリアの 4 経路）が、best-effort で、DB の削除に失敗してもセッションの削除は成功させる（孤児行は残り得る。保持期限の掃除は非ゴール）。書き込みと読み取りは `#query` を通さない専用の入口を使い、失敗しても `appDb` の error を立てない（メタを保存できないことで health / アプリデータ API を 503 に巻き込まない）。そのとき会話は開け、メタが出ないだけになる。`provider_credentials` などのアプリ所有のテーブルと同じく未知の版を開いたときの `recreate(false)` では作り直すが、JSONL から引き直せる派生データなので `DROP_TABLES` に入れる（`secrets` とは逆）（[GET /api/sessions/:id](api-sessions.md#get-apisessionsid)）。
- `prompts` は定型プロンプトのマスタ、`agent_prompts` がエージェントからの順序付き参照（`agentId` / `promptId` / `position`）を持つ。`agent_prompts.agentId` は `ON DELETE CASCADE`（エージェント削除では参照だけが消え、マスタは残る）、`promptId` は `ON DELETE RESTRICT`（使用中の削除を DB でも止める）。`(agentId, promptId)` の一意制約と `position` の整数 1〜6 の CHECK（型まで検査し、REAL の 1.5 も拒否する）で、同じ ID の重複選択と上限超過を DB でも守る（API 側の 400 / 409 と二重に守るが、業務上の拒否は 503 に化けさせない）。接続で外部キーを有効にする。参照の保存・解除・並べ替えはエージェント本体と同じトランザクションで行う（途中失敗で部分適用を残さない）。
- NULL と「空」は別の値として保つ。エージェントのスキル / ツール許可リストは NULL（未指定 = 共通は全可視 / 組み込みは全部 ON / ツールは全部 ON）と `"[]"`（すべて OFF）を混同せず、`allowNaturalInvocationBuiltin` / `allowNaturalInvocationFile` の NULL（自然文でも発火する）と 0（発火しない）、`content_settings.imageParams` の NULL（既定なし）と `"{}"`（全モデルの既定を消した状態）、`provider_credentials.updatedAt` の NULL（保存日不明。v6 以前から残る行）も同じ（[api-catalog.md](api-catalog.md#エージェント定義のスキル許可リスト)、[image-generation.md](image-generation.md#画像パラメータの既定)、[model-settings.md](model-settings.md#キーの棚卸し最終保存と最終使用)）。
- 設定の行は**行が無い = 未設定**を既定の表し方にし、既定へ戻すときは行ごと消す（既定値を保存し直すと、以後コード側の既定を足しても追随しなくなる）。除外名（`archive_settings` / `shared_content_settings`）は行があればその一覧が正で、`[]` は「除外なし」。行が無いときの値は各設定を読む module が持つ。
- 並びはユーザーが並べ替える `agents` だけ `sortOrder`（追加は `MAX + 1`、削除で詰めない）で保ち、それ以外は作成順（rowid）で返す（[api-catalog.md](api-catalog.md#エージェントの表示順)）。
- 秘密を持つテーブル（`secrets` / `provider_credentials` / `web_search_provider_keys` / `cloudflare_settings` / `custom_providers` / `voice_input_settings`）と、行が消えると外部の状態を追えなくなる `shared_contents` / `shared_content_settings` は `DROP_TABLES` に入れない（未知の版を開いたときの `recreate(false)` でも消さない）。`secrets` は列追加だけの加算移行を恒久ルールとし、古いビルドへ戻したとき（`recreate`）は放置され、戻すと `CREATE TABLE IF NOT EXISTS` がそのまま合流する（秘密が消える移行を許さない。暗号化の書式は [secrets.md](secrets.md#作業フォルダの環境変数)）。
- `content_trials` の行は履歴そのもので、時間ベースの自動削除をせず `DROP_TABLES` にも入れない。`content_key_epoch` を別テーブルにするのは、キー削除で `content_settings` の行が消えても世代を残すため（世代が戻ると旧キーの実績が現在のキーの証拠に見えてしまう）。
- `content_settings` 1 行の積が `generate_image` / `generate_speech` / `generate_bgm` の公開ゲートになる（行の有無・`enabled`・キーが使えるかの積）。キー削除は行ごと消えるため、画像パラメータの既定も一緒に失われる。`image_settings` に生成元だけを分けるのは、その行が消えても生成元の選択を残すためで、OpenRouter のモデルは `content_settings.imageModel` を正のまま写さない（同じ値の正を 2 箇所に持たない）。
- `custom_providers` の読取は暗号文の有無だけを見て、定義の検証はサービス側の行単位の処理で行う（手編集された 1 行の不正値で一覧全体・他の行の復元・削除を止めない）。`hasKey` は暗号文から導出し、平文キーの列は持たない。
- `shared_contents` はサムネイルのメタだけを持ち、**行が「存在の正」、実体の PNG が「ファイル」**である。更新時刻は版として使い、解除しても消さない（戻すと同じ版・同じ配信 URL が再利用される）。実体の無い行は未設定として読み、起動時の再照合で行のメタを落とし、行の無いファイルは消す（表示や公開の操作は止めない）。
- `serve_commands` と `secrets` の `cwd` は root 相対の同じキー空間で、プロジェクトレコードへ従属させない（登録を解除しても `meta.projectCwd` は残るため）。
- `title_summary_settings` は Off に戻してもモデル・Effort・定義を消さない（本会話のモデルや compaction の要約とは別の行）。`git_settings` の初期 identity は、新規 DB と未設定の既存 DB にだけ入れ、`DELETE` した行を後の版の移行で復活させない。
- DB の例外文言は `AppDb.open({ sanitizeError })` を通してからログ・health・503 へ出す（bootstrap が可変マスカーを注入し、登録済みの API キーが例外へ現れても生のまま記録しない）。未指定は identity で、これはテストの明示 opt-out。
- `PRAGMA user_version` をコード側の定数（`APP_DB_SCHEMA_VERSION`）と照合する。古い版（小さい値）は加算的に移行し、足りないテーブルは `CREATE TABLE IF NOT EXISTS` で、足りない列は `PRAGMA table_info` で存在確認してから `ALTER TABLE ... ADD COLUMN` で足して `user_version` を更新する（既存のエージェント / プロジェクト / キーを消さない）。加算の更新は `CREATE TABLE IF NOT EXISTS` 群と同じトランザクション内で、途中失敗で列だけ残らない。v14 → v15 の改名だけは例外で、`ALTER TABLE ... RENAME` / `RENAME COLUMN` を `CREATE TABLE IF NOT EXISTS` **より先**に通す（先に CREATE すると空テーブルができて RENAME が失敗する）。`image_settings` と `content_settings` の両方があるときは `content_settings` を正として RENAME せず、v14 の `image_settings` の行は読まない（v42 以降の `image_settings` は生成元を持つ別のテーブルで、行が無ければ既定の OpenRouter）。新しい版（大きい値）のときだけアプリ所有のテーブルを DROP → CREATE する。会話は `session.jsonl` なので作り直しでも消えない。
- v22 → v23 で DB カタログ（`skills` テーブルと `agents.skillIds` 列）を**物理的に削除**する。削除は既存の加算更新を全部通した後に行い、`user_version` の更新まで同じトランザクションに入れる。存在確認付きなので再実行しても同じ結果になり、失敗したときは DROP・列変更・版更新のどれも残らない（加算分も rollback される）。復旧用の退避テーブル・書き出し・写し・移行 UI・旧テーブルの残置は作らず、旧カタログの本文を現在の実行に使う互換も作らない（[スキルの扱い](#スキルの扱い)）。
- **新しい DB を古いビルドで開く巻き戻しは非対応**。`AppDb.open()` はコードより大きい版を `recreate(false)` で作り直すため、ビルドを戻して同じ DB を開くと他のデータも消え得る。データを守る必要があるときは、一般のバックアップ運用と同じく DB ファイル（`u7agent.db`）を退避してから戻す。
- 自分で書いた JSON 列が壊れていたときは、黙って既定へ落とさず例外にして 503 側で見せる（通知の `lastResult` と同じ規約）。除外名も、行があるのに配列でなければ同じ扱いにする（設定 API は失敗を隠さず、プレビュー / 公開は既定へ落として警告を出す。[static-sharing-design.md](static-sharing-design.md#公開の除外)）。ただし `image_catalog` / `speech_catalog` / `content_cost_catalog` / `speech_formats` はキャッシュ・学習結果なので例外にせず、読めない行は未取得・未学習として読み、health も落とさない（破損を DB 全体の失敗として扱わない。次の取得成功が行を上書きして直る。[image-generation.md](image-generation.md#モデルカタログ) / [speech-generation.md](speech-generation.md#モデルカタログ)）。この「壊れた保存値」の失敗は `provider_credentials` のような別テーブルの読取成功や `probe()` の成功では消さず、同じテーブルを正しく読み直せたときだけ解除する（一過性の失敗とは別で、health の `appDb` が失敗を示し続ける）。
- エージェントのサンプル定義は持たない。新規 DB でもユーザー定義は空から始まる。組み込みの定型プロンプトも廃止し、旧版が残した行は起動時に消す。`user_version` 不一致の作り直しでも初期定義は入れないため、削除した定義は再起動でも戻らない。
- スキーマ作成 → `user_version` 設定 → seed は同一トランザクション。複数テーブルにまたがる更新（`moveCwd` など）もトランザクションで行い、途中で失敗したら部分適用を残さない。
- `journal_mode=WAL` / `synchronous=NORMAL`。書き込みは BFF の 1 プロセスを前提とし、複数インスタンスは対象外。

### 失敗時の扱い

会話ストアと同じ規約（メモリだけの黙ったフォールバックをしない）。

- 起動は継続し、`GET /api/health` の `appDb` に `{ path, ok, error }` を返す。
- アプリデータを読む API は 503 になる。カタログ（`/api/agents` / `/api/skills/session`）、プロジェクト（`/api/projects`）、セッションの作成・一覧・取得・設定変更・送信・SSE 接続（所属の解決と `create()` のカタログ参照を通るため）、設定のアーカイブ（`/api/settings/archive`）、設定のモデル（`/api/settings/models`）、コンテンツ生成の設定（`/api/settings/content`）、Web 検索の設定（`/api/settings/web-search`。provider ごとのキーを含む）、音声入力の設定（`/api/settings/voice-input`。キーの登録・削除・疎通確認）と Realtime 中継（`/api/voice-input/session`）、定型プロンプト（`/api/prompts`）、作業フォルダの環境変数（`/api/secrets`。cwd の解決と行の読み書きが要る）、サービスの状態（`/api/serve/status`。実績を読めないまま空の実績を見せない）。**変更系は 503 に `state: "not_stored"` を付け、何も保存していないことを示す**（モデル設定 / コンテンツ生成の設定 / Web 検索の設定（トグル・既定 provider・provider ごとのキーの登録・変更・削除） / 音声入力の設定（キーの登録・変更・削除） / 作業フォルダの環境変数の登録・変更・削除 / サービスの起動・停止 `/api/serve/start` `/api/serve/stop`）。
- 削除は会話ストアだけで完結するため通す。停止も live なセッションなら通る（未ロードのセッションは復元時に所属を解決するため、DB が使えないと 503 になる）。
- SSE は接続時に 503 で拒否し、配信中の payload 生成で失敗したらその接続を閉じる（未所属へ落として配信を続けない）。
- 起動時だけでなく稼働中の読み書き失敗も同じ扱いにする。失敗状態のときは入口ガードが `SELECT 1` で読み直し、成功すれば解除される（復旧に再起動は要らない）。

## モデルカタログのキャッシュ（SDK）

設定 → モデル（`/settings/models`）の [カタログ更新] が取得する pi.dev 由来のカタログは、pi SDK がエージェント設定ディレクトリ配下の `models-store.json`（BFF は置き場所を変える環境変数を設定しないため、既定は `$HOME/.pi/agent/models-store.json`）へ保存する。**アプリのデータではない**ので、アプリ DB には列も行も増やさない。

- 書くのは SDK だけ。BFF は SDK の取得 API を通して間接的に更新し、取得結果の永続化は SDK に任せる
- BFF のプロセス再起動では残り、起動時に overlay として読まれる（同梱カタログへの上書き）。コンテナを作り直したあと残るかは agent dir のマウント次第で、消えれば同梱カタログへ戻る
- 残っても消えてもアプリの起動・設定 API・会話は壊れない。カタログの恒久化（アプリ側の保存先を増やすこと）と、アプリが `PI_CODING_AGENT_DIR` を設定することは非ゴール（[model-settings.md](model-settings.md#モデルカタログの取得と更新)）
- このファイルを削除しても、GUI で登録したキー（アプリ DB）と `auth.json` は消えない

## 会話履歴の扱い

会話は BFF 専用ストアの `PI_SESSION_STORE/<id>/{meta.json,session.jsonl,sends.json}` に保存する。
`meta.json` は表示用メタデータ（タイトル / エージェントのスナップショット / 所属プロジェクトの cwd / 使用モデル / 会話ごとの通知トグル `notify`）を持ち、
`session.jsonl` は pi SDK 形式（header + entries、compaction entry を含む）で、読み書きは BFF の `session-store` が行う。
`sends.json` はまだ entry になっていない送信（未送信）を持つ BFF 専用の補助ファイルで、保存済み entry の run id は JSONL の entry に写した注記（`u7agentRunId`）が正（[session-files.md](session-files.md#sendsjson-と送信id--実行id-の注記)）。

- 起動時にストアを走査して一覧（descriptor）を復元し、セッションを開いたときに SDK セッションを遅延生成する。表示メッセージ数（`messageCount`）の定義を変えた場合は、古い値のままの meta を開いたときに書き戻すため、開いていないセッションの一覧は古い値を返し続ける（[session-files.md](session-files.md)）。
- アイドル 1 時間の sweep はメモリから外すだけで、ストアと作業ディレクトリ・添付は残る。SSE 購読中のセッションは対象外。
- `meta.json` はタイトルやスナップショットのほか、`pinned` / `notify` と、引き継ぎ・履歴クリアの任意フィールドを持つ。**引き継ぎの記録（操作 ID・時刻・メモの有無・消費済み）と `handoffCleanup`（確定後の履歴削除が未完了）は加算のみの任意フィールド**で、欠落は「引き継ぎなし / 片付け不要」として読み、新しく保存する meta にだけ載せる（旧 meta を書き換えない）。引き継ぎは**確定後にだけ**記録を書き、履歴削除に失敗したときは `handoffCleanup` を残す（次に開くときに削除から再試行する。[run-lifecycle.md](run-lifecycle.md#引き継ぎと復旧)）。
- **会話履歴のクリア**も同じ加算のみの形で、`historyGeneration`（クリアでだけ変わる履歴の世代。欠落 = 未クリア）と `historyCleanup`（確定後の旧履歴の削除が未完了）を meta にだけ書く。確定点はこの 2 つとチップの解除・タイトル / 試行・復元したモデル / Effort を同時に保存した時点で、書換え前の失敗は旧履歴を残す。確定後の削除に失敗したときは `historyCleanup` を残して開く要求を 409 にし、次に開いたときに削除から再試行する（[api-session-state.md](api-session-state.md#post-apisessionsidhistoryclear)、[session-files.md](session-files.md#ライフサイクルと排他)）。
- `DELETE /api/sessions/:id` はストアの履歴だけを消し、作業ディレクトリ（ユーザーのファイル）と添付は残す。
- タイトルは GUI の ⋯「名前を変更」（`PATCH /api/sessions/:id/title`）で更新でき、live / 未ロードのどちらでも `meta.json` を書き換える（未ロードでは SDK セッションを開かない。[api-session-state.md](api-session-state.md#patch-apisessionsidtitle)）。由来（`titleOrigin`）と AI 要約の試行（`titleAttempt`）も加算のみの任意フィールドで、欠落は「既存タイトル = 手動 / 未判定」として読む（既存の会話を自動で書き換えない。[session-title.md](session-title.md)）。`titleRequest` は会話メニューからの再要約に使う依頼本文の先頭（マスク済み・600 文字上限）で、初回送信時に保存する。既存 meta に無い場合は最初の user メッセージから作る。`titleAttempt` には失敗理由（マスク済み・300 文字上限）と `skipReason` / `durationMs` / `trigger` も加算で載り、古い値は欠落として読む。
- エージェント定義のプロファイル（`agent` の system prompt）は作成時に `promptSnapshot` として meta に保存し、復元後の実行内容を定義の変更に依存させない（定義の変更を遡及させない）。スキル本文は `promptSnapshot` に固定せず、ファイルスキル（`.agents/skills`）を復元のたびに再発見して、`read` と `/skill:` の展開がその時点のファイルを読む（[スキルの扱い](#スキルの扱い)）。カタログ撤去前の meta が持つ `agent.skillIds` / `agent.skills` / `promptSnapshot.skills` は読取境界で落とし、会話を開き直して再保存しても復活させない（[session-files.md](session-files.md#metajson)）。
- モデルは JSONL 最後の `model_change` → meta の `model` → アプリ既定 の順に、設定 → モデル の「利用可能なモデル」で絞った候補と照合する（[model-effort.md](model-effort.md)）。候補外ならアプリ既定へフォールバックし、その実効値を `model_change` へ追記して保存する（アプリ既定が未設定ならフォールバック先が無く、復元は 503 になる）。
- スキル読み込み（`read` で basename が `SKILL.md`）の表示は専用の保存フィールド / カラムを持たず、**pi entry の raw content（`toolCall` part と `toolResult`）を正として毎回再導出**する（`classifySkillRead()`。導出の契約は [api-sessions.md](api-sessions.md#スキル読み込みskillloads--skill)）。この再導出が成立するのは raw content を保存し続ける場合だけで、projected な `ChatMessage` の列（role / text / usage / metrics）だけを保存する設計にすると再導出できず、別途カラムが要る。現行の `session.jsonl`（SDK 形式）は raw content を保つため、BFF 再起動後に復元したセッションでも同じ位置に出る
- BFF 計測の時間（`messages[].metrics` の応答時間と `ToolCall.startedAt` / `endedAt` のツール実行時間）は JSONL へ保存しない。応答時間・TTFT・usage はアプリ DB の `assistant_metrics` へ写すため、再起動・アイドル sweep の後も**実測のまま**（`source` 省略 = `≈` 無し）で読み戻せる（[アプリデータ（SQLite）](#アプリデータsqlite)）。ただし SDK は assistant / toolResult の entry に `durationMs`（と toolResult の `toolCallId`）を残すため、応答時間と tok/s は再起動・アイドル sweep の後でも記録値から概算で再導出でき、`source: "recorded"` として `≈` 付きで表示する（[api-sessions.md](api-sessions.md#get-apisessionsid)）。ツール実行時間も同じ材料から再導出できるが、投影へはまだ配線していない（復元後は出ない）。ラン全体の所要時間と結末（user item の `runDurationMs` / `runOutcome` と、ターン最後の本文あり応答 item の `turnEnd`）と圧縮の所要時間（`CompactionInfo.durationMs`）は entry に残らず、復元後は載らない（[run-lifecycle.md](run-lifecycle.md#状態) / [compaction.md](compaction.md#表示仕様)）
- ストアのレイアウト・検証・書込み手順は [session-files.md](session-files.md) を正とする。
- プロジェクト（ワークスペース内ディレクトリの登録。`server/src/projects.ts`）はアプリデータの SQLite に保存し、
  再起動後も残る（DB を作り直したときは消える）。セッションは `projectCwd` を meta に持ち、
  復元時はそのディレクトリをそのまま cwd に使う（未登録でもスクラッチへは切り替えない）。
  同じ cwd を再登録すれば一覧の所属が再び解決される（プロジェクトの自動再登録はしない）。
  列は `{ id, name, cwd, createdAt }` の 4 つに保ち、cwd は root 相対で持つ（[projects.md](projects.md)）。

ブラウザのリロード・再接続は、BFF が保持している会話を再取得する動作であり、
DBへの永続化を意味しない。アイドルセッションの破棄条件などは
[run-lifecycle.md](run-lifecycle.md) を参照する。

### compaction entry の保存

`session.jsonl` は pi SDK 形式のまま保存するため、`messages` だけでなく **compaction entry も保存される**。
圧縮で context から外れた元メッセージも entry には残り、区切り位置（`firstKeptEntryId` 以降）も要約も復元できる。
DTO（[api-sessions.md](api-sessions.md) の `compactions`）はそのまま写した形で、
最新の compaction の `beforeMessageIndex` だけは `messages` から導出する。

- `reason` と `estimatedTokensAfter` は `CompactionEntry` には保存されず `compaction_end` にしか無いため、復元後は欠ける（表示は `tokensBefore` だけで成立する）
- `usage` / `fromHook` は entry に含まれるため復元できる。ただし SDK 型上 `usage` は optional で、旧 / 手作り JSONL に無い場合 `getContextUsage()` が例外になる。BFF はこの失敗を握って payload の `context` を省略し、セッションは開ける（Context ゲージは次の応答まで出ない）

### 全履歴の投影

GUI の全履歴（[compaction.md](compaction.md#全履歴の表示閲覧と段階読み込み)）も同じ entry 列から毎回投影する。
ページのカーソルは entry id で、ファイルを書き換えずに遡れる。**会話の二重保存・SQLite への履歴格納・ディスクのページ索引は追加しない**
（性能計測で必要になった場合の次段階とする）。`assistant_metrics` は履歴ではなく、応答ごとの数値メトリクスの派生データなので、この非ゴールには当たらない（[api-sessions.md](api-sessions.md#get-apisessionsid)）。

- 再起動後も `getBranch()` の entry から同じ item が同じ id で復元される（圧縮前の元メッセージ・過去の compaction イベントを含む）
- user item の `runId`（送信した run の id）は実行時の参照（SDK メッセージ → run id）から写し、保存した entry は JSONL の entry 自身へ写した注記（`u7agentRunId`。[session-files.md](session-files.md#sendsjson-と送信id--実行id-の注記)）で再起動後も保つ。クライアントはこの値で自分の送信エコーを他クライアントの同一文面 item と区別し、`run_start` やページ適用で正しい item へ吸収する。対応が無い旧保存データの item だけが、本文の正規形（+ 送信時点の位置 `since`）での縮退対象になる。202 で受理したがまだ entry になっていない送信は `sends.json` の `unsent` に残り、再起動後に「未送信」として配る（履歴の同一文面 item へ黙って吸収させない）
- `context_edit` で agent state から外れたメッセージも entry には残るため、`excluded` として読める（要約済みとは区別する）
- ページ取得は JSONL を読み直さずメモリ上の entry 列を走査する。表示文字列へ写すのは選んだページ範囲だけで、既存のマスカーを共有する

## バックアップの範囲

設定 → バックアップ（`/settings/backup`）が書き出すのは、ユーザー定義のエージェント・自作の定型プロンプト・共通スキルだけである。DB 全体のコピーではなく、定義だけを選んだ curated bundle で、会話（`session.jsonl` と会話ストア）・プロジェクト・ワークスペースのファイル・設定の行・API キー / OAuth の資格情報・共有コンテンツ・プロジェクト側スキル・組み込みの定義は含まない。復元も同じ範囲だけで、DB の他のテーブルには触らない。形式と契約は [backup.md](backup.md) を参照する。

## スキルの扱い

スキルは「ファイルスキル」「組み込みスキル」の 2 種類がある。

| 種類 | 置き場 | 編集 | 再デプロイ後 |
|---|---|---|---|
| ファイルスキル（共通） | `<workspace>/.agents/skills` | ファイル、または GUI（説明と本文だけ） | 残る |
| ファイルスキル（プロジェクト） | `<project>/.agents/skills` | ファイル | 残る（永続マウント配下なら） |
| 組み込み | アプリのバンドル `server/src/builtin-skills/`（仮想パス `<workspace>/.u7agent/builtin-skills/...`） | 不可 | イメージ更新で入れ替わる |

- **DB カタログ（GUI で登録するスキル定義と `agents.skillIds` の割り当て）は撤去済み**。データは v22 → v23 の移行で物理的に削除し、ファイルへの書き出し・旧 ID → name の対応表・割り当て変換・旧カタログの実行互換・専用のロールバックは作らない（[アプリデータ（SQLite）](#アプリデータsqlite)）。同名の現行ファイルがあれば普通のファイルスキルとして使える。
- 初期状態のユーザー定義エージェントは無い（セッションの既定はビルトインの `agent-general`）。利用者が作成した定義だけが保存され、再起動後も残る。
- ファイルスキルはセッション作成・復元のたびにサンドボックス（`GET /v1/skills`）で発見し、SDK の `skillsOverride` へ渡す。絞り込みの対象は共通分と組み込み分（組み込みの entry はサンドボックスに依らず registry から足す）で、エージェントの許可リスト（作成時に `meta.agent.commonSkillNames` / `meta.agent.builtinSkillNames` へ写す。自然文での発火も `meta.agent.allowNaturalInvocationBuiltin` / `allowNaturalInvocationFile` へ写し、`false` のときだけ載せる。旧 meta の `allowNaturalInvocation` はスコープごとに「新キー > 旧キー > 既定 `true`」の順で読み、新規 snapshot には書き戻さない。[api-catalog.md](api-catalog.md#自然文での発火)）を一意化の前に当てる。プロジェクト分は常時有効な **ambient** なスキルで、許可リストでは外せない。`promptSnapshot` には保存しない。セッションが持つのは発見一覧・説明・優先順位だけで、復元時は `meta.projectCwd` を起点に取り直す（プロジェクト登録が外れていても同じ）。
- 発見できるのは `SKILL.md` だけ。**本文は保存も固定もしない**ため、モデルが `read` した時点のファイル内容になる（作成後に編集すればその内容、削除すれば読取り失敗）。設定画面とチャットの一覧も同じで、ファイルを変えれば再読み込み後の表示に反映される。どのターンで `read` されたかは JSONL の `toolCall` から導出し、チャットの assistant バブルに `[skill]` バッジとして出す（上記の再導出）。
- 優先順位は `プロジェクト > 共通 > 組み込み`。同名は注入時に一意化し、影になったファイルはログと設定一覧の警告で、上書きされた組み込みは一覧の「上書きされています」で確認する（ファイルの改名・削除・マージはしない）。許可リストで外した組み込みは一意化に参加しないので、同名のファイルスキルがあればファイル側が単独で有効になる。
- 組み込みスキルはワークスペースに実体を作らず（`read` だけ BFF が同梱の本文を返す）、アプリの更新に追従して常に最新・改変不可。既定は全部 ON で、エージェント定義の `builtinSkillNames` で外すと、その会話の index / `read` / system prompt の案内からも消える（[api-catalog.md](api-catalog.md#組み込みスキル)）。
- チャット側の一覧（`GET /api/sessions/:id/skills`）と `/skill:` の展開は同じ解決（`プロジェクト > 共通 > 組み込み`）を共有する。一覧が固定するのは発見一覧・説明・優先順位だけで、**本文は送信時にスコープ別に取り直す**（ファイル → サンドボックスの preview、組み込み → registry）。
- GUI からの共通スキルの保存は、**元の SKILL.md の変更箇所だけを差し替える**（`server/src/sandbox/skill-edit.ts`。契約は [sandbox-api-skills.md](sandbox-api-skills.md#共通スキルの編集v1skillsfile)）。frontmatter の未知キー・コメント・キー順・`name`・`disable-model-invocation` などの見えないキー・BOM・未変更部分の改行と空白を保持し、同じ内容の再保存ではファイルを書き換えない（バイト列も mtime も変えない）。**変更した説明と新規の説明だけに** trim 後の非空と 1024 字以内を要求し、それ以外の値は SDK の診断に委ねる。安全に source range を差し替えられない frontmatter は理由付きで拒否し、全文を正規化して保存することはしない
- 競合は版（ファイルのバイト列の SHA-256 とフォルダ全体のダイジェスト）で検出し、不一致は 409 で止める。この版はアプリのデータではなくワークスペースのファイルの状態なので、**DB を戻してもスキルの内容は戻らない**。削除は専用フォルダごと（付随ファイルを含む）で、`treeVersion` の一致を確認してから実行する
- 保存経路は BFF の要求上限（64 KiB）の中だけを対象にする。大きなスキルは閲覧（2 MiB まで）だけができ、その場合も既存ファイルを切り詰めて保存しない
- 共通スキル置き場の外側の排他は GUI の CRUD・共通内へ解決する SDK `edit` / `write`・共通を変更する既存のファイル API だけが参加する。**任意の bash や外部エディタは参加しない**ため、直前の再確認で観測した変更は拒否するが、外部プロセスとの完全な CAS は保証しない
- BFF は作業領域をマウントしないため、ファイルスキルの発見にはサンドボックス（`PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN`）が必要。未設定ではセッション作成が 503 になり、設定の一覧も取得できない（発見だけが失敗した場合はスキル無しで続行する。組み込みはこのときも注入される）。

## 検証状況（2026-09-12時点）

実環境でサンドボックスの非root実行、`/workspace` への書き込み、
GUI経由のファイル作成・編集・シェル実行を確認済み。
再デプロイ後の作業ファイルの保持も確認済み。2026-09-11 に `/workspace` 内へ作った
検証用ファイルが、通常の再デプロイでコンテナを再作成した後（2026-09-12）も
内容ごと残っていたことを実機で確認した。
Git worktree は同じ永続マウント配下に置くため同様に残るが、worktree の `.git` は
絶対パスを参照するため、マウント先のパスを変えた場合は作り直す。
設定上の期待値と実機検証済みの範囲を混同しないこと。

検証用ファイルは `/workspace/.deploy-verify/` に置き、workspace 直下を検証物で埋めない。
再デプロイ前にテスト用ファイルをここへ作り、再デプロイ後に新しい会話または
サンドボックス内のコマンドで内容を確認する。会話履歴が消えることは失敗条件に含めない。
