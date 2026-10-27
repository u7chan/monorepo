# データの永続化と再デプロイ時の挙動

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
| エージェント / スキル定義（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合） |
| アーカイブの除外名（アプリデータの SQLite、上書きしたときだけ） | 残る（ストアを永続ボリュームに置いた場合） |
| 設定 → モデルで登録したプロバイダーAPIキー（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合。暗号化・[model-settings.md](model-settings.md)） |
| 設定 → モデルで保存したプロバイダーのメモ（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合。平文・[model-settings.md](model-settings.md#プロバイダーごとのメモ)） |
| 設定 → モデルのカスタムプロバイダー（定義とAPIキー。アプリデータの SQLite、`custom_providers`） | 残る（ストアを永続ボリュームに置いた場合。キーは暗号化・[model-settings.md](model-settings.md#カスタムプロバイダー)） |
| コンテンツ生成の provider / 画像モデル / 音声モデルとボイス / 共有APIキー（アプリデータの SQLite、`content_settings`） | 残る（キーは暗号化・選択は平文）。[BGM](bgm-generation.md) も同じキーを読み、専用列や移行は追加しない |
| Web 検索の有効 / 無効と既定 provider（アプリデータの SQLite、`web_search_settings`） | 残る（ストアを永続ボリュームに置いた場合・[web-search.md](web-search.md#実行時トグル)） |
| 会話タイトルの AI 要約の設定（アプリデータの SQLite、`title_summary_settings`） | 残る（ストアを永続ボリュームに置いた場合・[session-title.md](session-title.md#設定)） |
| Web 検索の provider ごとのAPIキー（アプリデータの SQLite、`web_search_provider_keys`） | 残る（ストアを永続ボリュームに置いた場合。暗号化・[web-search.md](web-search.md#設定既定-provider-と-apiキー)） |
| Discord の Webhook URL（アプリデータの SQLite、`notification_settings`） | 残る（ストアを永続ボリュームに置いた場合。暗号化・[notifications.md](notifications.md)） |
| OAuth サインインの資格情報（`<agentDir>/auth.json`） | 残る（agent dir を永続マウントした場合）。マウントしていなければ消え、サインインし直しが要る（[model-settings.md](model-settings.md#oauth-サインイン)） |
| モデル定義の上書き（`<agentDir>/models.json`。カスタム provider / モデルの定義） | 残る（agent dir を永続マウントした場合）。マウントしていなければ消える |
| モデルカタログのキャッシュ（`<agentDir>/models-store.json`。SDK が書く） | 残る（agent dir を永続マウントした場合）。マウントしていなければ同梱カタログへ戻る（[モデルカタログのキャッシュ](#モデルカタログのキャッシュsdk)） |
| OAuth サインインの agent host ID（`<agentDir>/u7agent/device-id`） | 残る（agent dir を永続マウントした場合）。マウントしていなければ消え、次のサインインで別の ID になる（BFF が書く Pi 側のファイル・[model-settings.md](model-settings.md#oauth-サインイン)） |
| アプリデータの DB（`PI_SESSION_STORE/u7agent.db`） | 残る（ストアを永続ボリュームに置いた場合） |
| 公開した静的コンテンツ（アプリデータの SQLite、`shared_contents`） | 残る（ストアを永続ボリュームに置いた場合）。Cloudflare 側の公開物は別に残る（[static-sharing.md](static-sharing.md)） |
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
- 未所属セッションは `POST /api/sessions/:id/move` で別のスペースへ引き継げる（プロジェクト所属は同じスペースへのエージェント交代だけ）。meta の `spaceId` とエージェントのスナップショットを書き換え、別スペースなら作業フォルダ / 添付を移動先のパスへ物理移動する（会話ログのフォルダは `<PI_SESSION_STORE>/<sessionId>/` のままで、履歴の `session.jsonl` / `sends.json` は破棄する。`secrets` / `serve_commands` は cwd をキーにするため移動先へ付け替える。[api-sessions.md](api-sessions.md#post-apisessionsidmove)）。
- 追加スペースは `DELETE /api/spaces/:id` で削除できる。会話（live / 未ロード）・履歴・作業フォルダ / 添付（`<workspace>/.u7agent/spaces/<spaceId>`）・`secrets` / `serve_commands` の cwd キー行・`spaces` 行を消し、`spaces` 行の削除を最後に置いて途中で失敗しても行が残るようにする（そのまま再試行できる）。既定スペースは対象外（400）。削除中はそのスペースを対象にする scoped API が読み取りも含めて 404 になる（[api.md](api.md#スペース)）。
- 切り替えは会話や実行中ランを消さない。改名・リセットは設けず、削除だけができる。空のデモを始めるときは新しいスペースを作成する。

## 作業領域

現在の self-hosted-runner 環境では以下を対応させている。

| 場所 | パス |
|---|---|
| サンドボックス内 | `/workspace` |
| ホスト上 | `/home/u7chan/deploy/u7agent/workspace` |
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

## アプリデータ（SQLite）

プロジェクトの登録とエージェント定義は BFF の SQLite に保存する（`server/src/app-db.ts`）。
スキル定義は**ファイル（`.agents/skills`）を唯一の正**とし、DB へは保存しない（[スキルの扱い](#スキルの扱い)）。
会話は従来どおり `session.jsonl` のままで、DB には入れない。

- 置き場所は会話ストアと同じディレクトリの `PI_SESSION_STORE/u7agent.db`。新しい環境変数は増やさない。
- メモリ DB（`:memory:`）になるのは `sessionStoreDir: null` を明示したとき（テスト）だけ。パス解決に失敗したときは DB を使えない状態にし、メモリへは逃がさない。
- テーブル説明に残る「メンション」は旧 `notification_settings.mention` 列。既存 DB との互換性のため列は残すが、現行アプリは値を読まず、保存時は `none` に戻す。
- BGMも `content_settings` の共有キーを読み、追加のDB列・カタログ・移行は持たない。画像・TTS・BGMの最終的な公開条件は、この行によるコンテンツ生成ゲートとエージェントの `toolNames` の積（[bgm-generation.md](bgm-generation.md#キー公開ゲート設定)）。
- テーブルの一覧は `server/src/app-db.ts` の `CREATE_TABLES` を正とする。`provider_credentials` は 設定 → モデルで登録したプロバイダー API キーを 1 行 1 プロバイダーで持ち、値は AEAD の暗号文（`ciphertext` / `nonce` / `keyVersion`。アクセス権の管理と残存リスクは [model-settings.md](model-settings.md)、方式は [secrets.md](secrets.md#アプリ-db-に保存する-apiキーと-webhook-url)）。`updatedAt` は保存のたびに更新する epoch ms で、v6 以前から残る行は NULL（保存日不明）のままにする（[model-settings.md](model-settings.md#キーの棚卸し最終保存と最終使用)）。`suggestions` / `commonSkillNames` / `builtinSkillNames` / `toolNames` / `model` / `excludeNames` は JSON 列。`agents.allowNaturalInvocation` は NULL（既定 = 自然文でも発火する）と 0（発火しない）を持つ整数列。並び順はテーブルごとに違い、**`projects` は作成順（rowid）のまま**で、**`agents` は表示順の `sortOrder`**（追加は `MAX + 1`、削除で詰めない）を使う。エージェントはユーザーが並べ替えるため、作成順ではなく保存した順で返す（既存行の `NULL` は作成順として読み、並べ替えで値が入る。[api-catalog.md](api-catalog.md#エージェントの表示順)）。`agents` のスキル / ツール許可リストの列は NULL（未指定 = 共通は全可視 / 組み込みは全部 ON / ツールは全部 ON）と `"[]"`（すべて OFF）を別の値として保つ。`notification_settings` は Discord 通知のグローバル設定（Webhook URL の暗号文 / 有効 / ベース URL / メンション / 直近結果）を 1 行だけ持ち、Webhook URL は API 応答へ出さない（[notifications.md](notifications.md)）。`archive_settings` はダウンロード ZIP の除外名（`excludeNames`）を 1 行だけ持ち、**行が無い = 未設定**（実効値は `DEFAULT_ARCHIVE_EXCLUDE_NAMES`）、行があればその一覧が正で `[]` は「除外なし」を表す（[file-preview.md](file-preview.md#ダウンロード)、[api.md](api.md#アーカイブの除外名)）。既定へ戻すときは行ごと消す（既定名を保存し直すと、以後 `DEFAULT_ARCHIVE_EXCLUDE_NAMES` を足しても追随しなくなる）。`model_settings` は 設定 → モデル の「利用可能なモデル」とアプリ既定モデルを 1 行だけ持ち、**行が無い = 未設定**（制限なし・既定なし）。`allowedModels` は JSON 配列で、NULL と空配列はどちらも制限なしを表し、両方が NULL になったら行ごと消す（[model-settings.md](model-settings.md#モデル候補選択とアプリ既定モデル)）。`provider_memos` は provider に紐づく人間用のメモを 1 行 1 プロバイダーで持ち、**行が無い = 未設定**。`provider_credentials` とは別テーブルにし、キーの登録有無（`managed`）とメモを混ぜない。空にして保存すると行ごと消し、手編集された空文字の行も未設定として読む（[model-settings.md](model-settings.md#プロバイダーごとのメモ)）。`content_settings` はコンテンツ生成の provider / 画像モデル（`imageModel`）/ 音声モデル（`speechModel`）/ ボイス（`speechVoice`）/ 有効 / 無効（`enabled`）/ APIキーの暗号文を 1 行だけ持ち、**行が無い = 未設定**（キー削除は行ごと消す）。暗号文の 3 列が NULL もキー未設定で、行の有無・`enabled`・キーが使えるかの積が `generate_image` / `generate_speech` / `generate_bgm` の公開ゲートになる（[image-generation.md](image-generation.md) / [speech-generation.md](speech-generation.md)）。音声の 2 列は v15 → v16 の加算移行で足した nullable 列で、NULL は既定モデルと「そのモデルが宣言する先頭ボイス」へフォールバックして読む（画面に「（未設定）」を出さない）。名前が `image_catalog`（画像専用の派生キャッシュ）と非対称なのは、キーと生成対象の選択を生成物の種類で増やさず 1 行共有するため。`image_catalog` は live カタログの**キャッシュ**を 1 行だけ持ち、**行が無い = 未取得**。`models` は `{ id, name, outputFormats? }` の JSON 配列で、provider は v1 では openrouter 固定なので保存しない。`outputFormats` は live が宣言する出力形式で、**任意フィールド**（無い行・形が違う行は「宣言なし」として読む。カラムは増やさないのでスキーマ移行は不要）。利用者データではなく派生データなので、読めない行（行が無い / 形が違う / JSON が壊れている）はすべて未取得として扱い、SDK 同梱カタログへ落ちる。**保存値の失敗としては記録せず、health も落とさない**（破損を DB 全体の失敗として扱わない。次の取得成功が行を上書きして直る）。`speech_catalog` は音声カタログの同じキャッシュで、テーブルの形は `image_catalog` と同型だが item の JSON は違う（`{ id, name, voices? }`）。行が無い / 読めない行は未取得として扱い、同梱の既定 1 件へ落ちる（[speech-generation.md](speech-generation.md#モデルカタログ)）。`web_search_settings` は `web_search` の有効 / 無効（`enabled`）と既定 provider（`provider`）を 1 行だけ持ち、**行が無い = 既定（有効 / exa）**。無効化のためのデプロイを不要にすることが目的の機能なので、既定は ON 側に倒す（[web-search.md](web-search.md#実行時トグル)）。`provider` は v12 → v13 の列追加で、既存行は既定 `exa` で埋まる。`web_search_provider_keys` は provider ごとの APIキーを 1 行 1 provider で持ち、**行が無い = キー未設定**（削除は行ごと消す）。キー付きの provider が増えても「どの provider のキーか」を行で表せるよう、`web_search_settings` の列にはしない。値は AEAD の暗号文（[web-search.md](web-search.md#設定既定-provider-と-apiキー)）。`title_summary_settings` は会話タイトルの AI 要約の On/Off・要約モデル（`provider/id`）・Effort（`thinkingLevel`）・定義を 1 行だけ持ち、**行が無い = 既定（Off / モデル未選択 / Effort 未指定 / 既定の定義）**。本会話のモデルや compaction の要約とは別の行で、Off に戻してもモデル・Effort・定義は消さない（[session-title.md](session-title.md#設定)）。`serve_commands` はサービスの起動に成功したコマンドを 1 行 1 作業ディレクトリ（`cwd` は root 相対）で持ち、**行が無い = 実績なし**。プロジェクトレコードに従属させず `cwd` をキーにする（プロジェクト登録を解除しても `meta.projectCwd` は残るため）。稼働記録（サンドボックスの `.u7agent/serve/state.json`）とは別物で、プロセスが消えても残り、同じ作業ディレクトリの他会話でも使える（[sandbox.md](sandbox.md#serveサービスの公開と起動停止)）。`secrets` は作業フォルダ（`cwd` は root 相対で `serve_commands` と同じキー空間）単位の環境変数を持ち、`kind='variable'` は `plaintext`、`kind='secret'` は `ciphertext` / `nonce` / `keyVersion` を使う（列は種別ごとに排他）。`UNIQUE (cwd, name)` で名前は cwd 内で一意、`sortOrder`（追加は `MAX + 1`、削除で詰めない、並べ替えは 1 トランザクションで 1..n に振り直す）で並ぶ。**このテーブルは列追加だけの加算移行を恒久ルール**とし、`DROP_TABLES` に入れない: 古いビルドへ戻したとき（`#recreate`）はこのテーブルを知らないので放置され、新ビルドへ戻すと #migrate() の `CREATE TABLE IF NOT EXISTS` がそのまま合流させる（秘密が消える移行を許さない。暗号化の書式は [secrets.md](secrets.md#作業フォルダの環境変数)）。`shared_contents` は Cloudflare へ公開した静的成果物を 1 行 1 共有物で持ち、`provider` / `providerAccount` / `remoteId` / `publicUrl` / `status` / `sourceKind` を記録する（`sourceKind` は公開元の種類で、`session-root` = セッションの作業フォルダ自身、`directory` = その配下のディレクトリ。既存行と省略時は `directory`）。**このテーブルも列追加だけの加算移行を恒久ルール**とし、`DROP_TABLES` に入れない: 行が消えると provider 側に公開物が残ったまま追跡・停止・削除できなくなる。セッションを削除しても行は残し、作業フォルダが消えたときは更新だけを拒否する（[static-sharing.md](static-sharing.md)）。`cloudflare_settings` は Cloudflare のアカウント ID と API トークン（`ciphertext` / `nonce` / `keyVersion`）を 1 行だけ持ち、**行が無い = 未登録**。トークンは `secrets` と同じ方式で暗号化し、このテーブルも `DROP_TABLES` に入れない。`shared_content_settings` は共有（Cloudflare への公開）の除外名（`excludeNames`）を 1 行だけ持ち、**行が無い = 未設定**（実効値は `DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES`）。`archive_settings` と同じく `[]` は「除外なし」で、既定へ戻すときは行ごと消す（[static-sharing.md](static-sharing.md#公開の除外)）。**このテーブルも `DROP_TABLES` に入れない**: 行が消えると利用者の除外が既定へ戻り、次の更新で公開範囲が意図せず変わる。壊れた JSON（配列でない値）は黙って既定へ落とさず 503 にする（設定 API が失敗を隠さない。プレビュー / 公開は既定へ落として警告を出す）。
- `custom_providers` は 設定 → モデルで作ったカスタムプロバイダーの定義（`name` / `baseUrl` / `modelId` / `contextWindow` / `maxTokens`）とAPIキーの暗号文を 1 行 1 provider で持ち、**行が無い = 未登録**。AAD の所有者は provider id（`u7agent-app-secret:custom_providers:<provider>`、[secrets.md](secrets.md#アプリ-db-に保存する-apiキーと-webhook-url)）。並びは追加順（rowid）で、`hasKey` は暗号文の有無から導出する（平文キーと有無の列は持たない）。行の読取は構造（暗号文の有無）だけを見て、定義の検証はサービス側の行単位の処理で行う（手編集された 1 行の不正値で一覧全体・他の行の復元・削除を止めない）。`provider_credentials` と同じアプリ所有のテーブルなので、未知の版を開いたときの `#recreate(false)` では他のアプリデータと一緒に作り直す。旧バージョンのオンメモリ定義は引き継がない（移行 UI は作らない。[model-settings.md](model-settings.md#カスタムプロバイダー)）
- `provider_credentials` は v3 → v4、`model_settings` は v4 → v5、`provider_memos` は v5 → v6、`provider_credentials.updatedAt` は v6 → v7、`image_settings` は v7 → v8、`image_catalog` は v8 → v9、`serve_commands` は v9 → v10、`secrets` は v10 → v11、`web_search_settings` は v11 → v12、`web_search_settings.provider` と `web_search_provider_keys` は v12 → v13 の加算移行で足した。`image_settings` → `content_settings` と `model` → `imageModel` は v14 → v15 の移行で改名した。`content_settings` の音声の 2 列と `speech_catalog` は v15 → v16 の加算移行で足した。`agents.commonSkillNames` は v16 → v17、`agents.builtinSkillNames` は v17 → v18、`agents.toolNames` は v18 → v19 の加算移行で足した。`agents.sortOrder` は v20 → v21 の加算移行で足し、既存行は `NULL`（= 作成順）のままで、以後の追加は末尾に付く。`shared_contents` と `cloudflare_settings` は v23 → v24、`title_summary_settings` は v24 → v25 の加算移行で足した。`content_settings.enabled` は v25 → v26、`shared_content_settings` は v26 → v27、`shared_contents.sourceKind` は v27 → v28、`title_summary_settings.thinkingLevel` は v28 → v29 の加算移行で足した（既存行は NULL = Effort 未指定）。`agents.allowNaturalInvocation` は v29 → v30 の加算移行で足した（既存行は NULL = 発火する）。v30 → v31 は**破壊的な移行**で、`provider_credentials` と `web_search_provider_keys` を平文の `apiKey` 列があるときだけキー専用テーブルへ作り直し（既存行は破棄）、`content_settings` と `notification_settings` は平文の `apiKey` / `webhookUrl` 列を落として暗号文の列を足す。既存の平文キー / Webhook URL は失われ、再入力が必要。`content_settings` の `provider` / `imageModel` / `speechModel` / `speechVoice` / `enabled`（旧キーを含む音声値だけは NULL にクリア）と、`notification_settings` の `enabled` / `askUser` / `baseUrl` / `lastResult` は残す。判定は `user_version` ではなく**平文列の有無**で行い、後続の版で移行が再実行されても暗号化済みの行を消さない。保存は主キー `provider` の upsert（単一ステートメント）で、成功して返れば行は確定している。この性質を認証変更 API の `applied` / `not_stored` の判定に使う（[model-settings.md](model-settings.md#応答契約)）。`content_settings` は id = 1 の upsert で、成功して返れば行は確定している（[image-generation.md](image-generation.md#api)）。v31 → v32 は `custom_providers` を足すだけの加算移行で、既存のアプリデータを消さない。
- DB の例外文言は `AppDb.open({ sanitizeError })` を通してからログ・health・503 へ出す（bootstrap が可変マスカーを注入し、登録済みの API キーが例外へ現れても生のまま記録しない）。未指定は identity で、これはテストの明示 opt-out。
- `PRAGMA user_version` をコード側の定数（`APP_DB_SCHEMA_VERSION`）と照合する。古い版（小さい値）は加算的に移行し、足りないテーブルは `CREATE TABLE IF NOT EXISTS` で、足りない列は `PRAGMA table_info` で存在確認してから `ALTER TABLE ... ADD COLUMN` で足して `user_version` を更新する（既存のエージェント / プロジェクト / キーを消さない）。加算の更新は `CREATE TABLE IF NOT EXISTS` 群と同じトランザクション内で、途中失敗で列だけ残らない。v14 → v15 の改名だけは例外で、`ALTER TABLE ... RENAME` / `RENAME COLUMN` を `CREATE TABLE IF NOT EXISTS` **より先**に通す（先に CREATE すると空テーブルができて RENAME が失敗する）。`image_settings` と `content_settings` の両方があるときは `content_settings` を正として RENAME せず、`image_settings` の行は読まない。新しい版（大きい値）のときだけアプリ所有のテーブルを DROP → CREATE する。会話は `session.jsonl` なので作り直しでも消えない。
- v22 → v23 で DB カタログ（`skills` テーブルと `agents.skillIds` 列）を**物理的に削除**する。削除は既存の加算更新を全部通した後に行い、`user_version` の更新まで同じトランザクションに入れる。存在確認付きなので再実行しても同じ結果になり、失敗したときは DROP・列変更・版更新のどれも残らない（加算分も rollback される）。復旧用の退避テーブル・書き出し・写し・移行 UI・旧テーブルの残置は作らず、旧カタログの本文を現在の実行に使う互換も作らない（[スキルの扱い](#スキルの扱い)）。
- **新しい DB を古いビルドで開く巻き戻しは非対応**。`AppDb.open()` はコードより大きい版を `#recreate(false)` で作り直すため、ビルドを戻して同じ DB を開くと他のデータも消え得る。データを守る必要があるときは、一般のバックアップ運用と同じく DB ファイル（`u7agent.db`）を退避してから戻す。
- 自分で書いた JSON 列が壊れていたときは、黙って既定へ落とさず例外にして 503 側で見せる（通知の `lastResult` と同じ規約）。アーカイブの除外名も、行があるのに配列でなければ同じ扱いにする。ただし `image_catalog` と `speech_catalog` はキャッシュなので例外にせず、読めない行は未取得として読む（[image-generation.md](image-generation.md#モデルカタログ) / [speech-generation.md](speech-generation.md#モデルカタログ)）。この「壊れた保存値」の失敗は `provider_credentials` のような別テーブルの読取成功や `probe()` の成功では消さず、同じテーブルを正しく読み直せたときだけ解除する（一過性の失敗とは別で、health の `appDb` が失敗を示し続ける）。
- サンプル定義（ずんだもん 1 体）は DB ファイルを新規作成したときだけ入れる。`user_version` 不一致の作り直しでは入れないため、削除した定義は再起動でも戻らない。
- スキーマ作成 → `user_version` 設定 → seed は同一トランザクション。複数テーブルにまたがる更新（`moveCwd` など）もトランザクションで行い、途中で失敗したら部分適用を残さない。
- `journal_mode=WAL` / `synchronous=NORMAL`。書き込みは BFF の 1 プロセスを前提とし、複数インスタンスは対象外。

### 失敗時の扱い

会話ストアと同じ規約（メモリだけの黙ったフォールバックをしない）。

- 起動は継続し、`GET /api/health` の `appDb` に `{ path, ok, error }` を返す。
- アプリデータを読む API は 503 になる。カタログ（`/api/agents` / `/api/skills/session`）、プロジェクト（`/api/projects`）、セッションの作成・一覧・取得・設定変更・送信・SSE 接続（所属の解決と `create()` のカタログ参照を通るため）、設定のアーカイブ（`/api/settings/archive`）、設定のモデル（`/api/settings/models`）、コンテンツ生成の設定（`/api/settings/content`）、Web 検索の設定（`/api/settings/web-search`。provider ごとのキーを含む）、作業フォルダの環境変数（`/api/secrets`。cwd の解決と行の読み書きが要る）、サービスの状態（`/api/serve/status`。実績を読めないまま空の実績を見せない）。**変更系は 503 に `state: "not_stored"` を付け、何も保存していないことを示す**（モデル設定 / コンテンツ生成の設定 / Web 検索の設定（トグル・既定 provider・provider ごとのキーの登録・変更・削除） / 作業フォルダの環境変数の登録・変更・削除 / サービスの起動・停止 `/api/serve/start` `/api/serve/stop`）。
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
- `meta.json` はタイトルやスナップショットのほか、`pinned` / `notify` と、引き継ぎの任意フィールドを持つ。**引き継ぎの記録（操作 ID・時刻・メモの有無・消費済み）と `handoffCleanup`（確定後の履歴削除が未完了）は加算のみの任意フィールド**で、欠落は「引き継ぎなし / 片付け不要」として読み、新しく保存する meta にだけ載せる（旧 meta を書き換えない）。引き継ぎは**確定後にだけ**記録を書き、履歴削除に失敗したときは `handoffCleanup` を残す（次に開くときに削除から再試行する。[run-lifecycle.md](run-lifecycle.md#引き継ぎと復旧)）。
- `DELETE /api/sessions/:id` はストアの履歴だけを消し、作業ディレクトリ（ユーザーのファイル）と添付は残す。
- タイトルは GUI の ⋯「名前を変更」（`PATCH /api/sessions/:id/title`）で更新でき、live / 未ロードのどちらでも `meta.json` を書き換える（未ロードでは SDK セッションを開かない。[api-sessions.md](api-sessions.md#patch-apisessionsidtitle)）。由来（`titleOrigin`）と AI 要約の試行（`titleAttempt`）も加算のみの任意フィールドで、欠落は「既存タイトル = 手動 / 未判定」として読む（既存の会話を自動で書き換えない。[session-title.md](session-title.md)）。`titleRequest` は会話メニューからの再要約に使う依頼本文の先頭（マスク済み・600 文字上限）で、初回送信時に保存する。既存 meta に無い場合は最初の user メッセージから作る。`titleAttempt` には失敗理由（マスク済み・300 文字上限）と `skipReason` / `durationMs` / `trigger` も加算で載り、古い値は欠落として読む。
- エージェント定義のプロファイル（`agent` の system prompt）は作成時に `promptSnapshot` として meta に保存し、復元後の実行内容を定義の変更に依存させない（現行の「定義変更を遡及させない」と同じ）。スキル本文は `promptSnapshot` に固定せず、ファイルスキル（`.agents/skills`）を復元のたびに再発見して、`read` と `/skill:` の展開がその時点のファイルを読む（[スキルの扱い](#スキルの扱い)）。カタログ撤去前の meta が持つ `agent.skillIds` / `agent.skills` / `promptSnapshot.skills` は読取境界で落とし、会話を開き直して再保存しても復活させない（[session-files.md](session-files.md#metajson)）。
- モデルは JSONL 最後の `model_change` → meta の `model` → アプリ既定 の順に、設定 → モデル の「利用可能なモデル」で絞った候補と照合する（[model-effort.md](model-effort.md)）。候補外ならアプリ既定へフォールバックし、その実効値を `model_change` へ追記して保存する（アプリ既定が未設定ならフォールバック先が無く、復元は 503 になる）。
- スキル読み込み（`read` で basename が `SKILL.md`）の表示は専用の保存フィールド / カラムを持たず、**pi entry の raw content（`toolCall` part と `toolResult`）を正として毎回再導出**する（`classifySkillRead()`。導出の契約は [api-sessions.md](api-sessions.md#スキル読み込みskillloads--skill)）。この再導出が成立するのは raw content を保存し続ける場合だけで、projected な `ChatMessage` の列（role / text / usage / metrics）だけを保存する設計にすると再導出できず、別途カラムが要る。現行の `session.jsonl`（SDK 形式）は raw content を保つため、BFF 再起動後に復元したセッションでも同じ位置に出る
- BFF 計測の時間（`messages[].metrics` の応答時間と `ToolCall.startedAt` / `endedAt` のツール実行時間）は JSONL へ保存しない。SDK の entry は応答の完了時刻もツール実行の開始時刻も持たず、同じ assistant メッセージの複数ツールを `toolResult` の `timestamp` から区別できないためだ。再起動とアイドル sweep のあとに開き直したセッションでは、ツール履歴の実行時間が出ない（表示は欠けた値を出さないだけで壊れない）。同じ理由で、ラン全体の所要時間と結末（user item の `runDurationMs` / `runOutcome` と、ターン最後の本文あり応答 item の `turnEnd`）と圧縮の所要時間（`CompactionInfo.durationMs`）も保存せず、復元後は載らない（[run-lifecycle.md](run-lifecycle.md#状態) / [compaction.md](compaction.md#表示仕様)）
- ストアのレイアウト・検証・書込み手順の設計は [session-files.md](session-files.md) を正とする。
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
（性能計測で必要になった場合の次段階とする）。

- 再起動後も `getBranch()` の entry から同じ item が同じ id で復元される（圧縮前の元メッセージ・過去の compaction イベントを含む）
- user item の `runId`（送信した run の id）は実行時の参照（SDK メッセージ → run id）から写し、保存した entry は JSONL の entry 自身へ写した注記（`u7agentRunId`。[session-files.md](session-files.md#sendsjson-と送信id--実行id-の注記)）で再起動後も保つ。クライアントはこの値で自分の送信エコーを他クライアントの同一文面 item と区別し、`run_start` やページ適用で正しい item へ吸収する。対応が無い旧保存データの item だけが、本文の正規形（+ 送信時点の位置 `since`）での縮退対象になる。202 で受理したがまだ entry になっていない送信は `sends.json` の `unsent` に残り、再起動後に「未送信」として配る（履歴の同一文面 item へ黙って吸収させない）
- `context_edit` で agent state から外れたメッセージも entry には残るため、`excluded` として読める（要約済みとは区別する）
- ページ取得は JSONL を読み直さずメモリ上の entry 列を走査する。表示文字列へ写すのは選んだページ範囲だけで、既存のマスカーを共有する

## スキルの扱い

スキルは「ファイルスキル」「組み込みスキル」の 2 種類がある。

| 種類 | 置き場 | 編集 | 再デプロイ後 |
|---|---|---|---|
| ファイルスキル（共通） | `<workspace>/.agents/skills` | ファイル、または GUI（説明と本文だけ） | 残る |
| ファイルスキル（プロジェクト） | `<project>/.agents/skills` | ファイル | 残る（永続マウント配下なら） |
| 組み込み | アプリのバンドル `server/src/builtin-skills/`（仮想パス `<workspace>/.u7agent/builtin-skills/...`） | 不可 | イメージ更新で入れ替わる |

- **DB カタログ（GUI で登録するスキル定義と `agents.skillIds` の割り当て）は撤去済み**。データは v22 → v23 の移行で物理的に削除し、ファイルへの書き出し・旧 ID → name の対応表・割り当て変換・旧カタログの実行互換・専用のロールバックは作らない（[アプリデータ（SQLite）](#アプリデータsqlite)）。同名の現行ファイルがあれば普通のファイルスキルとして使える。
- 初期状態のユーザー定義エージェントはずんだもん `agent-zundamon` 1 体（`systemPrompt` に語尾の指示）。通常の定義と同じ扱いで削除できる。サンプルは DB を新規作成したときだけ入るため、削除した定義は再起動でも戻らない。
- ファイルスキルはセッション作成・復元のたびにサンドボックス（`GET /v1/skills`）で発見し、SDK の `skillsOverride` へ渡す。絞り込みの対象は共通分と組み込み分（組み込みの entry はサンドボックスに依らず registry から足す）で、エージェントの許可リスト（作成時に `meta.agent.commonSkillNames` / `meta.agent.builtinSkillNames` へ写す。自然文での発火も `meta.agent.allowNaturalInvocation` へ写し、`false` のときだけ載せる。[api-catalog.md](api-catalog.md#エージェント定義のスキル許可リスト)）を一意化の前に当てる。プロジェクト分は常時有効な **ambient** なスキルで、許可リストでは外せない。`promptSnapshot` には保存しない。セッションが持つのは発見一覧・説明・優先順位だけで、復元時は `meta.projectCwd` を起点に取り直す（プロジェクト登録が外れていても同じ）。
- 発見できるのは `SKILL.md` だけ。**本文は保存も固定もしない**ため、モデルが `read` した時点のファイル内容になる（作成後に編集すればその内容、削除すれば読取り失敗）。設定画面とチャットの一覧も同じで、ファイルを変えれば再読み込み後の表示に反映される。どのターンで `read` されたかは JSONL の `toolCall` から導出し、チャットの assistant バブルに `[skill]` バッジとして出す（上記の再導出）。
- 優先順位は `プロジェクト > 共通 > 組み込み`。同名は注入時に一意化し、影になったファイルはログと設定一覧の警告で、上書きされた組み込みは一覧の「上書きされています」で確認する（ファイルの改名・削除・マージはしない）。許可リストで外した組み込みは一意化に参加しないので、同名のファイルスキルがあればファイル側が単独で有効になる。
- 組み込みスキルはワークスペースに実体を作らず（`read` だけ BFF が同梱の本文を返す）、アプリの更新に追従して常に最新・改変不可。既定は全部 ON で、エージェント定義の `builtinSkillNames` で外すと、その会話の index / `read` / system prompt の案内からも消える（[api-catalog.md](api-catalog.md#組み込みスキル)）。
- チャット側の一覧（`GET /api/sessions/:id/skills`）と `/skill:` の展開は同じ解決（`プロジェクト > 共通 > 組み込み`）を共有する。一覧が固定するのは発見一覧・説明・優先順位だけで、**本文は送信時にスコープ別に取り直す**（ファイル → サンドボックスの preview、組み込み → registry）。
- GUI からの共通スキルの保存は、**元の SKILL.md の変更箇所だけを差し替える**（`server/src/sandbox/skill-edit.ts`。契約は [sandbox-api.md](sandbox-api.md#共通スキルの編集v1skillsfile)）。frontmatter の未知キー・コメント・キー順・`name`・`disable-model-invocation` などの見えないキー・BOM・未変更部分の改行と空白を保持し、同じ内容の再保存ではファイルを書き換えない（バイト列も mtime も変えない）。**変更した説明と新規の説明だけに** trim 後の非空と 1024 字以内を要求し、それ以外の値は SDK の診断に委ねる。安全に source range を差し替えられない frontmatter は理由付きで拒否し、全文を正規化して保存することはしない
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
