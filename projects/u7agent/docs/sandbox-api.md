# サンドボックス内部 API と環境変数

BFF が作業用ツール（`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`）の実行、作業領域の一覧取得、ファイルスキルの発見を委譲する内部API。ブラウザから直接呼ぶAPIではなく、`AppType` には含まれない。ホストへ公開せず、BFF ⇄ サンドボックスの内部ネットワークのみで到達する。設計の背景は [sandbox.md](sandbox.md) を参照する。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/healthz` | 無認証。Compose healthcheck 用。`{ ok, tools, cwd, runningExecutions }` |
| GET | `/v1/runtime/info` | 実行環境の診断（認証必須・読み取り専用）。[実行環境の診断](#get-v1runtimeinfo) |
| GET | `/v1/procs/listeners` | 待受ソケットと所有 PID の観測（単一ポート / レンジ。認証必須・読み取り専用）。[待受プロセスの観測](#get-v1procslisteners) |
| GET | `/v1/files` | 作業領域の一覧（JSON）。`?path=<root 相対>` |
| GET | `/v1/files/git` | 作業フォルダが属する repo のブランチ（JSON）。`?path=<root 相対>` |
| GET | `/v1/skills` | ファイルスキル（`SKILL.md`）の発見（JSON）。`?dir=<root 相対>` |
| GET | `/v1/skills/export` | `.agents/skills` の ZIP 持ち出し（ストリーム）。[スキルの持ち出し / 取り込み](#スキルの持ち出し--取り込み) |
| GET | `/v1/skills/export/check` | 持ち出しの見積り（JSON）。上限と `.git` の除外は export と同じ |
| POST | `/v1/skills/import` | `.agents/skills` の ZIP 取り込み（raw 本文）。`?dryRun=true` / `?replace=<名前>`（繰り返し可） |
| GET | `/v1/skills/file` | 共通スキル 1 件の編集内容（JSON）。`?relativePath=<root 相対>` |
| POST | `/v1/skills/file` | 共通スキルの新規作成。`{ name, description, body }` |
| PATCH | `/v1/skills/file` | 共通スキルの保存。`{ relativePath, fileVersion, description, body }` |
| GET | `/v1/skills/file/delete-preview` | 削除する専用フォルダ・付随ファイル・`treeVersion`。`?relativePath=<root 相対>` |
| DELETE | `/v1/skills/file` | 専用フォルダの削除。`?relativePath=<root 相対>&treeVersion=<hex>` |
| DELETE | `/v1/files` | 通常ファイルの削除。`?path=<root 相対>`。成功は本文なしの 204 |
| POST | `/v1/files/rename` | エントリ（ファイル / ディレクトリ）のリネーム。`{ path, name }` |
| POST | `/v1/files/move` | エントリ（ファイル / ディレクトリ）を別の親へ移動。`{ from, to }` |
| GET | `/v1/files/preview` | UTF-8テキストの取得。`?path=<root 相対>`。上限・応答は [api.md](api.md#テキストプレビュー) を参照 |
| GET | `/v1/files/raw` | 画像 + 音声の生配信。`?path=<root 相対>`。応答ヘッダは [api.md](api.md#画像配信raw) を参照 |
| GET | `/v1/files/download` | 通常ファイルは生バイト、ディレクトリは ZIP（ストリーム）。`?path=<root 相対>&exclude=<名前>`（繰り返し可） |
| GET | `/v1/files/download/check` | ダウンロードの見積り（JSON）。除外 / 上限の判定は download と同じ（`exclude` も共通） |
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
- 作業領域へ書き込む API は `POST /v1/dirs` / `POST /v1/files/rename` / `POST /v1/files/move` / `POST /v1/files/upload` / `DELETE /v1/files` / `DELETE /v1/dirs` で、`GET /v1/files` は読み取り専用。これらのうち共通スキル置き場（とその祖先、または共通へ出入りする対象）を触る要求は、共通スキルの編集と同じ外側の gate に参加する（後述）。共通の外だけを触る要求は直列化しない。`write` / `edit` の書き込み範囲（workdir と `<root>/.agents/skills`）はこれらより狭く、`POST /v1/dirs` / `POST /v1/files/rename` / `POST /v1/files/move` / `POST /v1/files/upload` 自体は root 配下ならどこへでも書ける（BFF の添付・プロジェクト作成・設定画面が使う）

## `DELETE /v1/dirs`

root 相対のディレクトリを消す。既定は空ディレクトリだけで、`recursive` が正確に文字列 `true` のときだけ配下ごと消す。成功は本文なしの 204。

```
DELETE /v1/dirs?path=uploads/3a7bfba36f&recursive=true
```

- `recursive` は完全一致だけを再帰として扱う。省略は空ディレクトリのみ（`rmdir`）で、非空なら 400（`Directory is not empty: …`）。部分削除は起きない。`false` / `1` / `TRUE` / 空 / 重複（`recursive=true&recursive=true` など）は 400 で、何も消さない
- パスの検証は [`DELETE /v1/files`](#delete-v1files) と同じ形（親を realpath、最終要素を `lstat`）。`""` / `"."` はワークスペース root、`".."` と末尾 `/` は削除対象の名前を表さない形式として 400。root 外へ解決される指定は 400（200 相当の別名で root 内へ解決する経由は [`GET /v1/files`](#get-v1files) と同じ）
- 消せるのはディレクトリだけ。通常ファイルと特殊ファイルは 400（`Not a directory: …`）。実在しないパスは 404
- 削除対象そのものが symlink なら 400（`Symbolic links cannot be deleted: …`。リンク自身も消さない）。削除対象の親が root 内の symlink なら、一覧・ファイル削除と同じく辿った先のディレクトリを消す
- 再帰削除は `fs.rm(target, { recursive: true })`。**配下の symlink は辿らず、リンクだけを unlink してリンク先は残す**（`rm -rf` と同じ）。件数の上限は設けない
- `lstat` の直後に他の実行が消した `ENOENT` は成功（204）にする（既存のファイル削除と同じ）
- 入力検証は**競合がない場合**の契約。親を realpath し最終要素を `lstat` した後に祖先が rename + symlink へ差し替えられると、`fs.rm` が root 外を消し得る（TOCTOU）。Node に fd 相対の削除が無く、完全な防御は入れない。既存のファイル削除と同クラスだが、再帰では被害が subtree に広がる点が違う

## `POST /v1/files/upload`

選択時のファイル追加。本文は JSON ではなく raw バイト列で受け、`dir` 配下へストリームで書く。作成した実ファイルの root 相対の正規化パスを返す。

```
POST /v1/files/upload?dir=uploads&name=photo.png
<body: ファイルのバイト列>
```

```json
// response (201)
{ "path": "uploads/photo-1.png", "name": "photo-1.png", "renamed": true, "size": 12345 }
```

- `name` は basename のみ。空・`.`・`..`・`/`・`\`・制御文字・200 文字超は 400（`SANDBOX_MAX_ENTRY_NAME_LENGTH`。`POST /v1/files/rename` の `name` も同じ規則）。`dir` は `POST /v1/dirs` と同じ規則で root 外を拒否し、無ければ `mkdir -p` で作る
- 書き込みは `<dir>/.pi-upload-<uuid>.part` へ行い、バイト数を数えて上限（100 MiB）を超えたら 413 にして temp を削除する。本文が途切れたときも temp を残さない
- 完成後は `link(2)` で排他作成し、`EEXIST` なら `name-1.ext` → `name-2.ext` …（最大 100 回、以降は乱数 suffix）へ進める。**既存ファイルは決して上書きしない**（並行アップロードでも衝突しない）
- 上限は 1 ファイル 100 MiB（`SANDBOX_MAX_UPLOAD_BYTES`）とファイル名 200 文字。`maxUploadBytes` オプションでテスト時に小さくできる

## `GET /v1/files/handoff`

引き継ぎメモ（作業フォルダ直下の `HANDOFF.md`）専用の読み書き。BFF の会話の引き継ぎ（[api-sessions.md](api-sessions.md#post-apisessionsidmove)）だけが使う。プレビュー API とは別の入口にし、**上限の値を分けて共有しない**（プレビューの上限を変えても引き継ぎの契約が動かないように）。

```json
// GET response (200)
{ "text": "# 引き継ぎメモ …" }
// POST request
{ "path": "work/HANDOFF.md", "section": "# 引き継ぎメモ …\n\nこの続きをお願いします。\n\n", "dedupeKey": "…" }
// POST response (200)
{ "path": "work/HANDOFF.md", "written": true, "created": false }
// POST /v1/files/handoff/rollback request
{ "path": "work/HANDOFF.md", "expected": "# 引き継ぎメモ …" }
// POST /v1/files/handoff/rollback response (200)
{ "deleted": true }
```

- 読取りは 2 MiB 超・UTF-8 でない・制御文字を含むバイナリを 400 で拒む。実在しないファイルは 404、root 外・symlink 経由の root 外は 400。**最終要素の symlink は読取りも拒む**（realpath で実体に解決して読むと、書込みが拒むリンクを正常なメモとして下準備が通してしまう）
- **不存在として扱うのは最終要素の `lstat` が `ENOENT` のときだけ**。検索権限の無いディレクトリ（`EACCES`）など他の失敗は 400 で返す（404 = 新規作成として下準備を抜けさせない。#2059 §4 の「404 のときだけ新規とし、読み取り不能を空の本文として扱わない」）
- 書込みは**読んでから書くまでを実パス単位の排他の中で行い**、一時ファイル + `rename` で原子的にする（同じ作業フォルダを共有する別の会話の同時追記でも両方の節が残る）。既存の本文は解釈せず、**新しい節を先頭に置いて後ろへそのまま残す**
- `dedupeKey` がファイルの**先頭行に含まれるときは何も書かない**（`written: false`）。BFF は節の材料から決まるハッシュを渡し、再試行・再起動でメモが二重にならないようにする
- 既存が symlink のときは 400（読む前に最終要素を `lstat` で見て、root 外を読まない・書かない）。`section` 単体が 2 MiB を超えるときは 400。**排他の中で読み直した後にも追記後の全文サイズを判定する**（下準備の判定の後に他の追記が入っても、全文を上限に収める）
- 親ディレクトリは実在が必要（`POST /v1/files/upload` と違い作成しない。呼び出し側の作業フォルダが先に作られている）

## `POST /v1/files/handoff`

`GET` と同じ契約の書込み（読取りと書込みの両方の説明は上の節にまとめる）。

## `POST /v1/files/handoff/rollback`

新規作成したメモの取り消し（条件付き削除）。内容が `expected` と一致するときだけ削除し、`{ deleted }` を返す。**照合から削除までを追記と同じ実パス排他の中で行う**ため、間に他の会話の追記が入っていれば消さずに `deleted: false` を返す（BFF の確定前 rollback 専用で、他の追記や編集を巻き戻さない）。内容を読めない（上限・形式・読取り失敗）ときも消さずに `deleted: false` を返す。

## `POST /v1/files/rename`

root 相対のエントリ（通常ファイル / ディレクトリ）の名前を変える。本文は `{ path, name }` で、`name` は 1 セグメントの新しい名前。応答は名前を変えたエントリの root 相対の正規化パス（root は `"."`）。親をまたぐ移動は `POST /v1/files/move` を使う。

```
POST /v1/files/rename
{ "path": "uploads/nested/photo.png", "name": "shot.png" }

