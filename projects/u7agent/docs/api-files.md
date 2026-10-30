# ファイル API

ファイルの一覧・プレビュー・配信・ダウンロード・アップロードの HTTP 契約。DTO の正は `server/src/schema.ts`、クライアントは `client/src/api.ts` の hc で参照する。規約と索引は [api.md](api.md) を参照する。

## ファイル一覧

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files?path=<root 相対>` | 作業ディレクトリの一覧。`path` 省略時は root（`"."`） |
| DELETE | `/api/files?path=<root 相対>` | 通常ファイルの削除。成功は 204（本文なし） |
| DELETE | `/api/files?path=<root 相対>&recursive=true` | ディレクトリの削除（配下ごと）。成功は 204（本文なし） |

サンドボックスの `GET /v1/files` の応答を、そのまま DTO（`FileListing`）として返す。セッションに依存させない（`/api/sessions/:id/...` 配下に置かない）ため、セッションが無くても、APIキーが未設定で `/api/health` が `ready: false` でも開ける。

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

- 200: サンドボックスの一覧をそのまま返す。エントリの意味は [sandbox-api.md](sandbox-api.md#get-v1files) を参照
- 400 / 404: `path` が root 外へ解決される / 不正 / ディレクトリでない（400）、実在しない（404）。実在しない `path` は lexical な位置で判定するため、root 外を指す未作成パスは 404 ではなく 400 になる。サンドボックス側の文言をそのまま返す
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定。`{ "error": "サンドボックスが設定されていません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)" }`
- 502: サンドボックスへ到達できない / 認証失敗 / サンドボックス側のエラー / 契約外の応答（BFF が zod で検証して弾く）

client（`client/src/api.ts` の `getFiles`）は hc でこの契約を型として参照し、ディレクトリを展開したときにそのパスだけを取得する（遅延ロード）。並び順はサーバーが決めるため再ソートしない。自動更新は無く、画面の「再読み込み」で取り直す。`path` はワークスペース root 相対のままで、選択中セッションの配下を表示するときはクライアントがそのセッションの `cwd`（root 相対）を前置してパスを組み立てる。

この API はワークスペース root 相対で全体を見る（設定 → ファイル）が、モデルの `write` / `edit` の書き込み範囲はセッションの作業ディレクトリと `<root>/.agents/skills` に限られる（[projects.md](projects.md#write--edit-の書き込み範囲)）。

### 削除

`DELETE /api/files?path=<root 相対>` はサンドボックスへ委譲し、BFF はワークスペースに触らない。`recursive` が正確に文字列 `true` のときだけディレクトリの削除（`DELETE /v1/dirs?recursive=true`。[sandbox-api.md](sandbox-api.md#delete-v1dirs)）へ回し、省略時は従来どおり通常ファイルの削除（`DELETE /v1/files`）へ回す。`client/src/api.ts` の `deleteFile` / `deleteDirectory` は成功時に本文を読まない。

- 204: 削除した（本文なし）
- 400 / 404: root 外 / 不正 / 対象外（通常ファイル以外 / ディレクトリ以外） / symlink / ディレクトリを `recursive` なしで消そうとした（400）、実在しない（404）。サンドボックス側の文言をそのまま返す
- `recursive` が `true` 以外（`false` / `1` / `TRUE` / 空）や重複しているときは 400（`recursive must be exactly "true" when present`）で、サンドボックスへ要求を出さない
- 503 / 502: `GET /api/files` と同じ（未設定 / 到達不能・認証失敗・サンドボックス側のエラー）

出す導線は設定 → ファイル（ワークスペース root）とチャット右パネル（セッションの作業フォルダ）の両方にある（[file-actions.md](file-actions.md#削除)）。

### リネーム

`POST /api/files/rename` は `{ path, name }`（どちらも string）を受け、サンドボックスの `POST /v1/files/rename`（[sandbox-api.md](sandbox-api.md#post-v1filesrename)）へ委譲する。BFF はワークスペースに触らない。`client/src/api.ts` の `renameEntry(path, name)` が呼び、応答は改名後のワークスペース root 相対パス。

```json
// request
{ "path": "uploads/nested/photo.png", "name": "shot.png" }

