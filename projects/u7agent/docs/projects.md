# プロジェクトとセッションの作業ディレクトリ

プロジェクトはワークスペース内のディレクトリの登録で、`server/src/projects.ts` の `ProjectStore` がメモリ内に持つ。`cwd` はワークスペース root 相対のパスだけを持つ（絶対パスで保存するとマウント先の変更で壊れる）。root 自身とアプリの作業ディレクトリ `<appdir>`（現 `.u7agent`）自身・配下は登録できない。

## 作成と削除

- 作成は「新規ディレクトリ作成（サンドボックスの `POST /v1/dirs`）」と「既存ディレクトリの登録（`GET /v1/files` がディレクトリ以外で失敗する性質で確認）」の両方で、BFF は作業領域のファイルシステムへ直接触らない。同じ `cwd` の二重登録は 409。
- `<appdir>/**` の登録要求は 400（未所属セッションのスクラッチと添付の置き場をファイル画面の root にしないため。レイアウトは [session-files.md](session-files.md) を正とする）。
- 削除は登録解除と、配下 `projectCwd` を持つ live セッションの停止（実行中は abort）だけを行う。セッション・会話ストア・作業フォルダは残し、購読中の SSE へは所属が外れた `resync` を送る（`session_deleted` は送らない）。ディレクトリも残す。
- `cwd` の正規化は `normalizeWorkspacePath` が担い、絶対パスと `..` は字句的に畳まず拒否する（[sandbox.md](sandbox.md) のパス解決と同じ方針）。

## セッション cwd

プロジェクト所属セッションの作業ディレクトリは**登録ディレクトリそのもの**（`project.cwd`）で、SDK セッションの cwd・ツールのパス解決の起点・write / edit の書き込み範囲・ファイル画面（`SessionPayload.cwd`）の root を同じ値に揃える。同一プロジェクトの複数セッションはこのツリーを共有するため、片方で作ったファイルが他方のファイル画面にも相対パスで見え、`.git` に届くので `git status` / `git worktree add` のようなリポジトリ前提の作業ができる。