// response (200)
{ "path": "uploads/nested/shot.png", "name": "shot.png" }
```

- `name` の検証は `POST /v1/files/upload` と同じ（空・`.`・`..`・`/`・`\`・制御文字・200 文字超は 400 `Invalid name: …`）。`path` の検証は [`DELETE /v1/files`](#delete-v1files) と同じ形（親を realpath、最終要素を `lstat`）。`""` / `"."` / `".."` / 末尾 `/` はエントリを表さない形式として 400、root 外へ解決される指定は 400（200 相当の別名で root 内へ解決する経由は [`GET /v1/files`](#get-v1files) と同じ）
- 動かせるのは通常ファイルとディレクトリだけ。実在しないパスは 404、FIFO などの特殊ファイルは 400（`Not a file or directory: …`）
- **symlink は 400（`Symbolic links cannot be renamed: …`）**。realpath で実体に解決してから `rename(2)` すると、root 内のリンクが指す root 外を動かせてしまうため、要求パスの最終要素だけを `lstat` で見て symlink なら動かさない（リンクだけを動かす挙動は提供しない）
- 改名先に既存のエントリがあるときは 409（`Already exists: …`）で、何も変えない（上書きも自動採番もしない）。ただし **`lstat` と `realpath` が同じ実体を指す場合は通す**ため、大文字小文字だけの変更は許す（case-insensitive な fs では `lstat` が既存を返す）。改名先が symlink のときは実体が同じでも上書きしない（別のディレクトリエントリのため 409）
- 親が root 内の symlink なら、一覧・削除と同じく辿った先のディレクトリで名前を変える。応答の `path` は辿った先の実パス基準（`GET /v1/files` の `path` と同じ規則）
- 入力検証は**競合がない場合**の契約。`lstat` の後に同じ名前が作られると `rename(2)` が上書きする（Node に no-replace の rename が無い。単一ユーザーでエージェントと同時に触った場合のみ）。fd 相対の rename が Node に無いため完全な防御は入れない（[`DELETE /v1/dirs`](#delete-v1dirs) の TOCTOU と同じクラス）
- 400 / 404 / 409 の文言はサンドボックスが返し、BFF はそのままクライアントへ返す（[api.md](api.md#リネーム)）

## `POST /v1/files/move`

root 相対のエントリ（通常ファイル / ディレクトリ）を別の親へ移す。本文は `{ from, to }`（どちらも root 相対）で、応答は移動後のエントリの root 相対の正規化パス（root は `"."`）。

```
POST /v1/files/move
{ "from": "uploads/nested/photo.png", "to": "projects/shot.png" }