// response (200)
{ "path": "uploads/nested/shot.png", "name": "shot.png" }
```

- 200: サンドボックスの応答を検証（`FileRenameSchema`）してそのまま返す
- 400 / 404 / 409: 不正な名前 / root 外 / 不存在 / symlink（400）、実在しない（404）、同名の既存エントリ（409）。サンドボックス側の文言をそのまま返す。**同名は上書きも自動採番もしない**
- 400: `path` / `name` が string でない、JSON として壊れている（`Invalid request body` / `Request body must be valid JSON`）。サンドボックスへは要求しない
- 502: サンドボックスへ到達できない / 認証失敗 / 応答が契約外
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

出す導線は設定 → ファイル（ワークスペース root）のフォルダ行だけにある（[file-actions.md](file-actions.md#リネーム)）。API はファイル / ディレクトリの両方を受けるが、UI からファイルは改名できない。

### アップロード

| メソッド | パス | 説明 |
| --- | --- | --- |
| POST | `/api/files/upload?path=<保存先の root 相対>&name=<保存名>` | raw の本文を 1 ファイルとして保存。成功は 201 |

設定 → ファイル（`/settings/files`）と、作業環境の作業フォルダ面のドラッグ＆ドロップが使う（[file-upload.md](file-upload.md)）。`path` は保存先ディレクトリで、省略時はワークスペース root（`""`）。作業環境ではその面の root（セッションの作業フォルダ）を渡す。`name` は 1 セグメントの保存名で、形式（空・`.`・`..`・`/`・制御文字・長さ）はサンドボックスが検証する。BFF は本文を JSON 化せず raw のストリームのままサンドボックスの `POST /v1/files/upload`（[sandbox-api.md](sandbox-api.md#post-v1filesupload)）へ中継し、ワークスペースに触らない。

```json
// request
POST /api/files/upload?path=docs&name=notes.txt
Content-Type: application/octet-stream

<raw bytes>

// response (201)
{ "path": "docs/notes.txt", "name": "notes.txt", "renamed": false, "size": 1234 }
```

- 201: サンドボックスの応答を `FileUploadSchema` で検証してそのまま返す。`path` は root 相対の保存先。同名の既存ファイルは**上書きせず** `notes-1.txt` のように連番で保存し、`renamed: true` と実際の `name` を返す（[sandbox-api.md](sandbox-api.md#post-v1filesupload)）
- 413: 宣言された `Content-Length` が `SANDBOX_MAX_UPLOAD_BYTES`（100 MiB）を超える。本文をサンドボックスへ送る前に止める。宣言が無い / 実際の受信バイトが上限を超える場合はサンドボックスが 413 を返す
- 400: 保存名の形式（空・`.`・`..`・区切り・制御文字・長さ）・`path` が root 外・保存先がディレクトリでない（400）。保存先ディレクトリは必要ならサンドボックスが作る（存在しない `path` は 404 にしない）。サンドボックス側の文言をそのまま返す
- 502 / 503: 到達不能・認証失敗・契約外の応答 / `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

このルートは raw の本文を受けるため、BFF では `bodyGuard`（64 KiB で読み切って text 化する）より先に登録する。

### git ブランチ

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/git?path=<root 相対>` | `path`（省略時は root）のディレクトリが属する repo の HEAD |

サンドボックスの `GET /v1/files/git`（[sandbox-api.md](sandbox-api.md#get-v1filesgit)）の応答を DTO（`GitInfo`）として返す。`path` は一覧と同じワークスペース root 相対で、検証も同じ経路を通す。

```json
{ "branch": "feature/x" }
```

- 200: `branch` は HEAD のブランチ名で、detached HEAD は短縮 SHA。**repo の外・`git` の無い環境は `branch: null`** で、UI はチップを出さないだけにする（一覧の表示は止めない）。`Cache-Control: no-store`（再読み込みで取り直す）
- 400 / 404 / 502 / 503: パス検証とサンドボックス失敗の扱いは `GET /api/files` と同じ（400 root 外 / 404 実在しない / 502 到達不能・契約外の応答 / 503 未設定）

client（`client/src/api.ts` の `getGitInfo`）は作業フォルダの行が呼ぶ。取り直しの合図は一覧と同じ `reloadToken`（パネルの「再読み込み」と run の終了）で、失敗時は古い値を消してチップを出さない（[ui-layout.md](ui-layout.md#作業環境パネル)）。

### 存在確認

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/stat?path=<root 相対>` | 通常ファイルとして実在するかの確認（本文は返さない） |