未所属チャットは現行どおり `<root>/<appdir>/sessions/<id>` のスクラッチを使う。添付ファイルは所属に関係なく `<root>/<appdir>/uploads/<sessionId>/` に置き、プロジェクト所属でもリポジトリ内には作らない。モデルへは注記で絶対パスを渡し、ファイル画面には出ない（[session-files.md](session-files.md#添付ファイルチャットからのアップロード)）。

所属プロジェクトは `projectCwd` / `projectName` として会話ストアの meta に保存し、`SessionPayload.cwd` / `SessionSummary.projectId` は root 相対の作業フォルダと、読み取り時に `ProjectStore.findByCwd(projectCwd)` で解決した所属から組み立てる。所属を後から変える API は無い。SDK セッションへは `createAgentSession({ cwd })` / `SessionManager.inMemory(cwd, ...)` として作業フォルダを渡し、実行時のパス解決の起点にする。

- セッション作成時にプロジェクトのディレクトリは作らない。既存確認（サンドボックスの一覧取得）だけを行い、無ければ 400 にする。
- 未所属セッションのスクラッチは同じ `<root>/<appdir>/sessions/<id>` で、root を cwd にはしない。
- 既存セッションの cwd は復元時に `meta.projectCwd` から解決する。登録が解除・消失していても `projectCwd` をそのまま使う（`projectCwd` が無ければスクラッチ）。旧スクラッチフォルダは削除しない。
- worktree はアプリが作らない。切った worktree をプロジェクトとして登録し、並行作業の分離はこれで行う（自動作成・削除・ブランチ命名は非ゴール）。
- 会話の永続化が無効（`PI_SESSION_STORE` 未設定・テスト）なときはプロジェクトの `cwd`（未所属は root）を使い、作業フォルダの存在確認・作成・保存をしない。

## write / edit の書き込み範囲

`write` / `edit` は、そのセッションの作業ディレクトリ（`record.workdir`）配下と、共通スキル置き場 `<root>/.agents/skills` 配下にだけ書ける。モデルが workspace root を指す絶対パスで `write` を呼んでも、ファイル画面の root（`SessionPayload.cwd`）の外には作らない。許可 root は次の 3 つ。

- 実行 cwd（リクエストの `cwd` をサンドボックスが realpath で解決した実パス。相対パスの解決先）
- 要求 cwd の lexical 形（`resolve(PI_SANDBOX_CWD, リクエスト cwd)`）。workspace root や登録プロジェクトが symlink のとき、system prompt に出る `Current working directory` の形の絶対パスでも書けるようにするため
- `<root>/.agents/skills`（未所属でも所属でも書ける。所属セッションのプロジェクトスキルは cwd 配下なので 1 つ目の root に含まれる）

判定はサンドボックス（`server/src/sandbox/service.ts` の `registryFor`）が担う。SDK が `resolveToCwd` で解決した絶対パスを `resolve()` で `..` まで畳んで比較し、realpath / `lstat` は使わない（BFF に二重実装しない）。write は `mkdir` と `writeFile`、edit は `access` / `readFile` / `writeFile` のすべてが同じ判定を通り、write の `mkdir` を先に許すと拒否パスでも workdir 外に親ディレクトリができるため `mkdir` でも拒否する。

拒否は HTTP 200 の `error` イベントとして返し（404 / 400 は使わない）、文言に許可場所（実行 cwd の絶対パスと `<root>/.agents/skills`）と cwd 相対の再試行例（`cafe.html`）を含める。`cwd` 自体の検証（実在しない・ディレクトリ以外・root 外）は従来どおり実行前の 400 / 404 のままで、モデルのツールエラーにはならない（[sandbox-api.md](sandbox-api.md#post-v1toolstoolexecute)）。

- `read` / `grep` / `find` / `ls` / `bash` は変えない。`read` は添付（`<appdir>/uploads/<id>`）・ファイルスキル・pi docs を読むため広いままにする。`bash` のリダイレクトは原理的に塞げない（`echo x > /workspace/cafe.html`）
- 対象外: 他セッションのスクラッチ、workdir を除く `.u7agent` 配下（添付は BFF が `POST /v1/files/upload` で書く）、他プロジェクト、`<appdir>/builtin-skills/**`、workspace root 直下（下記の永続化なしの縮退を除く）
- 作業ディレクトリ内の既存 symlink / 壊れた symlink 経由の脱出は検知しない（判定が lexical のため。実行隔離として別に扱う）
- worktree はアプリが作らない。`git worktree add` しただけの未登録ディレクトリは作業ディレクトリではないため、そのパスへの `write` / `edit` は拒否される。切った worktree をプロジェクトとして登録し、新しいセッションを作る既存フローでカバーする
- 会話の永続化が無効（`PI_SESSION_STORE` 未設定）の未所属は `workdirOf` が root（`""`）を返すため、境界は workspace root だけになる。分岐は足さず、root 直下への `write` / `edit` は通る（root 外だけを拒否する縮退）

## 実行時の隔離ではない

プロジェクトは**実行時の隔離ではない**。cwd はツールのパス解決の起点を変えるだけで、サンドボックス内のファイル・ポート・プロセスは全セッションで共有される（bash がある以上、未所属セッションから他プロジェクトのディレクトリも操作できる）。`write` / `edit` の書き込み範囲（[前節](#write--edit-の書き込み範囲)）も同じで、モデルの取り違えを防ぐファイルツールのポリシーであり、実行隔離ではない。隔離が必要になった時点でコンテナ・データ領域分離として別に設計する。

ツール実行はリクエストごとの `cwd`（root 相対）を受け取り、サンドボックスが root 配下の実在ディレクトリへ解決してから、その実パス（write / edit の許可 root も定義に焼き込むため、要求 cwd の lexical 形との組）ごとに生成・キャッシュしたツール定義で実行する。`..` や symlink で root の外へ出る指定は 400。この検証も cwd の起点を決めるだけで、サンドボックスが読める範囲を絞るものではない。

## 関連 API

- `GET /api/files?path=<root 相対>` — 一覧（[api.md](api.md)）
- `POST /api/projects` / `DELETE /api/projects/:id` — 登録と解除（`<appdir>/**` は 400。[api.md](api.md)）
- `POST /api/sessions` の `projectId` — セッション作成時の所属（[api-sessions.md](api-sessions.md)）