// response (200)
{ "path": "projects/shot.png" }
```

- 検証は `POST /v1/files/rename` / `DELETE /v1/files` と同じ枠組み（移動元と移動先の親を realpath、最終要素を `lstat` / 1 セグメント名として検証）。`from` が `""` / `"."` / `".."` / 末尾 `/` なら 400（`Not a file or directory: …`）、`to` の最終要素が `isValidEntryName` を通らなければ 400（`Invalid name: …` で示すのは `to` の全体）
- 動かせるのは通常ファイルとディレクトリだけ。実在しない元は 404、FIFO などの特殊ファイルは 400（`Not a file or directory: …`）
- **symlink は 400（`Symbolic links cannot be moved: …`）**。realpath で実体に解決してから `rename(2)` すると、root 内のリンクが指す root 外を動かせてしまうため、移動元の最終要素だけを `lstat` で見て symlink なら動かさない（リンクだけを動かす挙動は提供しない）。移動元 / 移動先の親が root 外を指す symlink も 400
- 移動先が既存なら 409（`Already exists: …`）で、何も変えない（上書きもマージもしない）。ただし **`lstat` と `realpath` が同じ実体を指す場合は通す**（`POST /v1/files/rename` と同じ規則。移動先が symlink のときは実体が同じでも 409）
- 移動先の親は root 内の実在ディレクトリでなければならない（実在しない 404、ディレクトリでない 400）。呼び出し側が先に `POST /v1/dirs` で作ってから呼ぶ
- 移動は `rename(2)` 1 回で、同一ファイルシステム内では原子的。部分移動は起きない（別ファイルシステムをまたぐ移動は非ゴール）。ディレクトリ自身をその配下へ移す要求は `rename(2)` が `EINVAL` を返し 400（`Cannot move: …`）で、何も変えない
- 移動元 / 移動先の親が root 内の symlink なら、一覧・リネームと同じく辿った先の実ディレクトリで移動し、応答の `path` は辿った先の実パス基準（[`GET /v1/files`](#get-v1files) の `path` と同じ規則）
- 入力検証は**競合がない場合**の契約。`lstat` の後に同じ名前が作られると `rename(2)` が上書きする（[`POST /v1/files/rename`](#post-v1filesrename) と同じクラス）
- 400 / 404 / 409 の文言はサンドボックスが返し、BFF はそのままクライアントへ返す

## `GET /v1/files/raw`

root 相対の画像 / 音声を `createReadStream` でストリーム返却する。配信できる拡張子は画像が `png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`、音声が `mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac` だけで、それ以外（SVG / HTML / 動画 / フォント / 拡張子なし / dotfile）は 400 `Not a servable file: …`。root 外・実在しない・ディレクトリは通常のパス検証と同じ 400 / 404 になる。単一レンジの `Range` に対応し、HTML プレビューのアセット経路（`GET /api/files/html/<path>`）からも同じ応答を返す。

- 200: `Content-Type`（拡張子）/ `Content-Length` / `Accept-Ranges: bytes` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff`
- 206 / 416: 単一の `Range`（`bytes=<start>-<end>` / `bytes=<start>-` / `bytes=-<suffix>`）を解釈し、満たせれば 206 + `Content-Range: bytes <start>-<end>/<size>`、解釈できて満たせないときだけ 416 + `Content-Range: bytes */<size>`。解釈できない `Range`（構文不正 / `bytes` 以外の単位 / 複数レンジ）は無視して 200 を返す。マルチパートは返さない。契約は [api.md](api.md#画像配信raw) を参照
- 413: サイズが上限（100 MiB）を超える（`{ error: "File is too large (max … bytes)" }` の JSON を返す。ファイルの本文と `Content-Length` は送出しない）
- BFF はこの応答をそのまま中継し、本文を JSON に載せない。**公開 `GET /api/files/raw` も画像と音声の両方を渡し**、同じ allowlist と `Range` の契約を見る（[api.md](api.md#画像配信raw)）

## `GET /v1/files/download`

root 相対のエントリを持ち出し用に配る。通常ファイルは `createReadStream` で生バイトのまま、ディレクトリは**自前のストリーミング ZIP ライタ**（`server/src/sandbox/zip.ts`）で配る。`path` 省略（`""`）/ `"."` / 末尾区切りのみはワークスペース root を ZIP にし、保存名は `<フォルダ名>.zip`（root は解決後の実ディレクトリ名）。

```
GET /v1/files/download?path=src
GET /v1/files/download?path=src&exclude=node_modules&exclude=dist
Content-Type: application/zip
Content-Disposition: attachment; filename*=UTF-8''src.zip
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

- **`zip` バイナリを spawn しない**。`pnpm dev` はサンドボックスをホストで起動するため `zip` / `unzip` が無く、info-zip のエントリ名エンコーディングはロケール依存で日本語名を保証できないため、`node:zlib` の `createDeflateRaw` + CRC32 で自前実装する（外部依存も足さない）
  - 名前は UTF-8 で書き、general purpose bit 11 を立てる。サイズを事前に確定できないため data descriptor（bit 3）で CRC / サイズを本文の後に置く
  - 既に圧縮済みの拡張子（`png` / `jpg` / `zip` / `pdf` / `mp3` / `woff2` など）は store（無圧縮）で入れる。それ以外は deflate
  - **Zip64 は書かない**。そのために下記の上限を本文送出前に検査する（[上限](#get-v1filesdownload-の上限)）
- 検証は削除 / リネームと同じ枠組み（親を realpath → 最終要素は `lstat`）で、**symlink は辿らず 400**（リンク先の内容を配ると root 内に閉じる検証を迂回する）。最終要素の `.` / `..` も 400
- **除外規則**（`server/src/archive-rules.ts`）はベース名の完全一致・全階層で、ファイルとディレクトリのどちらにも当てる。除外した名前は `check` の `skipped` に実効の規則順で返す
- **除外名はリクエストごとに `exclude` query の繰り返しで受ける**（サンドボックスは設定を持たない。設定の保存先は BFF のアプリデータ SQLite。[persistence.md](persistence.md#アプリデータsqlite)）
  - **param なし = BFF 未指定**として既定の一覧（`DEFAULT_ARCHIVE_EXCLUDE_NAMES`）を使う（直叩きでも安全側）
  - **値があればその一覧が正**で、空値だけの指定（`?exclude=`）は「除外なし」を表す（未設定と明示空を区別するマーカー）
  - 値は空値を落とし、重複は先勝ちで畳む。1 セグメント名として不正（空・`.`・`..`・区切り・制御文字・200 文字超）または 100 件超は走査の前に 400（`Invalid archive exclude name: <name>` / `Too many archive exclude names (max 100)`）
- **symlink はエントリにも入れない**。socket / fifo / device などの特殊ファイルも入れない
- **空ディレクトリは末尾 `/` のエントリ**として入れる（入れないと展開後に消える）。ZIP の中身は**フォルダ直下をルートに置く**（フォルダ自身は前置しない）
- **エントリの更新時刻**: ファイルは元ファイルの mtime を書く（ZIP の DOS 時刻はローカル時刻・2 秒粒度で、1980 年より前と 2107 年より先は年だけを丸める）。ディレクトリのエントリは walk が stat を持たないため ZIP を生成した時刻になる
- 200 のヘッダ: ファイルは `application/octet-stream` + `Content-Length`、ZIP は `application/zip`（**`Content-Length` を付けない**）。どちらも `Content-Disposition: attachment; filename*=UTF-8''<percent encoded>` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff`
- 400 / 404 / 413: 除外名のディレクトリそのもの・root 外・形式不正・symlink / ファイルでもディレクトリでもない（400）、不存在（404）、サイズ / 件数の上限超過（413）。413 の文言は単体ファイルと ZIP で 1 本（`Download is too large (max … bytes)`）
- BFF はこの応答をストリーム中継し、本文を JSON に載せない（[api.md](api.md#ダウンロード)）

### `GET /v1/files/download` の上限

| 上限 | 値 | 定数 | 理由 |
| --- | --- | --- | --- |
| 含めるファイルの合計サイズ | 100 MiB | `SANDBOX_MAX_ARCHIVE_BYTES`（`SANDBOX_MAX_UPLOAD_BYTES` と同値） | Zip64 を書かない（ローカルヘッダ / 中央ディレクトリのサイズは 4 GiB 未満） |
| ZIP のエントリ数 | 10,000 | `SANDBOX_MAX_ARCHIVE_ENTRIES` | EOCD の件数が 16bit（65,535） |

事前 walk（`server/src/sandbox/archive.ts`）がヘッダを送る前に上限を検査するため、超過は「切れた zip」ではなく 413 になる。**単体ファイルも同じ 100 MiB** で拒否する（Zip64 を書かずに 4 GiB 級のファイルを 32bit フィールドで書くと壊れるため）。

限界は [file-preview.md](file-preview.md#既知の制限ダウンロード) を参照（ストリーム中の失敗で切れた zip になる / 事前 walk と圧縮の間の増減は見積りの近似になる）。

### `GET /v1/files/download/check`

`download` と同じ計画（解決 + walk）から見積りだけを返す。ブラウザに生 JSON を見せずに理由をツリー内へ出すために UI が先に呼ぶ。`exclude` query の扱い（未指定 = 既定 / 空値 = 除外なし / 検証）は `download` と共通。

```json
// GET /v1/files/download/check?path=src (200)
{
  "kind": "archive",
  "name": "src.zip",
  "bytes": 1042263,
  "entries": 209,
  "skipped": ["node_modules", "dist"]
}
```

- `kind` は `file` / `archive`。`name` は保存名（ファイルはその名前、ZIP は `<フォルダ名>.zip`）、`bytes` は含めるファイルの合計サイズ（単体ファイルはそのサイズ）、`entries` は ZIP のエントリ数（単体ファイルは 0）、`skipped` は除外規則で実際に落ちた名前（重複なし・実効の規則順）
- エラーは `download` と同じ分類（400 / 404 / 413）で、本文は `{ error }`
- walk は download と共通なので、見積りと実際の内容は同じ判定を通る

## `POST /v1/executions/:id/cancel`

実行中のツール（`start` で払い出された `executionId`）を中断する。SDK ツールへ `AbortSignal` が伝わり、bash は子プロセスを殺して `Command aborted` エラーになる。実行が無い場合は 404。

## `GET /v1/files`

作業領域（root = `PI_SANDBOX_CWD`）の一覧を JSON で返す。`ls` ツールの戻り値は LLM 向けのテキスト（改行区切り・ディレクトリ判定は接尾辞）なので、UI のデータソースとして別契約にする。一覧は読み取り専用で、作業領域への書き込みは `POST /v1/dirs` / `POST /v1/files/rename` / `POST /v1/files/move` / `POST /v1/files/upload` / `DELETE /v1/files` / `DELETE /v1/dirs` だけ。移動（親ディレクトリの変更）は `POST /v1/files/move` が担う。

`path` は root 相対。省略時は root。解決と検証はツール実行の `cwd` と同じ関数を使う。

```json
{
  "path": "src",
  "entries": [
    { "name": "client", "type": "dir", "mtime": 1700000000000 },
    { "name": "README.md", "type": "file", "size": 1234, "mtime": 1700000000000 }
  ],
  "truncated": false
}
```

- `path` は一覧した実ディレクトリの root 相対の正規化パス（root は `"."`）。要求が symlink を経由する場合は辿った先のパスになる（`type` と同じく実体で表す）。root 内外の判定は「`..` の有無」ではなく「realpath で解決した実パスが root 内か」で行う
  - `..` は symlink を辿った後に適用する（カーネルと同じ解決順）。したがって root 内の symlink が root 外を指す場合、`linkOutside/..` は root ではなく参照先の親（root 外）へ解決する
  - `dir/..` のように解決後に root 内へ収まる要求は 200
  - root の外にある symlink が root 内を指す場合（例: root の親に置いた `link-in -> root` への `../link-in`）も 200。要求自体は root の外を指していてもよい
  - 実在する要求で解決後の実パスが root 外なら 400（`outside the workspace`）
  - 実在しない要求（realpath が `ENOENT` / `ENOTDIR`）だけは lexical な位置で判定し、root 外を指すなら 400（404 にしない）、root 内を指すなら 404
- `type` は `file` / `dir`。symlink は辿った先（stat 相当）の実体種別で、ディレクトリ以外（ソケット等）は `file` に寄せる。`size` は実体を stat できたファイルにだけ、`mtime`（epoch ms）は実体を stat できた**エントリ**（ディレクトリを含む）に付ける。壊れた symlink にはどちらも付かない。`size` をディレクトリに付けないのは、その値（ノードのサイズ）がファイルの内容量を表さないため。規則は symlink は辿った先（`stat`）、それ以外は `lstat` で、種別判定に使った `stat` を `mtime` に再利用する
- `symlink: true` は `lstat` が symlink だったエントリ。root 内を指す symlink は普通に開ける。root 外を指す symlink も一覧には出る（`symlink: true`）が、その位置を `path` に指定すると 400 になる。一覧は symlink の指す先を列挙しない（root 配下だけを返す）
- 並び順はディレクトリ先 → ファイル、各グループ内は大文字小文字を無視した昇順。client は再ソートしない
- hidden file（dotfile）も返す。フィルタは持たない
- 1 ディレクトリ 500 件（SDK の `ls` ツールの既定上限と同じ）で打ち切り、`truncated: true` を返す
- 400: `path` が root 外へ解決される / 不正、ディレクトリでない（`Not a directory: …`）、読み取り不能。404: 実在しない（`Path not found: …`）。文言は `ls` ツールに寄せる
- root 外の拒否は URL 経由の不正参照を防ぐ入力検証で、サンドボックスが読める範囲を絞るものではない（サンドボックスは元々 `bash` / `read` を実行でき、読み取り範囲は変わらない）

## `GET /v1/files/git`

`path`（root 相対、省略時は root）のディレクトリが属する repo の HEAD を返す。読み取り専用で、`git` の子プロセスを起動するのはサンドボックスだけ（BFF はプロセスを起こさない）。**repo の外と `git` の無い環境はエラーにせず `branch: null`** を返す。

```json
{ "branch": "feature/x" }
```

- `branch` は `git -C <path> symbolic-ref --short -q HEAD` の 1 行目（初回コミット前の repo でもブランチ名を返す）。detached HEAD は指すブランチが無いため `rev-parse --short HEAD` の短縮 SHA になる。それも失敗すれば `null`
- `path` の解決と検証は [`GET /v1/files`](#get-v1files) と同じ（root 外 400 / 実在しない 404 / ディレクトリ以外 400）。git は親ディレクトリへ辿って repo を見つけるため、root が repo の配下ならその repo のブランチを答える
- 実行の制限は[実行環境の診断](#get-v1runtimeinfo)と同じ: 信頼ディレクトリ（`RUNTIME_PROBE_PATH_DIRS`）で解決した `git` の実体、固定引数（shell 無し）、`process.env` を継承しない最小環境（`HOME` は存在しない固定値）。cwd は `/` で、対象ディレクトリは `-C` だけに渡す。stdout + stderr の合計で 4 KiB、遅くとも 2 秒（2 コマンドの合計）で打ち切る
  - 値に使うのは **stdout の 1 行目だけ**。stderr は読み切って上限に数えるだけで、`core.fsyncObjectFiles` 非推奨のような**終了コード 0 の警告をブランチ名に混ぜない**
- `git` が無い / 期限超過 / 出力上限 / repo の外は、理由を返さず `branch: null` に寄せる。ブランチは一覧の表示を止める情報ではないので、UI はチップを出さないだけにする

## `GET /v1/files/stat`

`path`（root 相対、省略時は root）が通常ファイルとして実在するかを JSON で返す。**本文は読まない**（テキストプレビューの入力検証を存在の判定に混ぜない）。BFF の `GET /api/files/stat` がこの API を呼び、参照を開く前の確認に使う（[api.md](api.md#存在確認)）。

```json
// response
{ "path": "src/index.ts" }
```

- 200: 通常ファイルとして実在する。`path` は realpath を root 相対へ写した正規化パス（root は `"."`。symlink を経由した要求は辿った先）。解決と検証は `GET /v1/files` と同じ（root 内外は実パスで判定）
- 404: 実在しない（`Path not found: …`。壊れた symlink を含む）
- 400: `path` が不正（`Invalid path: …`）/ root 外（`Path outside the workspace: …`）/ 通常ファイル以外（ディレクトリ・FIFO などの特殊ファイルは `Not a regular file: …`）。実在の確認に使わせないための拒否で、不存在（404）とは別の応答
- 401: Bearer トークンが他と同じく必要（無効・欠落）
- バイナリ・UTF-8 不正・上限超過のファイルも 200 になる（本文を読まないため。プレビューは `GET /v1/files/preview` の 400）

## `GET /v1/skills`

root 相対のディレクトリ配下のファイルスキル（`SKILL.md`）を JSON で返す。BFF は発見結果を SDK の `skillsOverride` へ渡し、モデルには本文ではなく `path` を渡す（本文は `read` 時点のファイル内容。ファイルスキルの扱いは [persistence.md](persistence.md)）。

```
GET /v1/skills?dir=.agents/skills
```

```json
// response
{
  "skills": [
    {
      "name": "example",
      "description": "例のスキル",
      "path": "/workspace/.agents/skills/example/SKILL.md",
      "disableModelInvocation": false
    }
  ]
}
```

- 走査規則（hidden と `node_modules` のスキップ、`.gitignore` / `.ignore` / `.fdignore`、再帰、frontmatter 検証）は SDK の `loadSkillsFromDir` に委譲する。MVP は `SKILL.md` だけを対象にし、SDK が直下で読む非 `SKILL.md` の `.md` は応答から落とす
- `dir` の検証は `GET /v1/files` と同じ（root 外・symlink 脱出は 400、実在しないディレクトリは 404、ディレクトリ以外は 400）
- SDK は子ディレクトリと `SKILL.md` の symlink を辿るため、**realpath が root 内になるスキルだけ**を返す。root 外へ解決するものと壊れた symlink は落とす。path は realpath に揃え、同じ実体へ解決する重複（symlink 経由・循環リンク）は 1 件に畳む
- **走査は専用スレッド（worker）で実行し、期限（既定 2 秒）で打ち切る**。`loadSkillsFromDir` は同じ実体へ複数の経路で到達する形（自己参照する symlink が 2 本あるなど）で走査回数が指数的に増え、同期実行ではサンドボックス本体を塞ぐため。期限切れは 504（`スキルの走査が期限 …`）で、worker は捨てて次の要求で作り直す。期限の間も他のリクエストは処理される（worker は起動時から使い回し、初回だけ SDK の import 分を待つ）
- `path` は realpath（root 内の絶対パス）で、本文は返さない。`disableModelInvocation` は frontmatter の `disable-model-invocation` をそのまま写す
- 組み込みスキル（skill-creator など）は BFF の同梱物なので、この API は関与しない（仮想パス `<root>/.u7agent/builtin-skills/...` への `read` も BFF が横取りし、サンドボックスへは来ない。[api-catalog.md](api-catalog.md#組み込みスキル)）
- 読み取り専用で、ファイルは変更しない

## 共通スキルの編集（`/v1/skills/file`）

共通スキル（`<PI_SANDBOX_CWD>/.agents/skills`）だけを対象にした GUI の編集 API。パス・版・スキルとしての検証はサンドボックス側で完結し、BFF は要求をそのまま渡して応答の形を検証するだけにする（BFF の API は [api-catalog.md](api-catalog.md#ファイルスキルagentsskills) を正とする）。

- `GET /v1/skills/file?relativePath=` は `name` / `description` / **trim していない** `body` / `relativePath` / `fileVersion` / `editable` と、保存できないときだけ `reason` を返す。`name` / `description` は SDK の発見結果（`name` が無いときは親ディレクトリ名）。`body` は frontmatter を除いた本文（改行は LF に正規化し、先頭の閉じ行を終わらせた改行は frontmatter の境界なので含めない。本文中の改行と前後の空白はそのまま扱う）。発見できない内容（`.gitignore` で除外、frontmatter が読めない）は `editable: false` と理由を返す
- `POST /v1/skills/file` は `{ name, description, body }` を受け、`<skills>/<name>/SKILL.md` をサーバー側で組み立てる。既存ディレクトリと既存の同名共通スキルは 409（上書きも連番化もしない。組み込みとの同名は既存の優先順位に委ねる）。`PATCH` は `{ relativePath, fileVersion, description, body }` を受け、`name` の変更要求は受け付けない。`DELETE` は body を読まずクエリ（`relativePath` / `treeVersion`）だけで受ける
- **保存は元のテキストの変更箇所だけを差し替える**（`server/src/sandbox/skill-edit.ts`）。frontmatter の境界は SDK と同じ BOM / CRLF / CR 正規化後の先頭 `---` と最初の `\n---` で、`description` の値と本文の source range だけを置き換える。本文の書き出しでは閉じ行の改行を必ず付け直す（読み出しで 1 つ落とした分を戻すので、本文の先頭空行を消して保存しても `---` と本文が癒着しない）。YAML 全体の再生成はしないため、未知キー・コメント・キー順・`name`・`disable-model-invocation`・BOM・未変更部分の改行と空白は元のまま残る。変更が無ければファイルを書き換えず、成功応答は現在の `fileVersion` を返す。安全に差し替えられない frontmatter（YAML が壊れている、ルートがマップでない、`description` に anchor がある、description の値がマップ / シーケンス）は 400 と理由で拒否し、全文の書き換えはしない
- 新規だけは `name` / `description` / 本文の固定順・LF で作り、文字列は YAML の二重引用符スカラーとして安全に表現する。本文の書き出しは保存経路と同じ規則（閉じ行の改行を付ける）を使い、既存ファイルをこの形式へ自動変換しない
- 検証は SDK の `loadSkillsFromDir` を正とする。作成と保存の前に候補を一時ディレクトリで走査し、スキルとして読めることを確認する（新規は warning も拒否、既存の保存は変更前の診断に無い warning だけを拒否する。変更しない `name` や 1024 字超の `description` に由来する warning は本文だけの編集を妨げない）。公開後にも実際の発見一覧で対象パスと内容を確認し、確認できなければ自分の変更（同じ版のとき）だけを元に戻して 500 を返す
- 版は `fileVersion` = 元ファイルの**バイト列の SHA-256**（mtime は使わない）、`treeVersion` = 対象フォルダ全体のダイジェスト（相対パスをソートし、エントリ種別・通常ファイルの内容ハッシュ・symlink のリンク文字列を含める。隠しファイルと付随ファイルを除外せず、参照先は辿らない）。不一致は 409、対象が消えていれば 404 で、強制上書きと自動再送は無い。削除確認の走査は `SANDBOX_MAX_ARCHIVE_ENTRIES` / `SANDBOX_MAX_ARCHIVE_BYTES` で制限し、超過・読み取り不能は変更前に拒否する
- パスは workspace root 内であることに加え、root 相対の形が `<skills>/<name>/SKILL.md` で、最寄りの実在祖先の**実パス**も共通スキル置き場の内側であることを要求する（symlink・`..`・プロジェクト / 組み込み / root 外を拒否）。置き場直下の `SKILL.md` と hidden のディレクトリは専用フォルダを特定できないため扱わず、`SKILL.md` が symlink の削除も拒否する。削除は実パスのフォルダだけを `rm` し、symlink の参照先は辿らない
- **排他の順序は「共通スキル置き場の外側 gate → SDK のファイル隊列（`withFileMutationQueue`）」。** GUI の CRUD、共通の中へ解決する SDK `edit` / `write` の実行全体、共通（またはその祖先）を変更する / 共通へ出入りする既存のファイル変更 API を gate に参加させ、取得後にパスを再確認する。SDK の同じ隊列は外から二重に取得しない。排他は SDK と同様の順番待ちで、専用の待機 timeout を追加しない。観測できる abort は未開始なら変更前に拒否し、開始済みの IO が終わる前に解放しない
- 公開は同じディレクトリの一時ファイルからの `rename` で行う。**任意の bash と外部エディタはこの gate に参加しない**ため、版の再確認で観測した変更は拒否するが、比較と書き込みの間の外部プロセスによる競合まで完全な CAS としては保証しない
- 要求の上限は既存の JSON body の上限（`SANDBOX_MAX_BODY_BYTES`）で、超過は 413。GUI の保存経路は BFF 側の 64 KiB が先に効く

## スキルの持ち出し / 取り込み

`.agents/skills` 全体を 1 本の ZIP として持ち出し / 取り込みする。形式は既存のストリーミング ZIP ライタ（`server/src/sandbox/zip.ts`）に揃え、エントリ名は `.agents/skills` 相対（直下がスキルフォルダ）。manifest / version ファイルは置かず、frontmatter の未知キーも解釈せずバイトのまま運ぶ。BFF の API は [api-catalog.md](api-catalog.md#ファイルスキルagentsskills) を正とする。

### `GET /v1/skills/export`

- 対象は `<PI_SANDBOX_CWD>/.agents/skills` に固定する（`path` の query は受けない）。**利用者の除外設定（`archiveSettings.effectiveNames()`）は使わず**、`.git` だけを全階層・ベース名の完全一致で落とし、symlink はエントリに入れない
- 直下は **`SKILL.md` を直接持つディレクトリ**（`SKILL.md` が通常ファイル）だけを入れ、直下のファイルと `SKILL.md` を持たないディレクトリは入れない。配下は空ディレクトリを含めてそのまま入れる
- 保存名は `skills.zip`。応答は `application/zip` / `Content-Disposition: attachment; filename*=UTF-8''skills.zip` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` で、**`Content-Length` を付けない**（ストリーム）
- `.agents/skills` が無いときは 404。あるがスキル 0 件のときは空の ZIP を返し、`/check` は `entries: 0` を返す
- `GET /v1/skills/export/check` はダウンロードの `check` と同じ形（`kind` / `name` / `bytes` / `entries` / `skipped`）を返す。`skipped` には実際に落とした `.git` が入る
- 合計サイズ / エントリ数の上限はダウンロードと同じ値と文言を使い、ヘッダ送出前に 413 で断る。UI が出すのはこの 413 の理由で、除外の指定が無いため確認ダイアログは出さない

### `POST /v1/skills/import`

raw の ZIP 本文を受け、`?dryRun=true` で計画（何も変更しない）だけを返し、省略時は計画に従って適用する。`dryRun` は `true` の完全一致だけを dry run とし、`replace` は繰り返しで受け、保存名と同じ規則（`isValidEntryName`）で検証して重複を畳む。空値・不正な名前と、解釈できない `dryRun` は 400。

- ZIP の読み取りは自前実装（`server/src/sandbox/zip-read.ts`、中央ディレクトリを起点）。store / deflate だけを扱い、data descriptor（bit 3）の有無はどちらも受け、`unzip` バイナリに依存しない
- エントリ名は UTF-8 として厳密に読み、bit 11 が無い非 ASCII 名は拒否する。`..` / 絶対パス / `\` / 制御文字 / 空セグメントは名として受け付けない
- **構造不正は全体拒否**（`.agents/skills` に何も書かない）: zip slip、重複エントリ名、symlink / 特殊ファイルのエントリ、暗号化・Zip64・store / deflate 以外の圧縮、パスのいずれかのセグメントが `.git`、hidden の直下フォルダ、`SKILL.md` を持たない直下項目、上限超過、CRC-32 / サイズ（ローカルヘッダ・data descriptor・中央ディレクトリ・展開結果）の不一致、切り詰め
- **スキル個別の不正はそのスキルだけ** invalid（frontmatter が読めない / name 規則違反 / description の欠落・超過 / フォルダ名と `name` の不一致）。判定は SDK の `loadSkillsFromDir` を正とし、staging のスキル配下の診断が 1 件でもあれば invalid にする（新しいスキルの作成と同じ判定）。走査は staging のフォルダ自体に対して行い、`.gitignore` / `.ignore` / `.fdignore` も効かせる
- 上限は既存の `SANDBOX_MAX_UPLOAD_BYTES` / `SANDBOX_MAX_ARCHIVE_BYTES` / `SANDBOX_MAX_ARCHIVE_ENTRIES` を再利用し、import 専用の上限を作らない（受信本文はアップロード、展開後はダウンロードと同じ値）
- 一時データは `.agents/.import-<uuid>/`（受信 ZIP・staging・退避）に置き、rename を同じファイルシステムに閉じる。成功・失敗・中断（`AbortSignal`）のいずれでも消す
- 適用は**共通スキル置き場の gate の内側**で行う。置換対象の解決は既存の共通スキルの規則に揃え（realpath で `.agents/skills` の内側、`SKILL.md` が symlink のスキルは置換しない）、「staging で全件検証 → 置換対象を退避へ rename → 新フォルダを rename → 全件成功後に退避削除」の順に適用する。途中で失敗したら適用済みの分を逆順で戻す。書き込みは受信バイトのまま（`skill-edit.ts` を通さない）
- `replace` に無い conflict は取り込まず、`identical` は書き込みを省略し、`invalid` は常にスキップする。bundle に無い名前・既存に無い名前は無視する（何も作らず、何も消さない）。既存スキルの暗黙の削除・連番併存・部分マージはしない
- 応答は plan と apply で形が違う。plan は `{ skills: [{ name, status, reason? }], entries, bytes }`（`status` は `new` / `identical` / `conflict` / `invalid` で、`reason` は `invalid` のときだけ）。apply は `{ applied: [{ name, relativePath, fileVersion, replaced }], skipped: [{ name, reason }], entries, bytes }` で、`fileVersion` は取り込んだ `SKILL.md` のバイト列の SHA-256。`entries` / `bytes` は検証に使った ZIP の総エントリ数と展開後の総バイト数
- **任意の bash / 外部エディタは gate に参加しない**ため、適用中に外部プロセスが `.agents/skills` を触れば検出できない（既存の保存と同じ線引き）。プロセスが適用中に落ちると `.agents/.import-<uuid>/` が残り得る（隠しディレクトリなので SDK の走査対象外）
- BFF はこの応答を検証してそのまま返す。plan / apply とも一覧（`GET /api/skills/files`）は呼ばず、UI が結果の後に取り直す

## `DELETE /v1/files`

root 相対の通常ファイルを 1 つ消す。成功は本文なしの 204（ゴミ箱・undo は無く、同じ名前で再アップロードすると連番は付かない）。

- 消せるのは通常ファイルだけ。ディレクトリ・FIFO などの特殊ファイルは 400（`Not a regular file: …`）。`path` 省略・空・`.`（root 自身）や末尾が区切りのパスも同じ 400
- **symlink は 400（`Symbolic links cannot be deleted: …`）**。realpath で実体に解決してから消すと、root 内のリンクが指す root 外のファイルを消せてしまうため、要求パスの最終要素だけを `lstat` で見て symlink なら `unlink` しない（リンクだけを消す挙動は提供しない）
- 親ディレクトリは `GET /v1/files` と同じ解決（realpath → root 内外 → 実在 → ディレクトリ）を通す。要求パスの字句の `dirname` を native realpath へ渡すため、`..` は symlink を辿った後に適用される（一覧と同じ）。root 外を指す symlink ディレクトリ経由（`linkOutside/file.txt`）は 400、root 内を指す symlink ディレクトリ経由（`linkInside/file.txt`）は一覧と同じく消せる
- 400: root 外へ解決される / 不正 / 通常ファイル以外 / symlink。404: 実在しない（`Path not found: …`）

## `GET /v1/runtime/info`

サンドボックス自身の実行環境と、allowlist のうち実在したコマンドのバージョンを返す。BFF の `GET /api/runtime/environment` がこの API を呼び、状態コード付きの公開 DTO へ写す（[api.md](api.md#実行環境サンドボックス診断)）。

```json
// response
{
  "environment": {
    "os": "Debian GNU/Linux 13 (trixie)",
    "arch": "x86_64",
    "user": "node",
    "isRoot": false,
    "workspace": "/workspace"
  },
  "commands": [
    { "name": "curl", "version": "8.14.1" },
    { "name": "npm", "version": null }
  ],
  "landlock": { "state": "enabled", "abi": 6, "minAbi": 3 }
}
```

- `environment` は OS の名称と版（`/etc/os-release` の `PRETTY_NAME`。取れなければ `不明`）、正規化した CPU アーキテクチャ（`x86_64` / `aarch64` など）、実行ユーザー名、UID 0 で動いているか、ワークスペース root。環境変数の値・認証ファイル・ホストの情報は返さない
- `commands` は固定 allowlist（`curl` / `node` / `npm` / `npx` / `python3` / `uv` / `git` / `rg` / `fd` / `jq` / `file` / `tar` / `gzip` / `unzip` / `zip` / `xz` / `openssl` / `bash`）のうち実在したものだけを allowlist の順で返す。Dockerfile のビルド用ステージにしか無いツールは含まれない。`version` は出力から抽出・正規化した値で、存在は確認できたが取れなかったときは `null`（UI は「バージョン不明」）。検出できなかったコマンドは一覧に含めない
- `landlock` は bash に適用する Landlock の状態。`state` は `enabled` / `unavailable`、`abi` はカーネルが対応する ABI（取れなければ `null`）、`minAbi` は実行に要求する最低 ABI（3）。`unavailable` のときだけ `reason`（`wrapper_missing` / `unsupported` / `abi_unsupported` / `probe_failed`）を付け、`enabled` 以外では bash を実行しない。ラッパーのパスや内部エラーは返さない（[sandbox.md](sandbox.md#パスと並行実行)）
- `version` は生の stdout / stderr を返さない。抽出は数字とドットだけの最初のトークンで、警告や内部パスは落とす

### 検出の安全性と上限

診断の子プロセスには SDK の `spawnHook`（bash ツールの `PI_SANDBOX_TOKEN` 除去）が適用されない。診断自体を新しい漏えい経路にしないよう、次を守る（定数は `server/src/sandbox/runtime-info.ts`）。

- 環境は `process.env` を継承せず新規作成する（`PATH` / `HOME` / `LANG` / `LC_ALL` / `TERM` だけ）。`PI_SANDBOX_TOKEN`、LLM キー、`NODE_OPTIONS` / `LD_PRELOAD` / `PYTHONPATH` / `BASH_ENV` は渡さない。`HOME` は存在しない固定値で、ユーザー別の設定やフックを読ませない
- `PATH` は信頼できるシステムディレクトリ（`/usr/local/sbin` `/usr/local/bin` `/usr/sbin` `/usr/bin` `/sbin` `/bin`）だけで組む。実行ファイルはそこで解決した絶対パスを使い、symlink は実体まで解決して、実体が信頼ディレクトリの外なら採用しない（ワークスペースや書き込み可能な PATH 上の偽コマンドを使わない）。`cwd` はワークスペース外の固定値（`/`）
- 起動はシェルを介さず、allowlist の名前と固定引数だけを使う。リクエスト値はコマンド名にも引数にも入らない
- 1 コマンド 1 秒（`RUNTIME_PROBE_PER_COMMAND_TIMEOUT_MS`）・同時 4（`RUNTIME_PROBE_MAX_CONCURRENCY`）・全体 5 秒（`RUNTIME_PROBE_TOTAL_TIMEOUT_MS`）。全体の期限を過ぎたら残りは起動せず、存在を確認できたコマンドは `version: null` で返す
- 出力は stdout + stderr の合計 64 KiB（`RUNTIME_PROBE_MAX_OUTPUT_BYTES`）を上限とし、読み込み完了を待たずストリーム受信中に打ち切る。打ち切りと期限超過では `detached` で作ったプロセスグループごと SIGKILL し、孫プロセスを残さない

この対応は診断用子プロセスからの漏えいを防ぐもので、同一ユーザーが読めるファイルや、すでに許可された `bash` 実行に対する完全な秘密隔離を保証しない（[sandbox.md](sandbox.md#残存リスク)）。

## `GET /v1/procs/listeners`

指定ポートの待受ソケットと、`scan=true` のときだけその所有プロセスを返す。serve の所有者照合（起動の確認と停止対象の特定）が使う内部 API。`from` / `to` のレンジ指定では、待受のあるポートの一覧を返す。

```
GET /v1/procs/listeners?port=8080&scan=true
```

```json
// response
{
  "inodes": [1270278],
  "addressScopes": ["loopback"],
  "listener": {
    "pid": 237424,
    "startedAt": 1700000000000,
    "inodes": [1270278],
    "ancestors": [237424, 237400]
  }
}
```

```
GET /v1/procs/listeners?from=18000&to=18099
```

```json
// response
{ "ports": [{ "port": 18000, "inodes": [1270280] }] }
```

- `inodes` — `/proc/net/tcp` と `/proc/net/tcp6` の LISTEN エントリから取った、指定ポートの待受ソケット inode（昇順）。待受が無ければ空配列。状態表示はこれと記録の inode の照合だけで所有者を分類する
- `addressScopes` — `inodes` と同じ添字で対応する待受アドレスの種別。`loopback` は IPv4 の 127.0.0.0/8 と IPv6 の `::1`、`any` は `0.0.0.0` と `::`、それ以外は `other`。v4-mapped（`::ffff:127.0.0.1` など）は IPv4 へ正規化してから分類する。同じポートに複数の待受ソケットが並ぶ場合は `inodes` の並びに合わせる。待受がループバックに限定されているかの判定に使う
- `listener` — `scan=true`（文字列の完全一致）のときだけ特定する。`pid` / `startedAt`（`/proc/<pid>/stat` の起動時刻。PID 再利用の照合に使う。0 は不明）/ `inodes` / `ancestors`（自身から親をたどった PID。起動 PID の子孫かの判定に使う）。特定できなければ `null`。`scan` が省略・他の値なら `listener` を返さず（`inodes` と `addressScopes` だけ）、fd 走査をしない
- **この走査だけは bash 実行ではなくサンドボックス service 本体のプロセスで行う**。bash 実行は Landlock の ptrace 制限で他ドメインの `/proc/<pid>/fd` を読めない（自分の子孫は読める）ため、制限の外にいる service が代行する。`/proc/<pid>/fd` は readlink できるプロセス（同一ユーザーで生存中）だけを見る
- レンジは `from` / `to` の両方で指定し、`port` とは排他（同時指定は 400）。どちらも 1..65535 の整数で、`from <= to`、`to - from + 1 <= 100` を満たす必要がある。応答の `ports` は待受のあったポートだけ（待受ゼロのポートは省く）をポート昇順で返し、`inodes` は昇順。レンジでは所有 PID の fd 走査をせず、`addressScopes` も返さない。`scan=true` をレンジと併用すると 400（一覧のポーリングに重い走査を乗せない）
- `port` / `from` / `to` が不正なら 400。読み取り専用で、ファイルは変更しない
- BFF 側はこの API の接続と本文に期限（既定 5 秒）を掛け、超過は他のサンドボックス失敗と同じ 502 にする（serve の操作は直列化されており、待ち続けると後続の操作が詰まるため）
- 認証は他の `/v1/*` と同じ Bearer 必須。BFF の serve 実装だけが呼び、モデルはツール引数から指定できない

## 環境変数

| 変数 | サービス | 説明 |
| --- | --- | --- |
| `PI_SANDBOX_URL` | BFF | ツール API の到達先（例: `http://u7agent-sandbox:9418`）。未設定ならセッション作成を 503 で拒否 |
| `PI_SANDBOX_TOKEN` | BFF + サンドボックス | Bearer トークン（16 文字以上）。LLM 認証情報とは別の値。サンドボックス内では子プロセスへ継承しない |
| `PI_SANDBOX_CWD` | サンドボックス | ツール実行の既定 cwd（既定 `/workspace`）。ホスト実行では書込み可能なディレクトリを指定し、BFF の `PI_APP_CWD` と同じパスへ揃える |
| `SANDBOX_PORT` | サンドボックス | ツール API のポート（既定 9418。ホストへ publish しない）。8080 は serve 用に予約 |
| `SANDBOX_HOST` | サンドボックス | bind アドレス（既定 `0.0.0.0`）。ローカルでは `127.0.0.1` を指定して LAN へ公開しない（Docker の別コンテナ構成では `0.0.0.0` のまま） |

BFF 側の環境変数（`PI_APP_CWD` / `PI_SESSION_STORE` / `PI_THINKING` / `PORT` / `HOST` / `PI_SECRET_ENV_VARS`）は [.env.example](../.env.example) を参照する。