サンドボックスの `GET /v1/files/stat`（[sandbox-api.md](sandbox-api.md#get-v1filesstat)）の応答を DTO（`FileStat`）として返す。`path` は一覧と同じワークスペース root 相対で、検証も同じ経路を通す。チャット本文のファイル参照を開く前に実在を確認するために使い（[file-tree.md](file-tree.md#クリックと要求)）、**一覧（`GET /api/files`）は 1 ディレクトリ 500 件の打切り（`truncated: true`）と壊れた symlink の行があるため、存在の判定には使わない**。

```json
{ "path": "src/index.ts" }
```

- 200: 通常ファイルとして実在する（`Cache-Control: no-store`）。`path` は realpath を root 相対へ写した正規化パス（root は `"."`。symlink を経由した要求は辿った先）
- 404: 実在しない。壊れた symlink も同じ
- 400: `path` が不正 / root 外へ解決される / 通常ファイル以外（ディレクトリ・特殊ファイル）。**本文を読まない**ため、テキストプレビューの 400（バイナリ・UTF-8 不正・2 MiB 超）はこの API では返らない
- 502 / 503: 到達不能・契約外の応答 / 未設定。**不存在の判定には使わない**（[file-tree.md](file-tree.md#クリックと要求) の分類で確認不能として扱う）

client（`client/src/api.ts` の `statFile`）は `client/src/lib/fileRefOpen.ts` の `classifyFileRefFailure` と組で使い、200 だけを実在、404 を不存在、400 を拒否、それ以外を確認不能として扱う。

## テキストプレビュー

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/preview?path=<root 相対>` | テキストファイルの内容（UTF-8、2 MiB 以下） |

`{ "text": "内容" }` を返す（`Cache-Control: no-store`）。サンドボックスの `GET /v1/files/preview` に委譲し、root 内の通常ファイルのみ読み取る。この経路では HTML や Markdown も実行・レンダリングせずプレーンテキストとして返す（HTML の描画は `GET /api/files/html/<root 相対>` を使う）。

- 400 / 404: バイナリ・UTF-8 として不正なバイト列・上限超過・ディレクトリ・root 外（400）、実在しない（404）。サンドボックス側の文言をそのまま返す
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定
- 502: サンドボックスへ到達できない / 認証失敗 / 契約外の応答（BFF が zod で検証して弾く）

ファイル画面で選択するとタブとして開き、同じファイルの再選択はタブを増やさず表示だけを切り替える。タブは最大 8 枚で、超えると最も古いタブを閉じる。本文は表示中のタブの分だけ取得し、タブごとに保持する（切替では取り直さない）。「再読み込み」は開いているタブを保ったまま本文を捨てて取り直す。表示位置は本文の幅で決まり、狭いときはツリーの下、広いときはツリーの右に出る。行番号とシンタックスハイライトはクライアントの表示だけで、転送はプレーンテキストのまま（[file-preview.md](file-preview.md)）。

## HTML プレビュー

iframe の src になる HTML 文書と、その文書が相対参照するアセットを同じルートで配信する。パスは root 相対で `/` を含めてよく、クライアントはセグメント単位で percent encoding する。要求パスの拡張子で応答が分かれる。

| 要求（`GET /api/files/html/<path>`） | 応答 |
| --- | --- |
| `.html` / `.htm` | HTML 文書（UTF-8、2 MiB 以下）。CSP + `sandbox` 付きの `text/html` |
| 画像（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`） | `GET /v1/files/raw` を流用した生配信（100 MiB 以下） |
| 音声（`mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac`） | 画像と同じ raw の生配信（100 MiB 以下。`Range` / 206 / 416 も同じ契約） |
| `.js` / `.mjs` / `.css` / `.json` / `.txt` | `GET /v1/files/preview` を流用した UTF-8 テキスト（2 MiB 以下） |
| それ以外（`.svg` を含む） | 400 `Not a servable asset: <path>` |
| パスなし（`/api/files/html`、`/api/files/html/`） | 404（HTML 文書は返さない） |

- 文書はサンドボックスの `GET /v1/files/preview` の応答を `text/html` としてそのまま返す（`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`）。HTML として開くかの判定は要求パスの拡張子で行い、本文の中身や拡張子は見ない
- テキストアセットも同じ `workspace.previewFile()` を通るため、バイナリ・UTF-8 として不正なバイト列・上限超過・ディレクトリ・root 外は 400、実在しない場合は 404（サンドボックス側の文言をそのまま返す）。画像 / 音声は raw の経路で `Content-Type` / `Content-Length` / `no-store` / `nosniff` を付けて返す
- 文書以外には CSP を付けず、拡張子から決めた Content-Type と `nosniff` で守る。`.svg` / HTML をアセットとして配らない（CSP の無い応答を同一オリジンで動かさない。この方針はプレビュー オリジンでも同じ）。動画 / フォントは対象外
- アセットの上限はテキスト（`.js` / `.mjs` / `.css` / `.json` / `.txt`）が 2 MiB、画像 / 音声の raw が 100 MiB。超えるテキストは 400、超える画像 / 音声は 413 でプレビューから読めない。`<script type="module">` はアプリ オリジン（オペーク）では CORS ヘッダが無いため読めず、プレビュー オリジンでは同じルートが `'self'` になるため読める
- 音声も画像と同じ生配信で、単一の `Range` を解釈して 206 / 416 を返す（シークで未バッファ位置へ飛んでも全体を取り直さない。契約は[画像配信（raw）](#画像配信raw)）
- 400 / 404: テキストプレビューと同じ分類。502: サンドボックスへ到達できない / 認証失敗 / 契約外の応答（BFF が zod で検証して弾く）。503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

iframe の中身は応答ヘッダと iframe 属性の両方で隔離する（親の CSP を継承させないために別ルートにする）。CSP は `server/src/routes/files.ts` の `HTML_PREVIEW_POLICY` 1 箇所から導出し、既定は Lv2（相対アセットの `'self'` と `https:`）。

**同じルートが 2 つのオリジンに載る**。BFF はアプリと同じリスナー（`PORT`）と、プレビュー専用の 2 つ目のリスナー（待受は env `PI_FILE_PREVIEW_LISTEN_PORT`、ブラウザから見たポートは env `PI_FILE_PREVIEW_PORT`。既定はいずれも 4318）を立て、`previewApp` にはこのルート 1 本だけを載せる（書き込み系の API は載せない）。文書の CSP はリスナーごとに `sandbox` 段だけが変わり、アプリ オリジンは `sandbox allow-scripts`（オペークオリジン = 隔離）、プレビュー オリジンは `sandbox allow-scripts allow-same-origin allow-pointer-lock`（ストレージ有効モード）。どちらで開くかはクライアントのタブごとのスイッチが iframe の src と属性で選び（既定はプレビュー オリジン）、リクエストにはフラグを付けない（[file-preview.md](file-preview.md#html-プレビュー)）。

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' 'self' https:; script-src 'unsafe-inline' 'self' https:; img-src data: blob: 'self' https:; font-src data: 'self' https:; media-src data: blob: 'self' https:; form-action 'none'
```

プレビュー オリジンの CSP はこの `sandbox` 段だけが `sandbox allow-scripts allow-same-origin allow-pointer-lock;` になる（`connect-src` はどちらにも足さない）。`PI_FILE_PREVIEW_PORT` が指すのはブラウザから見たポートで、待受は `PI_FILE_PREVIEW_LISTEN_PORT`（既定 4318）で独立に決まる。アプリ面の CSP は `frame-src 'self' http://*:<PI_FILE_PREVIEW_PORT>` を持ち、`'self'` は別オリジンを OFF にした（隔離へ戻した）ときの同一オリジン フレームのために残す。

文書のエラーは iframe の中で読めるように HTML 文書で返し、サンドボックス由来の文言は HTML エスケープする。アセットのエラーは JSON で返す（サブリソースに `text/html` を返さない）。方式と残リスクは [file-preview.md](file-preview.md)。

## 画像配信（raw）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/raw?path=<root 相対>` | 画像 / 音声の生配信（チャットの添付サムネイル・ファイル画面のプレビュー） |

サンドボックスの `GET /v1/files/raw` に委譲し、status と `Range` 系ヘッダを含めて応答をそのままストリームで返す。配信するのは画像（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`）と音声（`mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac`）で、SVG / HTML は同一オリジンでスクリプトが動くため配信しない。判定は BFF とサンドボックスの両方で行う。**節の見出しはアンカー（`#画像配信raw`）を保つために据え置き**で、音声を含むようになったのは本文だけ（[sandbox-api.md](sandbox-api.md#get-v1filesraw)）。

- 200: 本文 + `Content-Type`（拡張子から決める）/ `Content-Length` / `Accept-Ranges: bytes` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff`
- 206: 単一の `Range`（`bytes=<start>-<end>` / `bytes=<start>-` / `bytes=-<suffix>`）を満たした部分本文 + `Content-Range: bytes <start>-<end>/<size>` / `Content-Length`（部分の長さ）/ `Accept-Ranges: bytes`。マルチパート / 複数レンジは対象外で、解釈できない `Range`（構文不正・`bytes` 以外の単位・複数レンジ）は無視して 200 を返す（RFC 9110）
- 416: 範囲として解釈できて満たせないときだけ（`bytes=100-` や 0 バイトへの `bytes=0-`、`bytes=-0`）+ `Content-Range: bytes */<size>`。本文は JSON のエラー
- 400 / 404 / 413: allowlist 外（`Not a servable file: …`）/ 未作成・root 外 / 上限（100 MiB）超過。サンドボックス側の文言をそのまま返す。**413 の文言は `File is too large (max … bytes)`**
- 502: サンドボックスへ到達できない / 認証失敗 / 本文が無い
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

クライアントは `client/src/api.ts` の `fileRawUrl(path, version?)` で URL を組み立て、`<img>` / `<audio>` の src に使う（取得はブラウザに任せ、本文は JSON に載せない。再生 / シークの要求はブラウザが `Range` を付けて送る）。version を指定したときだけ `&v=<version>` を付け、未指定なら従来の URL のままにする。`v` は同一 document 内の raw キャッシュを避けるためのクライアント側の版で、サーバーは版別のファイルを保持せず、常に現在のファイルを返す。

版は `client/src/hooks/useImageVersion.ts` の document 内で共有する単調な採番から取得する。各面は mount 時と更新トークン変更時だけ新しい版を割り当て、通常の再描画では同じ版を保つ。`runEndSeq` とパネルの手動更新回数は採番の**合図**であり、その数値を直接 `v` に使わない。独立カウンタの数値や mount ごとのゼロ戻りを URL に使うと、別の面や前の mount で取得済みの古い応答と衝突するため。採番は localStorage へ保存しない（新しい document では in-document キャッシュも作り直される）。StrictMode や破棄された描画で番号が飛んでも、再利用しないことを優先する。画像と音声は同じ版を共有する（どちらも raw の応答で、同じファイルを差し替えたら両方を取り直す）。

`path` はワークスペース root 相対で、セッションの作業フォルダ配下を表示するときは `fileTreeFetchPath(cwd, path)` で前置する。ファイルプレビューは `reloadToken`、assistant 本文の Markdown 画像は `ChatState.runEndSeq` を更新の合図に使う（[file-preview.md](file-preview.md#画像プレビュー)、[markdown.md](markdown.md#画像の-src-解決)）。添付はアップロードごとの一意名で不変なので、URL に版を付けない。

## ダウンロード

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/download?path=<root 相対>` | 通常ファイルは生バイト、ディレクトリは ZIP。どちらも `Content-Disposition: attachment` |
| GET | `/api/files/download/check?path=<root 相対>` | ダウンロードの見積り（種別 / 保存名 / 合計サイズ / エントリ数 / 除外名）。UI は先にこれを呼ぶ |

サンドボックスの `GET /v1/files/download` と `GET /v1/files/download/check` に委譲し、**BFF はワークスペースに触らない**。`download` は本文を JSON に載せずストリーム中継し（既存 `raw` と同じ）、`Content-Type` / `Content-Disposition` / `Content-Length` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` を付け直す。ファイル名の決定（`filename*=UTF-8''…` のエンコードを含む）と上限 / 除外の判定はサンドボックス側で、BFF は `Content-Disposition` を書き換えない（[sandbox-api.md](sandbox-api.md#get-v1filesdownload)）。

```json
// GET /api/files/download/check?path=src (200)
{
  "kind": "archive",
  "name": "src.zip",
  "bytes": 1042263,
  "entries": 209,
  "skipped": ["node_modules", "dist"]
}
```

- 200: ファイルは `application/octet-stream` + `Content-Length`、ZIP は `application/zip`（**長さを確定できないため `Content-Length` を付けない**）。HTML / SVG もここでは配る（`attachment` と `nosniff` でレンダリングさせない。raw の画像 allowlist は通さない）
- check の 200: サンドボックスの応答を `FileDownloadCheckSchema`（zod）で検証してそのまま返す。`kind` は `file` / `archive`、`entries` は ZIP のエントリ数（単体ファイルは 0）、`skipped` は除外規則で実際に落ちた名前
- 400 / 404 / 413: 除外名のディレクトリそのもの・root 外・形式不正（400）、不存在（404）、合計 100 MiB / 10,000 エントリ（単体ファイルも同じ 100 MiB）の超過（413）。サンドボックス側の文言をそのまま返す
- 502: サンドボックスへ到達できない / 認証失敗 / 本文が無い / check の応答が契約外
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

クライアントは `client/src/api.ts` の `getFileDownloadCheck(path)` で先に見積りを取り、`fileDownloadUrl(path)` の URL を `<a download>` のプログラム的クリックで開く（本文を `fetch` して保持しない。100 MiB のメモリを避け、ページ遷移もしない）。確認ダイアログ・エラー表示・行の出し分けは [file-actions.md](file-actions.md#ダウンロード)。

## アーカイブの除外名

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/archive` | 現在の一覧（実効値）と、未設定かどうか・上限を返す |
| PUT | `/api/settings/archive` | 一覧を丸ごと差し替える（上書き保存。空配列は「除外なし」） |
| DELETE | `/api/settings/archive` | 保存行を消して未設定へ戻す（既定名を保存し直さない） |

3 ルートとも同じ形を返す（204 にしないのは、画面が保存 / 既定に戻すの直後に新しい一覧をそのまま映すため）。アプリデータの SQLite を読むため、DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。

```json
// GET /api/settings/archive (200)
{
  "excludeNames": ["node_modules", ".venv", "dist"],
  "defaultExcludeNames": ["node_modules", ".venv", "dist", "…"],
  "overridden": false,
  "maxNames": 100,
  "maxNameLength": 200
}
```

- `excludeNames` は常に**実効値**（health の `archive.excludeNames` と同じ値）。`overridden: false` は行が無い = 既定の一覧を使っており、`true` は保存済みの一覧が正であることを表す（`[]` は「除外なし」で、既定へ戻した状態とは違う）
- `maxNames` / `maxNameLength` は画面が定数を二重持ちしないために返す（サーバーの検証と同じ値）
- PUT の本文は `{ "excludeNames": string[] }`（zod は形だけを見て、値の検証は store 側）。前後の空白は落とし、空文字は無視し、重複は先勝ちで畳む（大文字小文字はそのまま保持）
- 400: 形が違う本文、または 1 セグメント名として不正な名前（空・`.`・`..`・`/`・`\`・制御文字・`maxNameLength` 超）と `maxNames` 超。文言は `除外名に使えない名前があります: <name>` / `除外名は 100 件までです` で、画面はそのまま出す
- 保存 / リセットの応答も GET と同じ形で、`excludeNames` は保存後の実効値になる
- 変更は次のダウンロードから効く（BFF はリクエストごとに実効値をサンドボックスへ渡す。[sandbox-api.md](sandbox-api.md#get-v1filesdownload)）

## セッションへのファイルアップロード

`POST /api/sessions/:id/files?name=<ファイル名>` は選択時の即時アップロードで、保存先は所属スペースの添付置き場（既定スペースは `<appdir>/uploads/<sessionId>/`。置き場は [session-files.md](session-files.md#スペースごとの配置)）で、プロジェクトのリポジトリ内には作らない。JSON ではなく raw ストリームで受け、`bodyGuard`（既定 64 KiB の body 上限と text 化）より前に登録する。仕様と上限は [api-sessions.md](api-sessions.md#post-apisessionsidfiles)、保存の規則は [session-files.md](session-files.md#添付ファイルチャットからのアップロード) を参照する。

`POST /api/skills/files/import?dryRun=true&replace=<名前>` はスキル（`.agents/skills`）の ZIP インポートで、これも raw ストリームで受け、`bodyGuard` より前に登録する。申告された `content-length` が上限を超えるときは本文を送らずに 413 にし、本文の上限はサンドボックス側でも数える（同じ値）。応答はサンドボックスの plan / apply の形を検証してそのまま返し、`dryRun` / `replace` は解釈せず query のままサンドボックスへ渡す。契約は [api-catalog.md](api-catalog.md#ファイルスキルagentsskills)、検証と排他は [sandbox-api.md](sandbox-api.md#スキルのエクスポート--インポート) を参照する。
