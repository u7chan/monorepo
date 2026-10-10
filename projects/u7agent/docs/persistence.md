# データの永続化と再デプロイ時の挙動

## 現状

BFF とツール実行サンドボックスを別コンテナで動かす構成を対象とする。
サンドボックスの `/workspace` はホストの専用作業領域へ永続マウントし、
GUI の会話履歴は **BFF 専用の会話ストア**（`PI_SESSION_STORE`）へ JSONL で保存する。
会話と作業ディレクトリは同じセッション id で対応し、別の場所に置く。未所属チャットのスクラッチは `<workspace>/.u7agent/sessions/<id>`、プロジェクト所属セッションは登録ディレクトリそのもの、添付は共通の `<workspace>/.u7agent/uploads/<id>` を使う（[projects.md](projects.md#セッション-cwd)）。

| データ | 再作成・再デプロイ後 |
|---|---|
| `/workspace` 内のファイル・Gitリポジトリ・worktree | 残る |
| 共通スキル（`<workspace>/.agents/skills`） | 残る |
| セッションの作業ディレクトリ（未所属チャットのスクラッチ `<workspace>/.u7agent/sessions/<id>`） | 残る |
| プロジェクト所属セッションの作業ディレクトリ（登録ディレクトリそのもの） | 残る（登録したディレクトリが永続マウント配下なら） |
| プロジェクトスキル（`<project>/.agents/skills`） | 残る（登録したディレクトリが永続マウント配下なら） |
| 添付ファイル（`<workspace>/.u7agent/uploads/<id>`） | 残る |
| 会話履歴・セッション一覧・タイトル（`PI_SESSION_STORE/<id>/{meta.json,session.jsonl,sends.json}`） | 残る（ストアを永続ボリュームに置いた場合） |
| エージェント / スキル定義（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合） |
| アーカイブの除外名（アプリデータの SQLite、上書きしたときだけ） | 残る（ストアを永続ボリュームに置いた場合） |
| 設定 → モデルで登録したプロバイダーAPIキー（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合。平文・[model-settings.md](model-settings.md)） |
| 設定 → モデルで保存したプロバイダーのメモ（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合。平文・[model-settings.md](model-settings.md#プロバイダーごとのメモ)） |
| コンテンツ生成の provider / 画像モデル / 音声モデルとボイス / APIキー（アプリデータの SQLite、`content_settings`） | 残る（ストアを永続ボリュームに置いた場合。平文・[image-generation.md](image-generation.md)・[speech-generation.md](speech-generation.md)） |
| Web 検索の有効 / 無効と既定 provider（アプリデータの SQLite、`web_search_settings`） | 残る（ストアを永続ボリュームに置いた場合・[web-search.md](web-search.md#実行時トグル)） |
| Web 検索の provider ごとのAPIキー（アプリデータの SQLite、`web_search_provider_keys`） | 残る（ストアを永続ボリュームに置いた場合。平文・[web-search.md](web-search.md#設定既定-provider-と-apiキー)） |
| アプリデータの DB（`PI_SESSION_STORE/u7agent.db`） | 残る（ストアを永続ボリュームに置いた場合） |
| `/workspace` 以外に保存したデータ・後からインストールしたツール | 原則残らない |
| 実行中のプロセス | 中断される |
| プロジェクトの登録 | 残る（アプリデータの SQLite。所属は `projectCwd` から読み取り時に解決する） |

この表は永続マウントを設定したデプロイ環境での挙動を示す。
イメージ単体で起動するだけでは `/workspace` と会話ストアの永続化は保証されない。
単なるコンテナ停止・再開では書き込み層が残る場合があるが、再作成後の保持は保証しない。

## スペース

スペースはデモ用の会話の表示区分であり、認証・権限・実行隔離ではない。共通設定、カタログ、API キー、ワークスペース全体のファイル、通知先、公開サービスの枠は共有する。追加スペースは会話専用で、プロジェクトは通常スペースだけで利用する。

- 通常の予約 ID は `default`。旧会話の `meta.json` に `spaceId` が無い場合だけ通常として読む。不正な保存値は通常へ読み替えず、壊れた meta として一覧から除く。
- 追加スペースはアプリ DB の `spaces(id, name, createdAt)` に保存する。内部 ID は `space-` + 16 桁の hex、表示名とは独立して固定する。通常は固定の選択肢でテーブルへ保存しない。v13 → v14 はテーブル追加だけの加算移行で、既存データを移動・削除しない。
- 会話ログは従来の `<PI_SESSION_STORE>/<sessionId>/` のまま。追加スペースの所属は meta に保存し、live・未ロード・sweep 後・再起動後で保持する。JSONL の SDK 形式は変えない。
- 通常の作業先・添付は既存パスのまま。追加スペースだけ `.u7agent/spaces/<spaceId>/sessions/<sessionId>` と `.u7agent/spaces/<spaceId>/uploads/<sessionId>` を使う（[session-files.md](session-files.md#スペースごとの配置)）。
- 切り替えは会話や実行中ランを消さない。スペースの改名・削除・リセットは設けない。空のデモを始めるときは新しいスペースを作成する。

## 作業領域

現在の self-hosted-runner 環境では以下を対応させている。

| 場所 | パス |
|---|---|
| サンドボックス内 | `/workspace` |
| ホスト上 | `/home/u7chan/deploy/u7agent/workspace` |
| 会話ストア（BFF 専用） | BFF コンテナの `PI_SESSION_STORE`（例 `/session-store`）。サンドボックスへはマウントしない |

- BFF には作業領域をマウントしない。ファイル操作・シェル実行はサンドボックス側で行う。
- 会話ストアはサンドボックスと共有しない。共有すると、サンドボックスから symlink を差し替えて BFF のファイルを壊したり読み出したりできてしまう。`PI_SESSION_STORE` が `PI_APP_CWD` の中なら起動時に拒否する。
- Gitリポジトリ本体と worktree は両方 `/workspace` 配下に配置する。外部パスへの参照先は永続化対象にならない。
- 後からインストールするツールも、保存先が `/workspace` 内ならそのファイルは残る。ただし外部の依存ファイル・設定まで復元されるとは限らない。
- 常用するツールはイメージへ組み込み、再作成後も利用できるようにする。
- 永続マウントはバックアップではない。作業ファイルの削除やホスト障害からの復旧は別途備える。
- サービスの稼働記録とログは作業領域の `.u7agent/serve/`（`state.json` / `app.log`）に置く。会話ストア（BFF 専用）へは置かない（BFF 再起動後の復元はサンドボックス経由で読む）。プロジェクトのディレクトリには作らない（[session-files.md](session-files.md#添付ファイルチャットからのアップロード)）。

配置・所有権・Compose の正本はデプロイ側で管理する。

- [Compose 定義](https://github.com/u7chan/self-hosted-runner/blob/main/deploy/u7agent.yml)
- [target 設定](https://github.com/u7chan/self-hosted-runner/blob/main/deploy/targets.json)
- [運用手順](https://github.com/u7chan/self-hosted-runner/blob/main/docs/u7agent.md)

## アプリデータ（SQLite）

プロジェクトの登録、エージェント定義、スキル定義は BFF の SQLite に保存する（`server/src/app-db.ts`）。
会話は従来どおり `session.jsonl` のままで、DB には入れない。

- 置き場所は会話ストアと同じディレクトリの `PI_SESSION_STORE/u7agent.db`。新しい環境変数は増やさない。
- メモリ DB（`:memory:`）になるのは `sessionStoreDir: null` を明示したとき（テスト）だけ。パス解決に失敗したときは DB を使えない状態にし、メモリへは逃がさない。
- テーブル説明に残る「メンション」は旧 `notification_settings.mention` 列。既存 DB との互換性のため列は残すが、現行アプリは値を読まず、保存時は `none` に戻す。
- テーブルは `projects` / `agents` / `skills` / `notification_settings` / `archive_settings` / `provider_credentials` / `model_settings` / `provider_memos` / `content_settings` / `image_catalog` / `serve_commands` / `secrets` / `web_search_settings` / `web_search_provider_keys` の 15 つ。`provider_credentials` は 設定 → モデルで登録したプロバイダー API キーを 1 行 1 プロバイダーで持ち、値は平文（アクセス権の管理と残存リスクは [model-settings.md](model-settings.md)）。`updatedAt` は保存のたびに更新する epoch ms で、v6 以前から残る行は NULL（保存日不明）のままにする（[model-settings.md](model-settings.md#キーの棚卸し最終保存と最終使用)）。`skillIds` / `suggestions` / `model` / `excludeNames` は JSON 列、並び順は作成順（rowid）。`notification_settings` は Discord 通知のグローバル設定（Webhook URL / 有効 / ベース URL / メンション / 直近結果）を 1 行だけ持ち、Webhook URL は API 応答へ出さない（[notifications.md](notifications.md)）。`archive_settings` はダウンロード ZIP の除外名（`excludeNames`）を 1 行だけ持ち、**行が無い = 未設定**（実効値は `DEFAULT_ARCHIVE_EXCLUDE_NAMES`）、行があればその一覧が正で `[]` は「除外なし」を表す（[file-preview.md](file-preview.md#ダウンロード)、[api.md](api.md#アーカイブの除外名)）。既定へ戻すときは行ごと消す（既定名を保存し直すと、以後 `DEFAULT_ARCHIVE_EXCLUDE_NAMES` を足しても追随しなくなる）。`model_settings` は 設定 → モデル の「利用可能なモデル」とアプリ既定モデルを 1 行だけ持ち、**行が無い = 未設定**（制限なし・既定なし）。`allowedModels` は JSON 配列で、NULL と空配列はどちらも制限なしを表し、両方が NULL になったら行ごと消す（[model-settings.md](model-settings.md#モデル候補選択とアプリ既定モデル)）。`provider_memos` は provider に紐づく人間用のメモを 1 行 1 プロバイダーで持ち、**行が無い = 未設定**。`provider_credentials` とは別テーブルにし、キーの登録有無（`managed`）とメモを混ぜない。空にして保存すると行ごと消し、手編集された空文字の行も未設定として読む（[model-settings.md](model-settings.md#プロバイダーごとのメモ)）。`content_settings` はコンテンツ生成の provider / 画像モデル（`imageModel`）/ 音声モデル（`speechModel`）/ ボイス（`speechVoice`）/ APIキーを 1 行だけ持ち、**行が無い = 未設定**（キー削除は行ごと消す）。プロバイダー登録キーとは別管理にし、行の有無が `generate_image` / `generate_speech` の公開ゲートになる（[image-generation.md](image-generation.md) / [speech-generation.md](speech-generation.md)）。音声の 2 列は v15 → v16 の加算移行で足した nullable 列で、NULL は既定モデルと「そのモデルが宣言する先頭ボイス」へフォールバックして読む（画面に「（未設定）」を出さない）。名前が `image_catalog`（画像専用の派生キャッシュ）と非対称なのは、キーと生成対象の選択を生成物の種類で増やさず 1 行共有するため。`image_catalog` は live カタログの**キャッシュ**を 1 行だけ持ち、**行が無い = 未取得**。`models` は `{ id, name, outputFormats? }` の JSON 配列で、provider は v1 では openrouter 固定なので保存しない。`outputFormats` は live が宣言する出力形式で、**任意フィールド**（無い行・形が違う行は「宣言なし」として読む。カラムは増やさないのでスキーマ移行は不要）。利用者データではなく派生データなので、読めない行（行が無い / 形が違う / JSON が壊れている）はすべて未取得として扱い、SDK 同梱カタログへ落ちる。**保存値の失敗としては記録せず、health も落とさない**（破損を DB 全体の失敗として扱わない。次の取得成功が行を上書きして直る）。`speech_catalog` は音声カタログの同じキャッシュで、テーブルの形は `image_catalog` と同型だが item の JSON は違う（`{ id, name, voices? }`）。行が無い / 読めない行は未取得として扱い、同梱の既定 1 件へ落ちる（[speech-generation.md](speech-generation.md#モデルカタログ)）。`web_search_settings` は `web_search` の有効 / 無効（`enabled`）と既定 provider（`provider`）を 1 行だけ持ち、**行が無い = 既定（有効 / exa）**。無効化のためのデプロイを不要にすることが目的の機能なので、既定は ON 側に倒す（[web-search.md](web-search.md#実行時トグル)）。`provider` は v12 → v13 の列追加で、既存行は既定 `exa` で埋まる。`web_search_provider_keys` は provider ごとの APIキーを 1 行 1 provider で持ち、**行が無い = キー未設定**（削除は行ごと消す）。キー付きの provider が増えても「どの provider のキーか」を行で表せるよう、`web_search_settings` の列にはしない。値は平文（[web-search.md](web-search.md#設定既定-provider-と-apiキー)）。`serve_commands` はサービスの起動に成功したコマンドを 1 行 1 作業ディレクトリ（`cwd` は root 相対）で持ち、**行が無い = 実績なし**。プロジェクトレコードに従属させず `cwd` をキーにする（プロジェクト登録を解除しても `meta.projectCwd` は残るため）。稼働記録（サンドボックスの `.u7agent/serve/state.json`）とは別物で、プロセスが消えても残り、同じ作業ディレクトリの他会話でも使える（[sandbox.md](sandbox.md#serveサービスの公開と起動停止)）。`secrets` は作業フォルダ（`cwd` は root 相対で `serve_commands` と同じキー空間）単位の環境変数を持ち、`kind='variable'` は `plaintext`、`kind='secret'` は `ciphertext` / `nonce` / `keyVersion` を使う（列は種別ごとに排他）。`UNIQUE (cwd, name)` で名前は cwd 内で一意、`sortOrder`（追加は `MAX + 1`、削除で詰めない）で並ぶ。**このテーブルは列追加だけの加算移行を恒久ルール**とし、`DROP_TABLES` に入れない: 古いビルドへ戻したとき（`#recreate`）はこのテーブルを知らないので放置され、新ビルドへ戻すと #migrate() の `CREATE TABLE IF NOT EXISTS` がそのまま合流させる（秘密が消える移行を許さない。暗号化の書式は [secrets.md](secrets.md#作業フォルダの環境変数)）。
- `provider_credentials` は v3 → v4、`model_settings` は v4 → v5、`provider_memos` は v5 → v6、`provider_credentials.updatedAt` は v6 → v7、`image_settings` は v7 → v8、`image_catalog` は v8 → v9、`serve_commands` は v9 → v10、`secrets` は v10 → v11、`web_search_settings` は v11 → v12、`web_search_settings.provider` と `web_search_provider_keys` は v12 → v13 の加算移行で足した。`image_settings` → `content_settings` と `model` → `imageModel` は v14 → v15 の移行で改名した。`content_settings` の音声の 2 列と `speech_catalog` は v15 → v16 の加算移行で足した。保存は主キー `provider` の upsert（単一ステートメント）で、成功して返れば行は確定している。この性質を認証変更 API の `applied` / `not_stored` の判定に使う（[model-settings.md](model-settings.md#応答契約)）。`content_settings` は id = 1 の upsert で、成功して返れば行は確定している（[image-generation.md](image-generation.md#api)）。
- DB の例外文言は `AppDb.open({ sanitizeError })` を通してからログ・health・503 へ出す（bootstrap が可変マスカーを注入し、登録済みの API キーが例外へ現れても生のまま記録しない）。未指定は identity で、これはテストの明示 opt-out。
- `PRAGMA user_version` をコード側の定数（`APP_DB_SCHEMA_VERSION`）と照合する。古い版（小さい値）は加算的に移行し、足りないテーブルは `CREATE TABLE IF NOT EXISTS` で、足りない列は `PRAGMA table_info` で存在確認してから `ALTER TABLE ... ADD COLUMN` で足して `user_version` を更新する（既存のエージェント / スキル / プロジェクト / キーは消さない）。列追加は `CREATE TABLE IF NOT EXISTS` 群と同じトランザクション内で、途中失敗で列だけ残らない。v14 → v15 の改名だけは例外で、`ALTER TABLE ... RENAME` / `RENAME COLUMN` を `CREATE TABLE IF NOT EXISTS` **より先**に通す（先に CREATE すると空テーブルができて RENAME が失敗する）。`image_settings` と `content_settings` の両方があるときは `content_settings` を正として RENAME せず、`image_settings` の行は読まない。新しい版（大きい値）のときだけアプリ所有のテーブルを DROP → CREATE する。会話は `session.jsonl` なので作り直しでも消えない。
- 自分で書いた JSON 列が壊れていたときは、黙って既定へ落とさず例外にして 503 側で見せる（通知の `lastResult` と同じ規約）。アーカイブの除外名も、行があるのに配列でなければ同じ扱いにする。ただし `image_catalog` と `speech_catalog` はキャッシュなので例外にせず、読めない行は未取得として読む（[image-generation.md](image-generation.md#モデルカタログ) / [speech-generation.md](speech-generation.md#モデルカタログ)）。この「壊れた保存値」の失敗は `provider_credentials` のような別テーブルの読取成功や `probe()` の成功では消さず、同じテーブルを正しく読み直せたときだけ解除する（一過性の失敗とは別で、health の `appDb` が失敗を示し続ける）。
- サンプル定義（ずんだもん 1 体）は DB ファイルを新規作成したときだけ入れる。`user_version` 不一致の作り直しでは入れないため、削除した定義は再起動でも戻らない。
- スキーマ作成 → `user_version` 設定 → seed は同一トランザクション。スキル削除（参照除去を含む）もトランザクションで行い、途中で失敗したら部分適用を残さない。
- `journal_mode=WAL` / `synchronous=NORMAL`。書き込みは BFF の 1 プロセスを前提とし、複数インスタンスは対象外。

### 失敗時の扱い

会話ストアと同じ規約（メモリだけの黙ったフォールバックをしない）。

- 起動は継続し、`GET /api/health` の `appDb` に `{ path, ok, error }` を返す。
- アプリデータを読む API は 503 になる。カタログ（`/api/agents` / `/api/skills`）、プロジェクト（`/api/projects`）、セッションの作成・一覧・取得・設定変更・送信・SSE 接続（所属の解決と `create()` のカタログ参照を通るため）、設定のアーカイブ（`/api/settings/archive`）、設定のモデル（`/api/settings/models`）、コンテンツ生成の設定（`/api/settings/content`）、Web 検索の設定（`/api/settings/web-search`。provider ごとのキーを含む）、作業フォルダの環境変数（`/api/secrets`。cwd の解決と行の読み書きが要る）、サービスの状態（`/api/serve/status`。実績を読めないまま空の実績を見せない）。**変更系は 503 に `state: "not_stored"` を付け、何も保存していないことを示す**（モデル設定 / コンテンツ生成の設定 / Web 検索の設定（トグル・既定 provider・provider ごとのキーの登録・変更・削除） / 作業フォルダの環境変数の登録・変更・削除 / サービスの起動・停止 `/api/serve/start` `/api/serve/stop`）。
- 削除は会話ストアだけで完結するため通す。停止も live なセッションなら通る（未ロードのセッションは復元時に所属を解決するため、DB が使えないと 503 になる）。
- SSE は接続時に 503 で拒否し、配信中の payload 生成で失敗したらその接続を閉じる（未所属へ落として配信を続けない）。
- 起動時だけでなく稼働中の読み書き失敗も同じ扱いにする。失敗状態のときは入口ガードが `SELECT 1` で読み直し、成功すれば解除される（復旧に再起動は要らない）。

## モデルカタログのキャッシュ（SDK）

設定 → モデル（`/settings/models`）の [カタログ更新] が取得する pi.dev 由来のカタログは、pi SDK がエージェント設定ディレクトリ配下の `models-store.json`（BFF は置き場所を変える環境変数を設定しないため、既定は `$HOME/.pi/agent/models-store.json`）へ保存する。**アプリのデータではない**ので、アプリ DB には列も行も増やさない。

- 書くのは SDK だけ。BFF は SDK の取得 API を通して間接的に更新し、取得結果の永続化は SDK に任せる
- BFF のプロセス再起動では残り、起動時に overlay として読まれる（同梱カタログへの上書き）。コンテナを作り直すと消え、同梱カタログへ戻る。永続ボリュームにはならない（`PI_CODING_AGENT_DIR` で置き場所を変えない限り）
- 失われてもアプリの起動・設定 API・会話は壊れない。恒久化と `PI_CODING_AGENT_DIR` の変更は非ゴール（[model-settings.md](model-settings.md#モデルカタログの取得と更新)）
- このファイルを削除しても、GUI で登録したキー（アプリ DB）と `auth.json` は消えない

## 会話履歴の扱い

会話は BFF 専用ストアの `PI_SESSION_STORE/<id>/{meta.json,session.jsonl,sends.json}` に保存する。
`meta.json` は表示用メタデータ（タイトル / エージェントのスナップショット / 所属プロジェクトの cwd / 使用モデル / 会話ごとの通知トグル `notify`）を持ち、
`session.jsonl` は pi SDK 形式（header + entries、compaction entry を含む）で、読み書きは BFF の `session-store` が行う。
`sends.json` はまだ entry になっていない送信（未送信）を持つ BFF 専用の補助ファイルで、保存済み entry の run id は JSONL の entry に写した注記（`u7agentRunId`）が正（[session-files.md](session-files.md#sendsjson-と-run-id-の注記)）。

- 起動時にストアを走査して一覧（descriptor）を復元し、セッションを開いたときに SDK セッションを遅延生成する。表示メッセージ数（`messageCount`）の定義を変えた場合は、古い値のままの meta を開いたときに書き戻すため、開いていないセッションの一覧は古い値を返し続ける（[session-files.md](session-files.md)）。
- アイドル 1 時間の sweep はメモリから外すだけで、ストアと作業ディレクトリ・添付は残る。SSE 購読中のセッションは対象外。
- `DELETE /api/sessions/:id` はストアの履歴だけを消し、作業ディレクトリ（ユーザーのファイル）と添付は残す。
- タイトルは GUI の ⋯「名前を変更」（`PATCH /api/sessions/:id/title`）で更新でき、live / 未ロードのどちらでも `meta.json` を書き換える（未ロードでは SDK セッションを開かない。[api-sessions.md](api-sessions.md#patch-apisessionsidtitle)）。
- エージェント定義のプロンプトとスキル本文は作成時に `promptSnapshot` として meta に保存し、復元後の実行内容を定義の変更に依存させない（現行の「定義変更を遡及させない」と同じ）。agent は system prompt へ入れるが、スキル本文は入れない — 索引（name / description / 仮想パス）だけを `skillsOverride` で渡し、本文は `read` と `/skill:` の展開がこのスナップショットから取り出す。ファイルスキル（`.agents/skills`）は `promptSnapshot` に含めず、復元のたびに再発見する（[スキルの扱い](#スキルの扱い)）。
- モデルは JSONL 最後の `model_change` → meta の `model` → アプリ既定 の順に、設定 → モデル の「利用可能なモデル」で絞った候補と照合する（[model-effort.md](model-effort.md)）。候補外ならアプリ既定へフォールバックし、その実効値を `model_change` へ追記して保存する（アプリ既定が未設定ならフォールバック先が無く、復元は 503 になる）。
- スキル読み込み（`read` で basename が `SKILL.md`）の表示は専用の保存フィールド / カラムを持たず、**pi entry の raw content（`toolCall` part と `toolResult`）を正として毎回再導出**する（`classifySkillRead()`。導出の契約は [api-sessions.md](api-sessions.md#スキル読み込みskillloads--skill)）。この再導出が成立するのは raw content を保存し続ける場合だけで、projected な `ChatMessage` の列（role / text / usage / metrics）だけを保存する設計にすると再導出できず、別途カラムが要る。現行の `session.jsonl`（SDK 形式）は raw content を保つため、BFF 再起動後に復元したセッションでも同じ位置に出る
- BFF 計測の時間（`messages[].metrics` の応答時間と `ToolCall.startedAt` / `endedAt` のツール実行時間）は JSONL へ保存しない。SDK の entry は応答の完了時刻もツール実行の開始時刻も持たず、同じ assistant メッセージの複数ツールを `toolResult` の `timestamp` から区別できないためだ。再起動とアイドル sweep のあとに開き直したセッションでは、ツール履歴の実行時間が出ない（表示は欠けた値を出さないだけで壊れない）。同じ理由で、ラン全体の所要時間と結末（`runDurationMs` / `runOutcome`）と圧縮の所要時間（`CompactionInfo.durationMs`）も保存せず、復元後は載らない（[run-lifecycle.md](run-lifecycle.md#状態) / [compaction.md](compaction.md#表示仕様)）
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
- user item の `runId`（送信した run の id）は実行時の参照（SDK メッセージ → run id）から写し、保存した entry は JSONL の entry 自身へ写した注記（`u7agentRunId`。[session-files.md](session-files.md#sendsjson-と-run-id-の注記)）で再起動後も保つ。クライアントはこの値で自分の送信エコーを他クライアントの同一文面 item と区別し、`run_start` やページ適用で正しい item へ吸収する。対応が無い旧保存データの item だけが、本文の正規形（+ 送信時点の位置 `since`）での縮退対象になる。202 で受理したがまだ entry になっていない送信は `sends.json` の `unsent` に残り、再起動後に「未送信」として配る（履歴の同一文面 item へ黙って吸収させない）
- `context_edit` で agent state から外れたメッセージも entry には残るため、`excluded` として読める（要約済みとは区別する）
- ページ取得は JSONL を読み直さずメモリ上の entry 列を走査する。表示文字列へ写すのは選んだページ範囲だけで、既存のマスカーを共有する

## スキルの扱い

スキルは「エージェント定義のスキル」「ファイルスキル」「組み込みスキル」の 3 種類がある。

| 種類 | 置き場 | 編集 | 再デプロイ後 |
|---|---|---|---|
| エージェント定義 | アプリデータの SQLite（設定 → スキル） | GUI | 残る |
| ファイルスキル（共通） | `<workspace>/.agents/skills` | ファイル（GUI は読み取り専用） | 残る |
| ファイルスキル（プロジェクト） | `<project>/.agents/skills` | ファイル | 残る（永続マウント配下なら） |
| 組み込み | アプリのバンドル `server/src/builtin-skills/`（仮想パス `<workspace>/.u7agent/builtin-skills/...`） | 不可 | イメージ更新で入れ替わる |

- エージェント定義のスキルは作成時に `promptSnapshot` へ `<agent_skill>` で本文を固定し、索引（name / description / 仮想パス `<workspace>/.u7agent/agent-skills/<name>/SKILL.md`）だけを `skillsOverride` で渡す。`read` は BFF が横取りしてこの本文を返す（[session-files.md](session-files.md)、[api-catalog.md](api-catalog.md#セッションへの渡し方)）。
- 初期状態はカタログスキル 0 件で、ユーザー定義エージェントはずんだもん `agent-zundamon` 1 体（`systemPrompt` に語尾の指示）。どちらも通常の定義と同じ扱いで削除できる。サンプルは DB を新規作成したときだけ入るため、削除した定義は再起動でも戻らない。
- ファイルスキルはエージェントに紐づかない **ambient** なスキルで、セッション作成・復元のたびにサンドボックス（`GET /v1/skills`）で発見し、SDK の `skillsOverride` へ渡す。`promptSnapshot` には保存しない。セッションが持つのは発見一覧・説明・優先順位だけで、復元時は `meta.projectCwd` を起点に取り直す（プロジェクト登録が外れていても同じ）。
- 発見できるのは `SKILL.md` だけ。**本文は保存も固定もしない**ため、モデルが `read` した時点のファイル内容になる（作成後に編集すればその内容、削除すれば読取り失敗）。設定画面とチャットの一覧も同じで、ファイルを変えれば再読み込み後の表示に反映される。どのターンで `read` されたかは JSONL の `toolCall` から導出し、チャットの assistant バブルに `[skill]` バッジとして出す（上記の再導出）。
- 優先順位は `プロジェクト > 共通 > 組み込み`。同名は注入時に一意化し、影になったファイルはログと設定一覧の警告で、上書きされた組み込みは一覧の「上書きされています」で確認する（ファイルの改名・削除・マージはしない）。
- 組み込みスキルはワークスペースに実体を作らず（`read` だけ BFF が同梱の本文を返す）、アプリの更新に追従して常に最新・改変不可。カタログの一覧と `skillIds` の対象外（[api-catalog.md](api-catalog.md#組み込みスキル)）。
- チャット側の一覧（`GET /api/sessions/:id/skills`）と `/skill:` の展開は同じ解決（`プロジェクト > 共通 > 組み込み > カタログ`）を共有する。一覧が固定するのは発見一覧・説明・優先順位だけで、**本文は送信時にスコープ別に取り直す**（ファイル → サンドボックスの preview、組み込み → registry、カタログ → `promptSnapshot`）。カタログの本文は `promptSnapshot` から引くため、定義を編集・削除してもこのセッションの `read` / `/skill:` は作成時の内容で動く（[api-sessions.md](api-sessions.md#skill-の展開)）。
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
