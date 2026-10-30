# 静的コンテンツ共有の API 契約

静的コンテンツの公開・更新・停止・再公開・削除と、Cloudflare 接続の HTTP 契約。DTO の正は `server/src/schema.ts`、規約と索引は [api.md](api.md) を参照する。設計判断は [static-sharing-design.md](static-sharing-design.md)、画面は [static-sharing.md](static-sharing.md) を正とする。

## API 契約

作成・一覧・詳細・更新・停止・再公開・削除を実装済み。エラーの形は既存の API と同じ `{ error }` とし、何も保存していない変更系の失敗には `state: "not_stored"` を付ける。

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/api/shared-contents` | 一覧（`?sessionId=` で会話の共有物だけに絞れる） |
| `GET` | `/api/shared-contents/preview` | 公開前のプレビュー（`?sessionId=&directory=`）。補助で、確定は公開ジョブ |
| `POST` | `/api/shared-contents` | 作成して公開を開始（202） |
| `GET` | `/api/shared-contents/:id` | 詳細と状態 |
| `POST` | `/api/shared-contents/:id/publish` | 更新（同じ URL へ再公開、202）。`failed` からの再試行と、停止中からの更新も同じ経路 |
| `POST` | `/api/shared-contents/:id/stop` | 停止（200）。未公開の行は `status: "failed"` を返す |
| `POST` | `/api/shared-contents/:id/resume` | 再公開（202）。公開実績の無い行は 409 |
| `PATCH` | `/api/shared-contents/:id` | 表示名の変更（200、変更後の DTO） |
| `DELETE` | `/api/shared-contents/:id` | 削除（204） |
| `GET` | `/api/settings/cloudflare` | 登録状態（トークンは返さない） |
| `PUT` | `/api/settings/cloudflare` | 登録・更新 |
| `DELETE` | `/api/settings/cloudflare` | 削除 |
| `POST` | `/api/settings/cloudflare/check` | 保存済みの資格情報での接続確認（何も保存しない。詳細は [api-sharing.md](api-sharing.md#post-apisettingscloudflarecheck)） |
| `GET` | `/api/settings/shared-content-exclusions` | 公開の除外名（実効値・未設定かどうか・上限） |
| `PUT` | `/api/settings/shared-content-exclusions` | 一覧を丸ごと差し替える（空配列は「除外なし」） |
| `DELETE` | `/api/settings/shared-content-exclusions` | 保存行を消して未設定（既定）へ戻す |

作成の入力は `{ sessionId, directory, name? }`。`directory` はセッションの作業ディレクトリ相対で、BFF が root 相対の `sourcePath` へ解決して保存する。絶対パス・`..`・ワークスペース root 自身を指す指定は 400。字面が `.` のときだけセッションの作業フォルダ自身を指し、プロジェクト会話では 409（[セッションと作業ディレクトリ](static-sharing-design.md#セッションと作業ディレクトリ)）。`name` を省略したときはディレクトリ名（root ではセッション ID）を使う。

一覧は `sessionId` クエリで絞り込める（共有ダイアログの「この会話の共有物」）。省略時は全件で、管理一覧はこちらを使う。空文字は指定なしとして扱う。

表示名の変更は `{ name }` だけを受け、前後の空白を落として保存する。空欄（空白だけを含む）・制御文字・100 文字超は 400（本文の検証失敗と同じく `state: "not_stored"`）、存在しない id は 404、保存失敗は 503。provider を呼ばず、状態・`updatedAt`・`publishedAt`・`stoppedAt` を変えないため、`publishing` の行にも受け付ける（画面は確定してから出す）。同じ名前を送ったときは何も書かない。

公開の受付時に `sourcePath` の存在を sandbox へ確認する。ソースは `GET /v1/files/download?path=<dir>&exclude=…` で ZIP 全量を取得し、`exclude` には受付時に解決した公開の除外名（[公開の除外](static-sharing-design.md#公開の除外)）を渡す（空でも明示する）。ZIP は一時ディレクトリへ展開し、成功・失敗にかかわらず削除する。

プレビューは `GET /api/shared-contents/preview?sessionId=&directory=`。公開と同じ対象解決と `GET /v1/files/download/plan` を使うが、**公開の入力には使わない**（差し替えの競合と秘密値の検査は公開ジョブだけが確定できる）。応答は `{ sourcePath, entries, bytes, files, truncated, links, linksTruncated, oversizeFiles, oversizeTruncated, hasIndexHtml, skipped, excludeNames, limited, problems }`。

- `entries` はディレクトリも数える。`files` / `links` / `oversizeFiles` は先頭だけを返し、それぞれ打ち切りの印を持つ
- 上限超過（413）は `limited: true` にし、`entries` / `bytes` / `hasIndexHtml` は `null`、一覧は空、`problems` は上限超過の 1 件だけにする（走査が終わっていないので `index.html` の不在は判定しない）
- `limited: false` のときだけ `index.html` 不在と 1 ファイル 25 MiB 超を `problems` に入れる。問題なしと言い切らない
- パス不正 400 / セッションなし 404 / `directory` がファイル 409 / サンドボックス未設定 503。Cloudflare の資格情報は使わない
- `GET /api/shared-contents/:id` と衝突しないよう、専用のルートを先に登録する

**除外が入る前（Phase 1）は `excludeNames` が空配列で、公開も `exclude=[]` のままだった。** 現在は最後の Phase で追加した「公開の除外」（[公開の除外](static-sharing-design.md#公開の除外)）が実効値になり、同じダイアログの `excludeNames` と `skipped` に反映される。共有物（`shared_contents`）は除外を記録しないため、設定を変えて既存の公開物が変わるのは次の更新から。

公開の除外名の API は 3 ルートとも同じ形を返す（204 にしないのは、画面が保存 / 既定に戻すの直後に新しい一覧をそのまま映すため）。`appData` ゲートを持ち、DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。

```json
// GET /api/settings/shared-content-exclusions (200)。一覧の中身は保存値 / 既定値で、正はコード
{
  "excludeNames": ["…"],
  "defaultExcludeNames": ["…"],
  "overridden": false,
  "maxNames": 100,
  "maxNameLength": 200
}
```

- `excludeNames` は常に実効値。`overridden: false` は行が無い = 既定の一覧で、`true` は保存済みの一覧が正（`[]` は「除外なし」で、既定へ戻した状態とは違う）
- `maxNames` / `maxNameLength` は画面が定数を二重持ちしないために返す（保存時の検証と同じ値）
- PUT の本文は `{ "excludeNames": string[] }`。前後の空白は落とし、空文字は無視し、重複は先勝ちで畳む
- 400: 形が違う本文、1 セグメント名として不正な名前、`index.html`、`maxNames` 超。文言は理由をそのまま返す

公開前の検証:

- `index.html` がルートに存在すること（SPA の入口）
- ファイル数 10,000 件以内、合計 100 MiB 以内、1 ファイル 25 MiB 以内
- 絶対パス・`..`・重複・symlink・特殊ファイルを含まないこと
- `retainSecret()` が保持する既知の秘密値と完全一致する内容を含まないこと
- 上記のいずれかに違反したら部分公開せず、共有物を `failed`（更新なら前回の状態 + `lastError`）にする

非同期の受付（作成・更新・再公開）は `202 { id, status: "publishing" }` を返し、状態は GET で読む。停止は provider の結果を待って `200 { id, status }` を返す（停止は subdomain の切替 1 回で終わり、`publishing` を経由しない）。`status` は公開実績のある行なら `stopped`、無い行なら `failed` で、後者の `lastError` には固定文言が入る。script の不在が確定した停止は `502` を返し、行は `stopped`（公開実績あり）/ `failed`（未公開）+ `lastError` に確定する。削除は本文なしの `204`。

状態遷移を伴う変更系は共有物 id 単位で排他し、同じ id の操作が進行中なら状態を読まずに `409` を返す。別の共有物の操作は待たせない。表示名の変更は排他の対象外（provider を呼ばないため）。

公開は BFF のバックグラウンドジョブで、受付は応答だけを返す。`publishing` 中の状態遷移を伴う別の変更は `409`（表示名の変更だけは受け付ける）。受付の失敗（セッションなし 404、ソースなし / 資格情報なし / アカウント不一致 / 状態不一致 409、DB・sandbox 503、Cloudflare の受付失敗 502）は 202 を返さない。

一覧・詳細の DTO は `{ id, sessionId, name, sourcePath, provider, status, publicUrl, createdAt, updatedAt, publishedAt, stoppedAt, lastError }`。`lastError` は利用者に見せられる分類済みの文言だけを入れ、provider のレスポンス本文やトークンを含めない。`remoteId` / `providerAccount` は通常の UI に出さない。

状態遷移:

| 現在 | 操作 | 次 |
| --- | --- | --- |
| なし | 作成 | `publishing` |
| `publishing`（初回） | 成功 | `published` |
| `publishing`（初回） | 確定した失敗 | `failed` |
| `publishing`（公開・更新・再公開） | 結果不明 | `publishing`（+ `lastError`、停止のみ可） |
| `publishing`（+ `lastError`） | 停止 | `stopped`（公開実績あり）/ `failed`（未公開） |
| `failed` | 公開（再試行） | `publishing` |
| `failed` / 公開実績の無い `published`・`stopped` | 公開（更新） | `publishing`（確定失敗は `failed`） |
| `published` | 更新 | `publishing` |
| `publishing`（更新） | 成功 | `published` |
| `publishing`（更新） | 確定した失敗 | `published`（+ `lastError`） |
| `stopped` | 更新 | `publishing` |
| `publishing`（停止中からの更新） | 確定した失敗 | `stopped`（+ `lastError`、`publishedAt` / `stoppedAt` を維持） |
| `published` | 停止 | `stopped` |
| `published` | 停止（確定した失敗） | `published`（+ `lastError`） |
| `published` / `publishing`（+ `lastError`） | 停止（結果不明で照会不能） | `publishing`（+ `lastError`、停止のみ可） |
| `published` / `publishing`（+ `lastError`） | 停止（script 不在が確定） | `stopped` + `lastError`（公開実績あり）/ `failed`（未公開） |
| `stopped` | 再公開 | `publishing` |
| `stopped`（公開実績なし） | 再公開 | `409`（更新で公開し直す） |
| `publishing`（再公開） | 成功 | `published` |
| `publishing`（再公開） | 確定した失敗 | `stopped`（+ `lastError`） |
| `publishing`（再公開、script 不在が確定） | 収束 | `stopped` + `lastError`（公開実績あり）/ `failed`（未公開） |
| `published` / `stopped` / `failed` | 削除 | 行なし |

- `publishing` の共有物への状態遷移を伴う別の変更は `409`。ただし結果不明で止まった行への停止だけは受け付ける（削除は停止で確定させてから）。表示名の変更は状態を変えないため、`publishing` でも受け付ける。
- 停止の結果不明は、subdomain を照会できたときだけ確定する（無効なら `stopped` / `failed`、有効なら開始状態 + `lastError`。開始状態が `published` でも公開実績が無ければ `failed` にする）。照会できない間は開始状態にかかわらず `publishing` + `lastError` に留め、停止を受け付ける。停止をやり直すか、接続が戻ってから停止で確定させる。
- **「結果不明」と「script の不在が確定」は別扱い**。停止・再公開の要求自体が 404 を返した場合と、照会が 404 を返した場合は、外部に公開物が無いことの確定なので、公開実績に応じた終端（公開実績あり → `stopped` + `lastError`、未公開 → `failed`）へ収束させる。`publishing` のまま残して停止も削除もできない状態にはしない（停止の応答は `502`）。
- 停止中からの更新は成果物を送り直し、成功時に subdomain を有効へ戻す。失敗時の戻り先は公開実績で決め、未公開の行は `failed` にする。再公開は `publishedAt` を進めないが、更新は新しい deployment を積むので進める。
- 再公開は確定失敗なら `stopped` + `lastError` に戻し、結果不明は照会できたときだけ確定する（有効なら `published`、無効なら `stopped` + `lastError`）。照会できない間は `publishing` + `lastError` に留める。再公開は版を変えないので `publishedAt` を進めない。
- 復帰・照会の結果 script が無いと分かった場合、一度も公開できていない行は `failed`、公開実績のある行は `stopped` + `lastError`（`publishedAt` は残す）にする。`failed` は「一度も公開できていない」場合だけに使い、公開実績を消さない。
- `lastError` は受付時に消し、公開・更新・再公開・停止の成功時も消す。確定した失敗と結果不明のときだけ、分類済みの文言を入れる（未公開の行を停止したときの固定文言も含む）。
- 表示名の変更は状態遷移を持たない（`status` / `lastError` / 時刻を変えない）。公開中の行にも受け付けるが、画面の導線は状態が確定してから出す。
- 操作の成否は終端の `status` と `lastError` で判定する。公開・更新・再公開は `published` かつ `lastError` が null なら成功、停止は `stopped` かつ null なら成功（未公開の行の停止は `failed` + 固定文言を返す）。`publishing` + `lastError` は結果不明で、停止を再試行すると公開実績に応じて `stopped` / `failed` に確定する。
- 存在しない id は `404`。他の共有物を誤って操作しないよう、id だけで対象を決める。
- 記録した `providerAccount` が現在の接続と一致しないときは `409`。資格情報を入れ替えても既存共有物の操作先を変えない。
- 更新はセッションが存在し、`sourcePath` が実在するときだけ受け付ける。どちらかが欠けていれば `409`。停止・再公開・削除はこの条件を見ない。
- 削除は provider 成功後に `204`。provider が 404 を返したときも成功扱い。`providerAccount` または `remoteId` が無い行は provider を呼ばずに行だけ消す。それ以外の provider 失敗では行を残して `502`。同じ id への 2 回目の削除は行が無いので `404`。
- 資格情報が未登録のときの公開・停止・再公開・削除は、provider を呼ぶ前に `409` で止める。
- 停止・再公開・削除の状態保存に失敗しても provider の操作は成功扱いにせず `503` を返す。操作が冪等なので、再試行すると同じ結果へ収束する。
- 一覧のページングは初期実装では持たない（個人運用の件数に収める）。
- Cloudflare の失敗は認証 / 不存在 / 枠不足 / レート制限 / 一時障害 / タイムアウト / 通信不能に分類し、固定文言だけを `lastError` と応答へ載せる。応答本文とトークンは載せない。タイムアウト・通信不能・5xx は結果不明として workers.dev subdomain を照会し、確定できなければ `publishing` + `lastError` に留める。
