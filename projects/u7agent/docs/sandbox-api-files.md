# サンドボックスのファイル操作 API

BFF が作業領域のファイルとディレクトリを扱う内部 API（一覧 / 取得 / 配信 / ダウンロード / アップロード / 削除 / リネーム / 移動 / 引き継ぎメモ）。認証と規約、実行系は [sandbox-api.md](sandbox-api.md) を参照する。スキルは [sandbox-api-skills.md](sandbox-api-skills.md)、ランタイムの診断は [sandbox-api-runtime.md](sandbox-api-runtime.md)。

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

引き継ぎメモ（作業フォルダ直下の `HANDOFF.md`）専用の読み書き。BFF の会話の引き継ぎ（[api-session-state.md](api-session-state.md#post-apisessionsidmove)）だけが使う。プレビュー API とは別の入口にし、**上限の値を分けて共有しない**（プレビューの上限を変えても引き継ぎの契約が動かないように）。

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
- 入力検証は**競合がない場合**の契約。`lstat` の後に同じ名前が作られると `rename(2)` が上書きする（Node に no-replace の rename が無い。単一ユーザーでエージェントと同時に触った場合のみ）。fd 相対の rename が Node に無いため完全な防御は入れない（[`DELETE /v1/dirs`](sandbox-api.md#delete-v1dirs) の TOCTOU と同じクラス）
- 400 / 404 / 409 の文言はサンドボックスが返し、BFF はそのままクライアントへ返す（[api-files.md](api-files.md#リネーム)）

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
- 206 / 416: 単一の `Range`（`bytes=<start>-<end>` / `bytes=<start>-` / `bytes=-<suffix>`）を解釈し、満たせれば 206 + `Content-Range: bytes <start>-<end>/<size>`、解釈できて満たせないときだけ 416 + `Content-Range: bytes */<size>`。解釈できない `Range`（構文不正 / `bytes` 以外の単位 / 複数レンジ）は無視して 200 を返す。マルチパートは返さない。契約は [api-files.md](api-files.md#画像配信raw) を参照
- 413: サイズが上限（100 MiB）を超える（`{ error: "File is too large (max … bytes)" }` の JSON を返す。ファイルの本文と `Content-Length` は送出しない）
- BFF はこの応答をそのまま中継し、本文を JSON に載せない。**公開 `GET /api/files/raw` も画像と音声の両方を渡し**、同じ allowlist と `Range` の契約を見る（[api-files.md](api-files.md#画像配信raw)）

## `GET /v1/files/image-input`

画像生成の参照画像（`generate_image` の `input_images`）を読む専用の経路。公開 raw とは別契約で、
**拡張子 allowlist を通さず実バイトで形式を判定**し、BFF が指定した許可範囲（`scope`）の実パスだけを返す。
ブラウザ向け `GET /v1/files/raw` の拡張子 allowlist・Range・中継契約は変えない。

```
GET /v1/files/image-input?path=generated/portrait.png&scope=projects/app&scope=.u7agent/uploads/0123456789
Content-Type: application/octet-stream
Content-Length: <bytes>
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

- `path` は root 相対。`scope` は root 相対のディレクトリで、繰り返しで最大 8 個（`SANDBOX_MAX_IMAGE_INPUT_SCOPES`）。BFF はセッション cwd と `sessionUploadsRel(id, spaceId)` を送り、モデルは範囲を指定できない
- 許可範囲は**実パス**で照合する。範囲内を指す symlink は範囲内として通り、範囲外・root 外を指すものは 400。解決後のパスを `O_NOFOLLOW | O_NONBLOCK` で開き、fstat で通常ファイルだけを受け付けたうえで、開いた実体（procfs 経由で引き直したパス）も範囲内か確かめる。引き直せないときは読取を拒否する（範囲を確認できないまま読む fail-open にしない）
- 実在しない `scope` は無視する（添付置き場は会話の添付が無い間は存在しない）。有効な範囲が 1 つも無い場合は 400
- 形式は実バイトで判定し、PNG / JPEG / WebP のヘッダが読めなければ 400。既存ファイルの拡張子は見ない（無拡張子・`.bin` でも実体が画像なら通る）
- FIFO・ソケット・デバイスなどの非通常ファイルは、種別を確かめる前の blocking open を避けるため `O_NONBLOCK` 付きで開き、fstat で 400 にする（writer のいない FIFO でも停止しない）
- 上限は 1 枚 10 MiB・40 メガピクセル（`server/src/image-format.ts`）。サイズ超過と画素数超過は 413
- 200 の本文は画像バイトそのもの。BFF は `Content-Length` と実受信バイト数を照合し、途中で切れた応答や上限超過を完成画像として扱わない。入力読取は 200 の全体応答だけを受け付け、206 / 416 の部分応答は本文を捨てて拒否する
- BFF の読み取りは 1 枚 30 秒で打ち切る（`SANDBOX_IMAGE_INPUT_TIMEOUT_MS`）。期限超過とユーザー中断は接続を捨て、完成画像として扱わない。サンドボックス側も request の中断 signal を読取処理へ伝播し、中断時は fd を閉じて終了する
- 400 / 404 / 413 の本文は `{ error }`。BFF は文言をそのままツールのエラーへ載せる（base64 は載せない）

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
- BFF はこの応答をストリーム中継し、本文を JSON に載せない（[api-files.md](api-files.md#ダウンロード)）

### `GET /v1/files/download` の上限

| 上限 | 値 | 定数 | 理由 |
| --- | --- | --- | --- |
| 含めるファイルの合計サイズ | 100 MiB | `SANDBOX_MAX_ARCHIVE_BYTES`（`SANDBOX_MAX_UPLOAD_BYTES` と同値） | Zip64 を書かない（ローカルヘッダ / 中央ディレクトリのサイズは 4 GiB 未満） |
| ZIP のエントリ数 | 10,000 | `SANDBOX_MAX_ARCHIVE_ENTRIES` | EOCD の件数が 16bit（65,535） |

事前 walk（`server/src/sandbox/archive.ts`）がヘッダを送る前に上限を検査するため、超過は「切れた zip」ではなく 413 になる。**単体ファイルも同じ 100 MiB** で拒否する（Zip64 を書かずに 4 GiB 級のファイルを 32bit フィールドで書くと壊れるため）。

限界は [file-actions.md](file-actions.md#既知の制限ダウンロード) を参照（ストリーム中の失敗で切れた zip になる / 事前 walk と圧縮の間の増減は見積りの近似になる）。

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

### `GET /v1/files/download/plan`

`download` / `check` と同じ計画（解決 + walk）に、公開前のプレビューが使う一覧を足して返す。`exclude` の扱いは共通で、`maxFileBytes` はこのルートだけが読む任意の query（正の整数。省略時は個別サイズを見ない）。

```json
// GET /v1/files/download/plan?path=dist&exclude=&maxFileBytes=26214400 (200)
{
  "kind": "archive",
  "name": "dist.zip",
  "entries": 209,
  "bytes": 1042263,
  "files": [{ "name": "index.html", "size": 612 }],
  "truncated": false,
  "links": ["secret-link.txt"],
  "linksTruncated": false,
  "oversizeFiles": [],
  "oversizeTruncated": false,
  "hasIndexHtml": true,
  "skipped": []
}
```

- `entries` はディレクトリも数える。`files` はファイルだけを走査順に並べ、先頭 `SANDBOX_MAX_PLAN_FILES` 件で打ち切って `truncated` を立てる
- `hasIndexHtml` は一覧の打ち切りと無関係に、走査中に最上位の `index.html` を見たかで決める（一覧の先頭 N 件からは判定できない）
- `links` は symlink / 特殊ファイルのパス（ZIP には入れない）。`oversizeFiles` は `maxFileBytes` を超えたパスで、どちらも先頭 `SANDBOX_MAX_PLAN_PATHS` 件と打ち切りの印を返す
- 全体の件数 / サイズ上限は `check` と同じく 413 で、このとき件数・サイズ・一覧は返さない（走査が終わっていない）
- `maxFileBytes` が 0・負数・非整数・`SANDBOX_MAX_ARCHIVE_BYTES` 超のときは 400。download / check の意味は変えない（サンドボックスに 1 ファイル上限は無い）

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
- 実行の制限は[実行環境の診断](sandbox-api-runtime.md#get-v1runtimeinfo)と同じ: 信頼ディレクトリ（`RUNTIME_PROBE_PATH_DIRS`）で解決した `git` の実体、固定引数（shell 無し）、`process.env` を継承しない最小環境（`HOME` は存在しない固定値）。cwd は `/` で、対象ディレクトリは `-C` だけに渡す。stdout + stderr の合計で 4 KiB、遅くとも 2 秒（2 コマンドの合計）で打ち切る
  - 値に使うのは **stdout の 1 行目だけ**。stderr は読み切って上限に数えるだけで、`core.fsyncObjectFiles` 非推奨のような**終了コード 0 の警告をブランチ名に混ぜない**
- `git` が無い / 期限超過 / 出力上限 / repo の外は、理由を返さず `branch: null` に寄せる。ブランチは一覧の表示を止める情報ではないので、UI はチップを出さないだけにする

## `GET /v1/files/stat`

`path`（root 相対、省略時は root）が通常ファイルとして実在するかを JSON で返す。**本文は読まない**（テキストプレビューの入力検証を存在の判定に混ぜない）。BFF の `GET /api/files/stat` がこの API を呼び、参照を開く前の確認に使う（[api-files.md](api-files.md#存在確認)）。

```json
// response
{ "path": "src/index.ts" }
```

- 200: 通常ファイルとして実在する。`path` は realpath を root 相対へ写した正規化パス（root は `"."`。symlink を経由した要求は辿った先）。解決と検証は `GET /v1/files` と同じ（root 内外は実パスで判定）
- 404: 実在しない（`Path not found: …`。壊れた symlink を含む）
- 400: `path` が不正（`Invalid path: …`）/ root 外（`Path outside the workspace: …`）/ 通常ファイル以外（ディレクトリ・FIFO などの特殊ファイルは `Not a regular file: …`）。実在の確認に使わせないための拒否で、不存在（404）とは別の応答
- 401: Bearer トークンが他と同じく必要（無効・欠落）
- バイナリ・UTF-8 不正・上限超過のファイルも 200 になる（本文を読まないため。プレビューは `GET /v1/files/preview` の 400）

## `DELETE /v1/files`

root 相対の通常ファイルを 1 つ消す。成功は本文なしの 204（ゴミ箱・undo は無く、同じ名前で再アップロードすると連番は付かない）。

- 消せるのは通常ファイルだけ。ディレクトリ・FIFO などの特殊ファイルは 400（`Not a regular file: …`）。`path` 省略・空・`.`（root 自身）や末尾が区切りのパスも同じ 400
- **symlink は 400（`Symbolic links cannot be deleted: …`）**。realpath で実体に解決してから消すと、root 内のリンクが指す root 外のファイルを消せてしまうため、要求パスの最終要素だけを `lstat` で見て symlink なら `unlink` しない（リンクだけを消す挙動は提供しない）
- 親ディレクトリは `GET /v1/files` と同じ解決（realpath → root 内外 → 実在 → ディレクトリ）を通す。要求パスの字句の `dirname` を native realpath へ渡すため、`..` は symlink を辿った後に適用される（一覧と同じ）。root 外を指す symlink ディレクトリ経由（`linkOutside/file.txt`）は 400、root 内を指す symlink ディレクトリ経由（`linkInside/file.txt`）は一覧と同じく消せる
- 400: root 外へ解決される / 不正 / 通常ファイル以外 / symlink。404: 実在しない（`Path not found: …`）
