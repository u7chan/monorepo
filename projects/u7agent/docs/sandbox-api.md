# サンドボックス内部 API と環境変数

BFF が作業用ツール（`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`）の実行、作業領域の一覧取得、ファイルスキルの発見を委譲する内部API。ブラウザから直接呼ぶAPIではなく、`AppType` には含まれない。ホストへ公開せず、BFF ⇄ サンドボックスの内部ネットワークのみで到達する。設計の背景は [sandbox.md](sandbox.md) を参照する。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/healthz` | 無認証。Compose healthcheck 用。`{ ok, tools, cwd, runningExecutions }` |
| GET | `/v1/runtime/info` | 実行環境の診断（認証必須・読み取り専用）。[実行環境の診断](#get-v1runtimeinfo) |
| GET | `/v1/files` | 作業領域の一覧（JSON）。`?path=<root 相対>` |
| GET | `/v1/skills` | ファイルスキル（`SKILL.md`）の発見（JSON）。`?dir=<root 相対>` |
| DELETE | `/v1/files` | 通常ファイルの削除。`?path=<root 相対>`。成功は本文なしの 204 |
| POST | `/v1/files/rename` | エントリ（ファイル / ディレクトリ）のリネーム。`{ path, name }` |
| GET | `/v1/files/preview` | UTF-8テキストの取得。`?path=<root 相対>`。上限・応答は [api.md](api.md#テキストプレビュー) を参照 |
| GET | `/v1/files/raw` | 画像の生配信。`?path=<root 相対>`。応答ヘッダは [api.md](api.md#画像配信raw) を参照 |
| GET | `/v1/files/download` | 通常ファイルは生バイト、ディレクトリは ZIP（ストリーム）。`?path=<root 相対>&exclude=<名前>`（繰り返し可） |
| GET | `/v1/files/download/check` | ダウンロードの見積り（JSON）。除外 / 上限の判定は download と同じ（`exclude` も共通） |
| POST | `/v1/files/upload` | ファイル追加（raw 本文）。`?dir=<root 相対>&name=<ファイル名>` |
| POST | `/v1/dirs` | ディレクトリ作成（`mkdir -p` 相当）。`{ path }` |
| DELETE | `/v1/dirs` | ディレクトリ削除。`?path=<root 相対>&recursive=true`。成功は本文なしの 204 |
| POST | `/v1/tools/:tool/execute` | ツール実行。NDJSON ストリームで応答 |
| POST | `/v1/executions/:id/cancel` | 実行中のツールを中断 |

認証は `Authorization: Bearer <PI_SANDBOX_TOKEN>`。未認証は 401、未知のツールは 404、`params` がオブジェクトでない場合や `cwd` / `path` が文字列でない場合は 400。

## `POST /v1/tools/:tool/execute`

リクエストボディは `{ toolCallId?: string, params?: object, cwd?: string }`。応答は `Content-Type: application/x-ndjson` で、1 イベント 1 行:

```jsonl
{"type":"start","executionId":"…"}
{"type":"update","payload":{"content":[…],"details":{…}}}
{"type":"result","payload":{"content":[…]}}
```

- `cwd` — 実行する作業ディレクトリ（root 相対。省略・空文字は root）。`..` や symlink を経由して root の外へ解決する指定、実在しないディレクトリ、ディレクトリ以外は 400 / 404（`GET /v1/files` と同じ検証を通す）。ツール定義（パス解決の起点）は解決後の実パスごとに生成して再利用する
- `write` / `edit` の書き込み先は、実行 cwd（`cwd` を解決した実パス）、要求 cwd の lexical 形（`resolve(PI_SANDBOX_CWD, cwd)`）、および `<PI_SANDBOX_CWD>/.agents/skills` の内側だけ。SDK が解決した絶対パスを `resolve()` で `..` まで畳んで比較し（symlink は解決しない）、外側は拒否する（[projects.md](projects.md#write--edit-の書き込み範囲)）
  - 対象外: 他セッションのスクラッチ、workdir を除く `.u7agent` 配下、他プロジェクト、`.u7agent/builtin-skills/**`、workspace root 直下（`PI_SESSION_STORE` 未設定の縮退では root が作業ディレクトリになるため root 直下も通る）
  - write は `mkdir` と `writeFile`、edit は `access` / `readFile` / `writeFile` のすべてで同じ判定を通す（write は `mkdir` を先に許すと拒否パスでも親ディレクトリができるため `mkdir` でも拒否する）
  - `read` / `grep` / `find` / `ls` / `bash` は制限しない。`bash` のリダイレクトは原理的に塞げないため、これは隔離ではなくファイルツールのポリシーである
- `start` — 実行開始。`executionId` は cancel に使う
- `update` — SDK ツールの `onUpdate`（bash の累積出力スナップショット等）を relay
- `result` — 正常終了。ストリームはここで閉じる
- `error` — 異常終了（`{ "type": "error", "message": "…" }`）。SDK ツールが throw したメッセージ。`write` / `edit` のポリシー拒否もこの経路で返し、文言に許可場所（実行 cwd の絶対パスと `<PI_SANDBOX_CWD>/.agents/skills`）と cwd 相対の再試行例を含める。拒否に 404 / 400 は使わない（HTTP 400 は BFF が `{ error: … }` の JSON ラッパーとしてモデルに見せるため。`cwd` 自体の検証は従来どおり実行前の 400 / 404）

クライアント（BFF）が切断した場合もサンドボックスは実行を中断する。明示的な中断は cancel エンドポイントか `AbortSignal` の伝播で行う。

## `POST /v1/dirs`

root 相対のディレクトリを `mkdir -p` 相当で作る（親が無くてもよい）。既存ディレクトリは成功扱い。応答は `{ "path": "a/b" }` で、作成した実ディレクトリの root 相対の正規化パス（root は `"."`）。

- `path` は root 相対。`..` で root の外を指す指定は 400。既存の symlink が root 外を指す場合も、その先には作らず 400（作成前に既存の最も深い祖先を realpath で検証する）
- 既存ファイルと同名のディレクトリ、途中にファイルがあるパス（`file.txt/nested`）は 400
- 作業領域へ書き込む API は `POST /v1/dirs` / `POST /v1/files/rename` / `POST /v1/files/upload` / `DELETE /v1/files` / `DELETE /v1/dirs` の 5 つで、`GET /v1/files` は読み取り専用。`write` / `edit` の書き込み範囲（workdir と `<root>/.agents/skills`）はこの 5 つより狭く、`POST /v1/dirs` / `POST /v1/files/rename` / `POST /v1/files/upload` 自体は root 配下ならどこへでも書ける（BFF の添付・プロジェクト作成・設定画面が使う）

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

## `POST /v1/files/rename`

root 相対のエントリ（通常ファイル / ディレクトリ）の名前を変える。本文は `{ path, name }` で、`name` は 1 セグメントの新しい名前。応答は名前を変えたエントリの root 相対の正規化パス（root は `"."`）。

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

## `GET /v1/files/raw`

root 相対の画像を `createReadStream` でストリーム返却する。配信できる拡張子は `png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico` だけで、それ以外（SVG / HTML / 拡張子なし）は 400。root 外・実在しない・ディレクトリは通常のパス検証と同じ 400 / 404 になる。

- 200: `Content-Type`（拡張子）/ `Content-Length` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff`
- 413: サイズが上限（100 MiB）を超える
- BFF はこの応答をそのまま中継し、本文を JSON に載せない（[api.md](api.md#画像配信raw)）

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

作業領域（root = `PI_SANDBOX_CWD`）の一覧を JSON で返す。`ls` ツールの戻り値は LLM 向けのテキスト（改行区切り・ディレクトリ判定は接尾辞）なので、UI のデータソースとして別契約にする。一覧は読み取り専用で、作業領域への書き込みは `POST /v1/dirs` / `POST /v1/files/rename` / `POST /v1/files/upload` / `DELETE /v1/files` / `DELETE /v1/dirs` の 5 つだけ。移動（親ディレクトリの変更）の API は持たない。

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
  ]
}
```

- `environment` は OS の名称と版（`/etc/os-release` の `PRETTY_NAME`。取れなければ `不明`）、正規化した CPU アーキテクチャ（`x86_64` / `aarch64` など）、実行ユーザー名、UID 0 で動いているか、ワークスペース root。環境変数の値・認証ファイル・ホストの情報は返さない
- `commands` は固定 allowlist（`curl` / `node` / `npm` / `npx` / `python3` / `uv` / `git` / `rg` / `fd` / `jq` / `file` / `tar` / `gzip` / `unzip` / `zip` / `xz` / `openssl` / `bash`）のうち実在したものだけを allowlist の順で返す。Dockerfile のビルド用ステージにしか無いツールは含まれない。`version` は出力から抽出・正規化した値で、存在は確認できたが取れなかったときは `null`（UI は「バージョン不明」）。検出できなかったコマンドは一覧に含めない
- `version` は生の stdout / stderr を返さない。抽出は数字とドットだけの最初のトークンで、警告や内部パスは落とす

### 検出の安全性と上限

診断の子プロセスには SDK の `spawnHook`（bash ツールの `PI_SANDBOX_TOKEN` 除去）が適用されない。診断自体を新しい漏えい経路にしないよう、次を守る（定数は `server/src/sandbox/runtime-info.ts`）。

- 環境は `process.env` を継承せず新規作成する（`PATH` / `HOME` / `LANG` / `LC_ALL` / `TERM` だけ）。`PI_SANDBOX_TOKEN`、LLM キー、`NODE_OPTIONS` / `LD_PRELOAD` / `PYTHONPATH` / `BASH_ENV` は渡さない。`HOME` は存在しない固定値で、ユーザー別の設定やフックを読ませない
- `PATH` は信頼できるシステムディレクトリ（`/usr/local/sbin` `/usr/local/bin` `/usr/sbin` `/usr/bin` `/sbin` `/bin`）だけで組む。実行ファイルはそこで解決した絶対パスを使い、symlink は実体まで解決して、実体が信頼ディレクトリの外なら採用しない（ワークスペースや書き込み可能な PATH 上の偽コマンドを使わない）。`cwd` はワークスペース外の固定値（`/`）
- 起動はシェルを介さず、allowlist の名前と固定引数だけを使う。リクエスト値はコマンド名にも引数にも入らない
- 1 コマンド 1 秒（`RUNTIME_PROBE_PER_COMMAND_TIMEOUT_MS`）・同時 4（`RUNTIME_PROBE_MAX_CONCURRENCY`）・全体 5 秒（`RUNTIME_PROBE_TOTAL_TIMEOUT_MS`）。全体の期限を過ぎたら残りは起動せず、存在を確認できたコマンドは `version: null` で返す
- 出力は stdout + stderr の合計 64 KiB（`RUNTIME_PROBE_MAX_OUTPUT_BYTES`）を上限とし、読み込み完了を待たずストリーム受信中に打ち切る。打ち切りと期限超過では `detached` で作ったプロセスグループごと SIGKILL し、孫プロセスを残さない

この対応は診断用子プロセスからの漏えいを防ぐもので、同一ユーザーが読めるファイルや、すでに許可された `bash` 実行に対する完全な秘密隔離を保証しない（[sandbox.md](sandbox.md#残存リスク)）。

## 環境変数

| 変数 | サービス | 説明 |
| --- | --- | --- |
| `PI_SANDBOX_URL` | BFF | サンドボックスの到達先（例: `http://u7agent-sandbox:8080`）。未設定ならセッション作成を 503 で拒否 |
| `PI_SANDBOX_TOKEN` | BFF + サンドボックス | Bearer トークン（16 文字以上）。LLM 認証情報とは別の値。サンドボックス内では子プロセスへ継承しない |
| `PI_SANDBOX_CWD` | サンドボックス | ツール実行の既定 cwd（既定 `/workspace`）。ホスト実行では書込み可能なディレクトリを指定し、BFF の `PI_APP_CWD` と同じパスへ揃える |
| `SANDBOX_PORT` | サンドボックス | ポート（既定 8080。ホストへ publish しない） |
| `SANDBOX_HOST` | サンドボックス | bind アドレス（既定 `0.0.0.0`）。ローカルでは `127.0.0.1` を指定して LAN へ公開しない（Docker の別コンテナ構成では `0.0.0.0` のまま） |

BFF 側の環境変数（`PI_APP_CWD` / `PI_MODEL` / `PI_MODELS` / `PI_THINKING` / `PORT` / `HOST` / `PI_SECRET_ENV_VARS`）は [README.md](../README.md#環境変数) を参照する。
