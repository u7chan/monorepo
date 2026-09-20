# サンドボックス内部 API と環境変数

BFF が作業用ツール（`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`）の実行と作業領域の一覧取得を委譲する内部API。ブラウザから直接呼ぶAPIではなく、`AppType` には含まれない。ホストへ公開せず、BFF ⇄ サンドボックスの内部ネットワークのみで到達する。設計の背景は [sandbox.md](sandbox.md) を参照する。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/healthz` | 無認証。Compose healthcheck 用。`{ ok, tools, cwd, runningExecutions }` |
| GET | `/v1/files` | 作業領域の一覧（JSON）。`?path=<root 相対>` |
| DELETE | `/v1/files` | 通常ファイルの削除。`?path=<root 相対>`。成功は本文なしの 204 |
| GET | `/v1/files/preview` | UTF-8テキストの取得。`?path=<root 相対>`。上限・応答は [api.md](api.md#テキストプレビュー) を参照 |
| GET | `/v1/files/raw` | 画像の生配信。`?path=<root 相対>`。応答ヘッダは [api.md](api.md#画像配信raw) を参照 |
| POST | `/v1/files/upload` | ファイル追加（raw 本文）。`?dir=<root 相対>&name=<ファイル名>` |
| POST | `/v1/dirs` | ディレクトリ作成（`mkdir -p` 相当）。`{ path }` |
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
- `start` — 実行開始。`executionId` は cancel に使う
- `update` — SDK ツールの `onUpdate`（bash の累積出力スナップショット等）を relay
- `result` — 正常終了。ストリームはここで閉じる
- `error` — 異常終了（`{ "type": "error", "message": "…" }`）。SDK ツールが throw したメッセージ

クライアント（BFF）が切断した場合もサンドボックスは実行を中断する。明示的な中断は cancel エンドポイントか `AbortSignal` の伝播で行う。

## `POST /v1/dirs`

root 相対のディレクトリを `mkdir -p` 相当で作る（親が無くてもよい）。既存ディレクトリは成功扱い。応答は `{ "path": "a/b" }` で、作成した実ディレクトリの root 相対の正規化パス（root は `"."`）。

- `path` は root 相対。`..` で root の外を指す指定は 400。既存の symlink が root 外を指す場合も、その先には作らず 400（作成前に既存の最も深い祖先を realpath で検証する）
- 既存ファイルと同名のディレクトリ、途中にファイルがあるパス（`file.txt/nested`）は 400
- 読み取り専用の `GET /v1/files` と違い、このエンドポイントだけが作業領域へ書き込む

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

- `name` は basename のみ。空・`.`・`..`・`/`・`\`・制御文字・200 文字超は 400。`dir` は `POST /v1/dirs` と同じ規則で root 外を拒否し、無ければ `mkdir -p` で作る
- 書き込みは `<dir>/.pi-upload-<uuid>.part` へ行い、バイト数を数えて上限（100 MiB）を超えたら 413 にして temp を削除する。本文が途切れたときも temp を残さない
- 完成後は `link(2)` で排他作成し、`EEXIST` なら `name-1.ext` → `name-2.ext` …（最大 100 回、以降は乱数 suffix）へ進める。**既存ファイルは決して上書きしない**（並行アップロードでも衝突しない）
- 上限は 1 ファイル 100 MiB（`SANDBOX_MAX_UPLOAD_BYTES`）とファイル名 200 文字。`maxUploadBytes` オプションでテスト時に小さくできる

## `GET /v1/files/raw`

root 相対の画像を `createReadStream` でストリーム返却する。配信できる拡張子は `png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico` だけで、それ以外（SVG / HTML / 拡張子なし）は 400。root 外・実在しない・ディレクトリは通常のパス検証と同じ 400 / 404 になる。

- 200: `Content-Type`（拡張子）/ `Content-Length` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff`
- 413: サイズが上限（100 MiB）を超える
- BFF はこの応答をそのまま中継し、本文を JSON に載せない（[api.md](api.md#画像配信raw)）

## `POST /v1/executions/:id/cancel`

実行中のツール（`start` で払い出された `executionId`）を中断する。SDK ツールへ `AbortSignal` が伝わり、bash は子プロセスを殺して `Command aborted` エラーになる。実行が無い場合は 404。

## `GET /v1/files`

作業領域（root = `PI_SANDBOX_CWD`）の一覧を JSON で返す。`ls` ツールの戻り値は LLM 向けのテキスト（改行区切り・ディレクトリ判定は接尾辞）なので、UI のデータソースとして別契約にする。一覧は読み取り専用で、作業領域への書き込みは `POST /v1/dirs` / `POST /v1/files/upload` / `DELETE /v1/files` の 3 つだけ。リネーム・移動の API は持たない。

`path` は root 相対。省略時は root。解決と検証はツール実行の `cwd` と同じ関数を使う。

```json
{
  "path": "src",
  "entries": [
    { "name": "client", "type": "dir" },
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
- `type` は `file` / `dir`。symlink は辿った先（stat 相当）の実体種別で、ディレクトリ以外（ソケット等）は `file` に寄せる。`size` / `mtime`（epoch ms）は実体を stat できたファイルにだけ付ける（壊れた symlink には付かない）
- `symlink: true` は `lstat` が symlink だったエントリ。root 内を指す symlink は普通に開ける。root 外を指す symlink も一覧には出る（`symlink: true`）が、その位置を `path` に指定すると 400 になる。一覧は symlink の指す先を列挙しない（root 配下だけを返す）
- 並び順はディレクトリ先 → ファイル、各グループ内は大文字小文字を無視した昇順。client は再ソートしない
- hidden file（dotfile）も返す。フィルタは持たない
- 1 ディレクトリ 500 件（SDK の `ls` ツールの既定上限と同じ）で打ち切り、`truncated: true` を返す
- 400: `path` が root 外へ解決される / 不正、ディレクトリでない（`Not a directory: …`）、読み取り不能。404: 実在しない（`Path not found: …`）。文言は `ls` ツールに寄せる
- root 外の拒否は URL 経由の不正参照を防ぐ入力検証で、サンドボックスが読める範囲を絞るものではない（サンドボックスは元々 `bash` / `read` を実行でき、読み取り範囲は変わらない）

## `DELETE /v1/files`

root 相対の通常ファイルを 1 つ消す。成功は本文なしの 204（ゴミ箱・undo は無く、同じ名前で再アップロードすると連番は付かない）。

- 消せるのは通常ファイルだけ。ディレクトリ・FIFO などの特殊ファイルは 400（`Not a regular file: …`）。`path` 省略・空・`.`（root 自身）や末尾が区切りのパスも同じ 400
- **symlink は 400（`Symbolic links cannot be deleted: …`）**。realpath で実体に解決してから消すと、root 内のリンクが指す root 外のファイルを消せてしまうため、要求パスの最終要素だけを `lstat` で見て symlink なら `unlink` しない（リンクだけを消す挙動は提供しない）
- 親ディレクトリは `GET /v1/files` と同じ解決（realpath → root 内外 → 実在 → ディレクトリ）を通す。要求パスの字句の `dirname` を native realpath へ渡すため、`..` は symlink を辿った後に適用される（一覧と同じ）。root 外を指す symlink ディレクトリ経由（`linkOutside/file.txt`）は 400、root 内を指す symlink ディレクトリ経由（`linkInside/file.txt`）は一覧と同じく消せる
- 400: root 外へ解決される / 不正 / 通常ファイル以外 / symlink。404: 実在しない（`Path not found: …`）

## 環境変数

| 変数 | サービス | 説明 |
| --- | --- | --- |
| `PI_SANDBOX_URL` | BFF | サンドボックスの到達先（例: `http://pi-agent-gui-sandbox:8080`）。未設定ならセッション作成を 503 で拒否 |
| `PI_SANDBOX_TOKEN` | BFF + サンドボックス | Bearer トークン（16 文字以上）。LLM 認証情報とは別の値。サンドボックス内では子プロセスへ継承しない |
| `PI_SANDBOX_CWD` | サンドボックス | ツール実行の既定 cwd（既定 `/workspace`）。ホスト実行では書込み可能なディレクトリを指定し、BFF の `PI_APP_CWD` と同じパスへ揃える |
| `SANDBOX_PORT` | サンドボックス | ポート（既定 8080。ホストへ publish しない） |
| `SANDBOX_HOST` | サンドボックス | bind アドレス（既定 `0.0.0.0`）。ローカルでは `127.0.0.1` を指定して LAN へ公開しない（Docker の別コンテナ構成では `0.0.0.0` のまま） |

BFF 側の環境変数（`PI_APP_CWD` / `PI_MODEL` / `PI_MODELS` / `PI_THINKING` / `PORT` / `HOST` / `PI_SECRET_ENV_VARS`）は [README.md](../README.md#環境変数) を参照する。
