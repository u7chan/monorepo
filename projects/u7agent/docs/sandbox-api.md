# サンドボックス内部 API と環境変数

BFF が作業用ツール（`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`）の実行、作業領域の一覧取得、ファイルスキルの発見を委譲する内部API。ブラウザから直接呼ぶAPIではなく、`AppType` には含まれない。ホストへ公開せず、BFF ⇄ サンドボックスの内部ネットワークのみで到達する。設計の背景は [sandbox.md](sandbox.md) を参照する。ファイル操作は [sandbox-api-files.md](sandbox-api-files.md)、スキルは [sandbox-api-skills.md](sandbox-api-skills.md)、ランタイムの診断は [sandbox-api-runtime.md](sandbox-api-runtime.md) に分かれる。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/healthz` | 無認証。Compose healthcheck 用。`{ ok, tools, cwd, runningExecutions }` |
| GET | `/v1/runtime/info` | 実行環境の診断（認証必須・読み取り専用）。[実行環境の診断](sandbox-api-runtime.md#get-v1runtimeinfo) |
| GET | `/v1/procs/listeners` | 待受ソケットと所有 PID の観測（単一ポート / レンジ。認証必須・読み取り専用）。[待受プロセスの観測](sandbox-api-runtime.md#get-v1procslisteners) |
| GET | `/v1/files` | 作業領域の一覧（JSON）。`?path=<root 相対>` |
| GET | `/v1/files/git` | 作業フォルダが属する repo のブランチ（JSON）。`?path=<root 相対>` |
| GET | `/v1/skills` | ファイルスキル（`SKILL.md`）の発見（JSON）。`?dir=<root 相対>` |
| GET | `/v1/skills/export` | `.agents/skills` の ZIP エクスポート（ストリーム）。[スキルのエクスポート / インポート](sandbox-api-skills.md#スキルのエクスポート--インポート) |
| GET | `/v1/skills/export/check` | エクスポートの見積り（JSON）。上限と `.git` の除外は export と同じ |
| POST | `/v1/skills/import` | `.agents/skills` の ZIP 取り込み（raw 本文）。`?dryRun=true` / `?replace=<名前>`（繰り返し可） |
| GET | `/v1/skills/file` | 共通スキル 1 件の編集内容（JSON）。`?relativePath=<root 相対>` |
| POST | `/v1/skills/file` | 共通スキルの新規作成。`{ name, description, body }` |
| PATCH | `/v1/skills/file` | 共通スキルの保存。`{ relativePath, fileVersion, description, body }` |
| GET | `/v1/skills/file/delete-preview` | 削除する専用フォルダ・付随ファイル・`treeVersion`。`?relativePath=<root 相対>` |
| DELETE | `/v1/skills/file` | 専用フォルダの削除。`?relativePath=<root 相対>&treeVersion=<hex>` |
| DELETE | `/v1/files` | 通常ファイルの削除。`?path=<root 相対>`。成功は本文なしの 204 |
| POST | `/v1/files/rename` | エントリ（ファイル / ディレクトリ）のリネーム。`{ path, name }` |
| POST | `/v1/files/move` | エントリ（ファイル / ディレクトリ）を別の親へ移動。`{ from, to }` |
| GET | `/v1/files/preview` | UTF-8テキストの取得。`?path=<root 相対>`。上限・応答は [api-files.md](api-files.md#テキストプレビュー) を参照 |
| GET | `/v1/files/raw` | 画像 + 音声の生配信。`?path=<root 相対>`。応答ヘッダは [api-files.md](api-files.md#画像配信raw) を参照 |
| GET | `/v1/files/download` | 通常ファイルは生バイト、ディレクトリは ZIP（ストリーム）。`?path=<root 相対>&exclude=<名前>`（繰り返し可） |
| GET | `/v1/files/download/check` | ダウンロードの見積り（JSON）。除外 / 上限の判定は download と同じ（`exclude` も共通） |
| GET | `/v1/files/download/plan` | 見積りに公開前プレビュー用の一覧を足した計画（JSON）。走査と上限は download と同じ |
| POST | `/v1/files/upload` | ファイル追加（raw 本文）。`?dir=<root 相対>&name=<ファイル名>` |
| GET | `/v1/files/handoff` | 引き継ぎメモ（`HANDOFF.md`）の読取り（JSON）。`?path=<root 相対>` |
| POST | `/v1/files/handoff` | 引き継ぎメモの先頭追記（JSON）。`{ path, section, dedupeKey }` |
| POST | `/v1/files/handoff/rollback` | 新規作成した引き継ぎメモの条件付き削除（JSON）。`{ path, expected }` |
| POST | `/v1/dirs` | ディレクトリ作成（`mkdir -p` 相当）。`{ path }` |
| DELETE | `/v1/dirs` | ディレクトリ削除。`?path=<root 相対>&recursive=true`。成功は本文なしの 204 |
| POST | `/v1/tools/:tool/execute` | ツール実行。NDJSON ストリームで応答 |
| POST | `/v1/executions/:id/cancel` | 実行中のツールを中断 |

認証は `Authorization: Bearer <PI_SANDBOX_TOKEN>`。未認証は 401、未知のツールは 404、`params` がオブジェクトでない場合や `cwd` / `path` / `env` の形が不正な場合は 400。

## `POST /v1/tools/:tool/execute`

リクエストボディは `{ toolCallId?: string, params?: object, cwd?: string, writeScope?: Array<{ path: string, create?: boolean }>, env?: Record<string, string> }`。応答は `Content-Type: application/x-ndjson` で、1 イベント 1 行:

```jsonl
{"type":"start","executionId":"…"}
{"type":"update","payload":{"content":[…],"details":{…}}}
{"type":"result","payload":{"content":[…]}}
```

- `cwd` — 実行する作業ディレクトリ（root 相対。省略・空文字は root）。`..` や symlink を経由して root の外へ解決する指定、実在しないディレクトリ、ディレクトリ以外は 400 / 404（`GET /v1/files` と同じ検証を通す）。ツール定義（パス解決の起点）は解決後の実パスごとに生成して再利用する
- `writeScope` — **BFF 内部実行（serve の観測・記録・起動・停止）専用の書き込み許可 root**（root 相対の配列。`create: true` は実在しなければ mkdir してから許可する）。省略時はエージェントの `bash` として要求 cwd から基準集合を導出し、指定時は**その配列だけ**を要求由来の root にする（`cwd: ""` の root へは落ちない）。`..` で root の外を指す指定や形の不正は 400。モデルはツール引数から指定できず、BFF の serve 操作だけが渡す（[sandbox.md](sandbox.md#serveサービスの公開と起動停止)）。固定の `/tmp`・ホームのキャッシュ・デバイスファイルは全実行で共通
- `env` — この実行の子プロセスへ足す環境変数（作業フォルダの「変数」と、serve 起動時の「変数 + シークレット」）。`bash` のときだけ使い、`spawnHook` で親 env へ重ねる。名前は `isInjectableEnvName()`（大文字の `[A-Z_][A-Z0-9_]*`・64 文字以内・`PI_*` / `PI_SANDBOX_*` / `U7AGENT_*` と実行制御系を拒否）を通るものだけで、値の NUL も拒否する。`PI_SANDBOX_TOKEN` と master key（`U7AGENT_SECRET_MASTER_KEY` / `U7AGENT_SECRET_MASTER_KEY_FILE`）はこの後で必ず剥がす（子プロセスへ渡さない）
- `bash` は **Landlock のラッパー経由で実行**し、ファイルの作成・書き込み・削除・rename・truncate を許可 root の外側で `EACCES` にする（起動 cwd は基準集合に含み、子孫へ継承される）。ラッパーが使えない / ABI 3 未満の環境では実行せず、`error` イベントで理由を返す
- `write` / `edit` の書き込み先は、実行 cwd（`cwd` を解決した実パス）、要求 cwd の lexical 形（`resolve(PI_SANDBOX_CWD, cwd)`）、および `<PI_SANDBOX_CWD>/.agents/skills` の内側だけ。SDK が解決した絶対パスを `resolve()` で `..` まで畳み、**実在する候補は `realpath` で許可 root の実パスと比較する**（root 内を指す symlink は通し、root 外を指す symlink と壊れた symlink は拒否する）。**許可 root の実パスは判定のたびに解決し直す**（未作成の root を祖先の実パスで固定しない）。外側は拒否する（[projects.md](projects.md#write--edit-の書き込み範囲)）
  - 対象外: 他会話のスクラッチ、workdir を除く `.u7agent` 配下、他プロジェクト、`.u7agent/builtin-skills/**`、workspace root 直下（`PI_SESSION_STORE` 未設定の縮退では root が作業ディレクトリになるため root 直下も通る）
  - write は `mkdir` と `writeFile`、edit は `access` / `readFile` / `writeFile` のすべてで同じ判定を通す（write は `mkdir` を先に許すと拒否パスでも親ディレクトリができるため `mkdir` でも拒否する）
  - `read` / `grep` / `find` / `ls` は制限しない。`bash` の書き込みはファイルツールのポリシーではなく Landlock で強制する（[sandbox.md](sandbox.md#パスと並行実行)）
- `start` — 実行開始。`executionId` は cancel に使う
- `update` — SDK ツールの `onUpdate`（bash の累積出力スナップショット等）を relay
- `result` — 正常終了。ストリームはここで閉じる
- `error` — 異常終了（`{ "type": "error", "message": "…" }`）。SDK ツールが throw したメッセージ。`write` / `edit` のポリシー拒否もこの経路で返し、文言に許可場所（実行 cwd の絶対パスと `<PI_SANDBOX_CWD>/.agents/skills`）と cwd 相対の再試行例を含める。拒否に 404 / 400 は使わない（HTTP 400 は BFF が `{ error: … }` の JSON ラッパーとしてモデルに見せるため。`cwd` 自体の検証は従来どおり実行前の 400 / 404）

クライアント（BFF）が切断した場合もサンドボックスは実行を中断する。明示的な中断は cancel エンドポイントか `AbortSignal` の伝播で行う。

## `POST /v1/dirs`

root 相対のディレクトリを `mkdir -p` 相当で作る（親が無くてもよい）。既存ディレクトリは成功扱い。応答は `{ "path": "a/b" }` で、作成した実ディレクトリの root 相対の正規化パス（root は `"."`）。

- `path` は root 相対。`..` で root の外を指す指定は 400。既存の symlink が root 外を指す場合も、その先には作らず 400（作成前に既存の最も深い祖先を realpath で検証する）
- 既存ファイルと同名のディレクトリ、途中にファイルがあるパス（`file.txt/nested`）は 400
- 作業領域へ書き込む API は `POST /v1/dirs` / `POST /v1/files/rename` / `POST /v1/files/move` / `POST /v1/files/upload` / `DELETE /v1/files` / `DELETE /v1/dirs` で、`GET /v1/files` は読み取り専用。これらのうち共通スキル置き場（とその祖先、または共通へ出入りする対象）を触る要求は、共通スキルの編集と同じ外側の gate に参加する（[共通スキルの編集](sandbox-api-skills.md#共通スキルの編集v1skillsfile)）。共通の外だけを触る要求は直列化しない。`write` / `edit` の書き込み範囲（workdir と `<root>/.agents/skills`）はこれらより狭く、`POST /v1/dirs` / `POST /v1/files/rename` / `POST /v1/files/move` / `POST /v1/files/upload` 自体は root 配下ならどこへでも書ける（BFF の添付・プロジェクト作成・設定画面が使う）

## `DELETE /v1/dirs`

root 相対のディレクトリを消す。既定は空ディレクトリだけで、`recursive` が正確に文字列 `true` のときだけ配下ごと消す。成功は本文なしの 204。

```
DELETE /v1/dirs?path=uploads/3a7bfba36f&recursive=true
```

- `recursive` は完全一致だけを再帰として扱う。省略は空ディレクトリのみ（`rmdir`）で、非空なら 400（`Directory is not empty: …`）。部分削除は起きない。`false` / `1` / `TRUE` / 空 / 重複（`recursive=true&recursive=true` など）は 400 で、何も消さない
- パスの検証は [`DELETE /v1/files`](sandbox-api-files.md#delete-v1files) と同じ形（親を realpath、最終要素を `lstat`）。`""` / `"."` はワークスペース root、`".."` と末尾 `/` は削除対象の名前を表さない形式として 400。root 外へ解決される指定は 400（200 相当の別名で root 内へ解決する経由は [`GET /v1/files`](sandbox-api-files.md#get-v1files) と同じ）
- 消せるのはディレクトリだけ。通常ファイルと特殊ファイルは 400（`Not a directory: …`）。実在しないパスは 404
- 削除対象そのものが symlink なら 400（`Symbolic links cannot be deleted: …`。リンク自身も消さない）。削除対象の親が root 内の symlink なら、一覧・ファイル削除と同じく辿った先のディレクトリを消す
- 再帰削除は `fs.rm(target, { recursive: true })`。**配下の symlink は辿らず、リンクだけを unlink してリンク先は残す**（`rm -rf` と同じ）。件数の上限は設けない
- `lstat` の直後に他の実行が消した `ENOENT` は成功（204）にする（既存のファイル削除と同じ）
- 入力検証は**競合がない場合**の契約。親を realpath し最終要素を `lstat` した後に祖先が rename + symlink へ差し替えられると、`fs.rm` が root 外を消し得る（TOCTOU）。Node に fd 相対の削除が無く、完全な防御は入れない。既存のファイル削除と同クラスだが、再帰では被害が subtree に広がる点が違う

## `POST /v1/executions/:id/cancel`

実行中のツール（`start` で払い出された `executionId`）を中断する。SDK ツールへ `AbortSignal` が伝わり、bash は子プロセスを殺して `Command aborted` エラーになる。実行が無い場合は 404。

## 環境変数

| 変数 | サービス | 説明 |
| --- | --- | --- |
| `PI_SANDBOX_URL` | BFF | ツール API の到達先（例: `http://u7agent-sandbox:9418`）。未設定ならセッション作成を 503 で拒否 |
| `PI_SANDBOX_TOKEN` | BFF + サンドボックス | Bearer トークン（16 文字以上）。LLM 認証情報とは別の値。サンドボックス内では子プロセスへ継承しない |
| `PI_SANDBOX_CWD` | サンドボックス | ツール実行の既定 cwd（既定 `/workspace`）。ホスト実行では書込み可能なディレクトリを指定し、BFF の `PI_APP_CWD` と同じパスへ揃える |
| `SANDBOX_PORT` | サンドボックス | ツール API のポート（既定 9418。ホストへ publish しない）。8080 はユーザーへ見せる serve 用、18000–18099 はエージェントの自己デバッグ用 serve 用に予約 |
| `SANDBOX_HOST` | サンドボックス | bind アドレス（既定 `0.0.0.0`）。ローカルでは `127.0.0.1` を指定して LAN へ公開しない（Docker の別コンテナ構成では `0.0.0.0` のまま） |

BFF 側の環境変数（`PI_APP_CWD` / `PI_SESSION_STORE` / `PI_THINKING` / `PORT` / `HOST` / `PI_SECRET_ENV_VARS`）は [.env.example](../.env.example) を参照する。
