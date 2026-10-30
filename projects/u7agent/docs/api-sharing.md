# 公開と共有 API

サービス（serve）の起動・停止と、静的コンテンツの共有（Cloudflare への公開）の HTTP 契約。DTO の正は `server/src/schema.ts`、規約と索引は [api.md](api.md) を参照する。設計は [sandbox.md](sandbox.md#serveサービスの公開と起動停止) と [static-sharing-design.md](static-sharing-design.md) を正とする。

## 共有の除外名

設定 → 共有の「公開の除外」（`/settings/sharing/exclusions`）。Cloudflare へ公開するときに落とす名前で、ダウンロードの除外とは保存行も既定も別（[static-sharing-design.md](static-sharing-design.md#公開の除外)）。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/shared-content-exclusions` | 現在の一覧（実効値）と、未設定かどうか・上限を返す |
| PUT | `/api/settings/shared-content-exclusions` | 一覧を丸ごと差し替える（空配列は「除外なし」） |
| DELETE | `/api/settings/shared-content-exclusions` | 保存行を消して未設定へ戻す（既定名を保存し直さない） |

3 ルートともアーカイブの除外名と同じ形を返す（`excludeNames` / `defaultExcludeNames` / `overridden` / `maxNames` / `maxNameLength`）。値の検証も同じで、追加で `index.html` を拒否する（名前は全階層一致なので、入れ子の `index.html` も落とせなくなる）。400 の文言は `index.html は公開に必要なため除外できません`。壊れた保存値（JSON 配列でない）は 503。

## サービス（serve）の状態と起動・停止

閲覧中の会話から見た、サンドボックスで公開中のサービス（旧称「成果物」）の状態と、起動 / 停止の操作。設計は [sandbox.md](sandbox.md#serveサービスの公開と起動停止)、表示規則は `client/src/lib/servedApp.ts` と `client/test/servedApp.test.ts` を正とする。

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/api/serve/status?sessionId=<id>` | 閲覧中の会話から見た状態（`sessionId` は必須） |
| POST | `/api/serve/start` | 起動（到達可なら他会話のプロセスを停止して置き換える） |
| POST | `/api/serve/stop` | 停止 |
| GET | `/api/serve/runtime/status` | 設定 → ランタイム のサービス面から全体の状態を取得（会話 id は不要） |
| POST | `/api/serve/runtime/start` | 実行状況から会話を指定して起動（全体管理の面。所属スペースを問わない） |
| POST | `/api/serve/runtime/stop` | 設定 → ランタイム のサービス面から現在公開中のサーバーを停止 |
| GET | `/api/serve/debug/status` | 設定 → ランタイム のデバッグ欄から 18000–18099 の待受を取得（会話 id は不要） |
| POST | `/api/serve/debug/stop` | 設定 → ランタイム のデバッグ欄から指定したポートの待受を強制停止 |

作業ディレクトリはサーバーが会話ストアから解決する（client は `cwd` を送らない）。応答は 3 経路とも同じ形で、起動 / 停止の応答も実行後のプローブ結果と新しい世代を含む（押した時点で UI の状態が確定する）。

```json
{
  "reachable": true,
  "owner": { "kind": "mine", "title": "サービスを作る会話" },
  "generation": "8f3c1d2e",
  "command": { "cwd": "projects/foo", "command": "pnpm dev" },
  "secretGeneration": "0f1e2d3c4b5a6978"
}
```

- `reachable`: プローブ（BFF → サンドボックスの listen ポート 8080 への TCP connect）の結果。HTTP は叩かないので、500 を返すアプリでも到達可なら `true`。**「稼働中」は閲覧中の会話のサービスが公開されている意味**で、ポートの空き状況ではない。ブラウザからの HTTP は別経路（BFF のサービス リスナー → サンドボックスの 8080 への転送）で、こちらは到達できないときに 502 を返す。
- `owner.kind`: `mine`（閲覧中の会話が所有者）/ `other`（他会話が所有者）/ `unknown`（到達可だが記録と一致しない）/ `none`（到達不可で所有者なし）。所有者は記録（PID + 起動時刻）と「いま待受しているプロセス」の照合で決め、記録があるだけでは所有者とみなさない。`mine` / `other` のときだけ `title` が載る。
- `generation`: 置き換えの再照合用の不透明な値。起動のたびに変わり、**記録を残したまま生の bash で待受プロセスが入れ替わった場合も変わる**（起動世代と、いま待受しているソケットの inode を合わせたハッシュ）。到達不可（置き換える対象が無い）は `null`。
- `command`: **閲覧中の会話の作業ディレクトリ**の成功実績（`serve_commands`）。無ければ `null` で、他会話の実績は返さない。
- **稼働中のサービスがあるセッションも引き継げる（別スペースへも移せる）**。`serve_commands` は移動先の cwd へ付け替えるが、稼働中プロセスの cwd inode とサンドボックスの `.u7agent/serve/state.json` の記録は移動前のままなので、`command.cwd` が実プロセスと食い違い得る（相対パスで動くアプリは継続し、絶対パス前提のアプリは壊れ得る）。409 で止める案は、セッション経路へ serve を注入する必要があり、単一ユーザーのデモ用途では割に合わないため採らない（[sandbox.md](sandbox.md#serveサービスの公開と起動停止)）。
- `secretGeneration`: 起動時に解決した環境変数（作業環境 → 環境変数）の世代。記録と待受プロセスが一致するときだけ返し、`GET /api/secrets` の `generation` と比べる（[作業フォルダの環境変数](api-settings.md#作業フォルダの環境変数)）。記録が無い / この項目より前の記録は `null`。

`POST /api/serve/start` の body は `{ sessionId, command?, generation? }`。`command` はエージェントの `serve` ツールだけが渡し（GUI は実績を使う）、省略時はその作業ディレクトリの実績を使う。**実績の解決と検証は置き換えの停止より先**で、実績が無ければ既存のサービスを止めずに 400 を返す。`generation` は確認した状態の値で、実行時に変わっていれば 409（UI は新しい状態で確認をやり直す）。`POST /api/serve/stop` の body は `{ sessionId, generation? }`。

エラー: 所有者以外の停止は 403、待受 PID を特定できないときと照合不一致は 409、起動が期限（10 秒）内に到達可にならないとき・到達した待受プロセスがその起動に由来しないとき・停止の解放を確認できないときは 502、サンドボックス未設定は 503、アプリデータ（実績）が使えないときは 503（変更系は `state: "not_stored"` を付ける）。**プローブやサンドボックス呼び出しの失敗は 502 / 503 で返し、`reachable: false` へ丸めない**（UI はリンクも操作も出さない）。

### ランタイムからの全体管理

`GET /api/serve/runtime/status` と `POST /api/serve/runtime/stop` の応答は `{ reachable, owner, generation, command }`。`owner` は記録と待受ソケットが一致し、会話ストアに起動元が残っているときだけ `{ sessionId, title, spaceId }`、それ以外は `null`。`spaceId` は起動元の所属スペースで、引けないときは載せない（リンクの `?space=` に使う）。`command` は一致する稼働記録の `{ cwd, command }` で、会話ごとの成功実績は使わない。到達不可なら `owner` / `generation` / `command` はすべて `null`。記録のない bash 起動は起動元不明とし、推測した会話リンクを返さない。

`POST /api/serve/runtime/start` の body は `{ sessionId, generation? }` で、応答は同じ `RuntimeServeStatus`。**閲覧中の会話に依存せず、会話の所属スペースも問わない**（`/api/serve/start` は `?spaceId` と `sessionId` の所属一致を要求するため、実行状況から別スペースの会話を起動できない）。実装は会話からの起動と同じロック・世代照合・エラー分類を通し、起動コマンドはその会話の作業ディレクトリの成功実績を使う（実績が無ければ既存のサービスを止めずに 400）。到達可なら置き換えなので `generation` を必須の照合に使い、確認後に変わっていれば 409（UI は状態を取り直して確認をやり直す）。サンドボックス未設定は 503。

全体停止の body は `{ generation: "確認した値" }`（空・null・省略・余分な項目は 400）。会話の選択と所有者に依存せず停止でき、会話未作成・起動元不明・削除済みの会話が起動したサービスも対象。既存の会話からの停止権限は変更しない。全体停止も同じロック・世代照合・待受 PID の特定・ポート解放確認を通す。確認後の入れ替わりは 409 で拒否し、自動再試行はしない。同一オリジンの書き込み検査も適用する。

ランタイム画面は4秒ごとに取得し、失敗時はリンクと停止操作を隠す。稼働中なら公開ポートを別タブで開け、既知の起動元へ `/s/<sessionId>?space=<spaceId>` で移動できる（所属が引けないときは `?space=` なしで、保存値で解決させる）。通常クリックは、起動元の所属スペースが分かり一覧にあるときはそのスペースへ切り替えてから会話を開き、それ以外は現在のスペースで起動元の会話だけを取得する。削除済みなどで開けない場合は別の会話へフォールバックせず、未選択のチャットにリンク先を開けなかった旨を表示する。待機中にユーザーが別の会話を選んだ場合はその選択を優先し、失敗通知も出さない。停止には確認ダイアログを出す。公開枠と自動再起動は追加しない。デバッグ用の一覧・停止は別枠で追加する。

### デバッグ用の一覧と強制停止

エージェントの自己検証が使う `127.0.0.1` の `18000–18099`（[sandbox.md](sandbox.md#serveサービスの公開と起動停止)）の待受を、設定 → ランタイム（`/settings/runtime`）の「デバッグ用（エージェント内部）」から回収する。取得は公開枠の status とは別のエンドポイントに分け、失敗しても公開カードの表示を壊さない。

`GET /api/serve/debug/status` はレンジ走査（待受 PID の fd 走査は伴わない）と lease を突き合わせて次を返す。

```json
{
  "servers": [
    {
      "port": 18000,
      "owner": { "sessionId": "…", "title": "…", "spaceId": "…" },
      "command": "pnpm dev --port $U7AGENT_DEBUG_PORT",
      "startedAt": 1770000000000
    },
    { "port": 18005, "owner": null, "command": null, "startedAt": null }
  ]
}
```

- 出るのは**待受 inode があるポートだけ**。TCP connect は使わない（BFF はデバッグの `127.0.0.1` へ接続できない）。一覧のポーリングに重い fd 走査を乗せない
- `owner` は会話ストアに起動元が残っていて、**待受ソケットが起動時と一致する**ときだけ `{ sessionId, title, spaceId }`。削除済みの会話と、待受が起動時と入れ替わった行は `null`（所有者不明。移動リンクを出さない。軽い走査で同一性を確かめられるのは inode だけ）。`spaceId` は所属が引けないとき載せない（リンクの `?space=`）
- `command` / `startedAt` は lease の値で、lease が残っていれば会話が削除済みでも、待受が入れ替わっていても返す。追跡外（lease 無し）は `owner` / `command` / `startedAt` をすべて `null` にする
- lease が残っていて待受が無いポートは一覧に出さず、その場で捨てる（以後は追跡外として見せる）。**待受ソケットの入れ替え（dev サーバーの再起動など）だけでは lease を捨てない**: 停止の照合は起動 PID の子孫を許すため、捨てると会話からの停止と会話削除の回収が起動しなくなる
- 一覧は待受 PID を返さない（fd 走査は停止のときだけ行う）。停止の確認ダイアログもこの一覧の値だけで組む

`POST /api/serve/debug/stop` の body は `{ port }`（欠落・整数以外・レンジ外は 400）。停止対象は常に「いまそのポートで待受している PID」で、世代照合は持たない（同一性はポート）。kill の前に走査で PID / 開始時刻 / inode を取り直し、lease があるときは**起動 PID の子孫か、起動時の PID / 開始時刻 / inode と一致するとき**だけ実行し、解放を確認してから `{ port, released, alreadyStopped }` を返す。既に待受が無いポートは `{ port, released: false, alreadyStopped: true }` を返す（二重停止も成功として扱う）。所有者は問わないので、追跡外の待受も一覧の値（ポート・起動元・コマンド・起動時刻）を見て指定すれば停止できる（レンジ内の無関係なプロセスを構造では防がないため、確認ダイアログは所有者不明でもポートと lease の値を出して実行させる）。

エラー: 待受 PID を特定できないとき、指定ポートを待っているプロセスが lease の起動に由来しないときは 409、解放を確認できないときは 502、サンドボックス未設定とアプリデータが使えないときは 503（変更系は `state: "not_stored"` を付ける）。409 では lease を残すため、起動ツリーから外れた待受はエージェントの `debug_stop` でも一覧からの強制停止でも回収しない（無関係なプロセスを停止しない側に倒す。ポートが待受を失えば lease は掃除される）。

## 共有コンテンツ

静的な成果物を Cloudflare の静的アセットとして公開し、公開先の状態とライフサイクルを管理する。状態遷移・検証・エラーの契約は [static-sharing-api.md](static-sharing-api.md#api-契約) を正とする。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/shared-contents` | 一覧（`?sessionId=` でその会話の共有物だけに絞れる） |
| GET | `/api/shared-contents/preview` | 公開前のプレビュー（`?sessionId=&directory=`）。補助で、確定は公開ジョブ |
| POST | `/api/shared-contents` | 作成して公開を開始（202） |
| GET | `/api/shared-contents/:id` | 詳細と状態 |
| POST | `/api/shared-contents/:id/publish` | 更新（同じ URL へ再公開、202）。`failed` からの再試行と、停止中からの更新も同じ |
| POST | `/api/shared-contents/:id/stop` | 停止（200）。workers.dev を無効にする。未公開の行は `failed` を返し、script の不在が確定したときは 502 と終端状態（`stopped` / `failed` + `lastError`） |
| POST | `/api/shared-contents/:id/resume` | 再公開（202）。同じ URL を有効に戻す。公開実績の無い行は 409 |
| PATCH | `/api/shared-contents/:id` | 表示名の変更（200、変更後の DTO）。URL・状態・時刻は変えない |
| DELETE | `/api/shared-contents/:id` | 削除（204）。provider 側の削除が成功してから行を消す |

```json
// POST /api/shared-contents の入力
{ "sessionId": "…", "directory": "dist", "name": "デモ" }
// 202 応答
{ "id": "…", "status": "publishing" }
// PATCH /api/shared-contents/:id の入力（前後の空白はサーバーで落とす）
{ "name": "モンスト風" }
// POST /api/shared-contents/:id/stop の 200 応答（公開実績のある行）
{ "id": "…", "status": "stopped" }
// 公開実績の無い行は status が "failed" になり、lastError に固定文言が入る
```

一覧・詳細は `{ id, sessionId, name, sourcePath, sourceKind, provider, status, publicUrl, createdAt, updatedAt, publishedAt, stoppedAt, lastError }`。`sourceKind` は公開元の種類で、`session-root` はセッションの作業フォルダ自身、`directory` はその配下のディレクトリ。`remoteId` / `providerAccount` は返さない。`status` の値は `SharedContentStatus`（`server/src/app-db.ts`）と schema を正とし、`lastError` は分類済みの固定文言だけを入れる。

表示名の変更は空欄・制御文字・100 文字超を 400 にし、本文の検証失敗と同じく `state: "not_stored"` を付ける。存在しない id は 404、保存失敗は 503。provider を呼ばないので `publishing` の行にも送れるが、画面の導線は状態が確定してから出す（[static-sharing.md](static-sharing.md#gui管理一覧)）。

- `directory` はセッションの作業ディレクトリ相対。絶対パス・`..`・ワークスペース root 自身は 400。字面が `.`（`./` を含む）のときだけセッションの作業フォルダ自身を指し、`projectCwd` を持つプロジェクト会話では 409。`a/..` や `./.` は正規化すると `.` になるが、字面が `.` でないため 400（`foo/.` は従来どおり `foo`）。

プレビュー（`GET /api/shared-contents/preview`）は、公開と同じ対象解決と sandbox の計画（`GET /v1/files/download/plan`）を使い、公開したときに上がるものを先に見せる。応答は `{ sourcePath, entries, bytes, files, truncated, links, linksTruncated, oversizeFiles, oversizeTruncated, hasIndexHtml, skipped, excludeNames, limited, problems }`。

- 件数はディレクトリも数える。`files` / `links` / `oversizeFiles` は先頭だけを返し、それぞれ打ち切りの印を持つ。`links` は symlink / 特殊ファイルで、公開されない
- `excludeNames` は実効の除外名（公開の除外の設定。対象ディレクトリ自身の名前は落とした後）。公開も同じ値（明示 `exclude=`）で取得する
- 合計サイズ・件数の上限超過（413）は `limited: true` にし、`entries` / `bytes` / `hasIndexHtml` は `null`、一覧は空、`problems` は上限超過の 1 件だけにする（走査が終わっていないので `index.html` の不在は判定しない）
- `limited: false` のときだけ `index.html` 不在と 1 ファイル 25 MiB 超を `problems` に入れる。問題なしと言い切らない（秘密値の検査は ZIP を読むまでできない）
- パス不正は 400、セッションなしは 404、`directory` がファイルなら 409、プロジェクト会話で `.` を指定したら 409（作成と同じゲート）、サンドボックス未設定は 503。Cloudflare の資格情報は使わない（接続未登録でも見られる）
- `GET /api/shared-contents/:id` と衝突しないよう、専用のルートを先に登録する
- 一覧は `sessionId` クエリで絞れる（共有ダイアログの「この会話の共有物」）。省略時は全件、空文字は指定なしとして扱う。
- ソースは sandbox の `GET /v1/files/download?path=<dir>&exclude=…`（受付時に解決した公開の除外名。空でも明示）で全量 ZIP を取得し、`index.html` の存在、10,000 entries / 100 MiB / 1 ファイル 25 MiB、パス・symlink、既知の秘密値を検証する。違反は部分公開せず `failed`（更新なら前回の状態 + `lastError`）。
- 作成と更新は、公開元の会話か、同じ作業フォルダを共有する会話（同じプロジェクト）が実行中（実行 / キュー待ち / 圧縮中）なら 409。取得する ZIP は live なディレクトリなので、書き換えの途中では「`index.html` は新版で資産は旧版」のような半端なスナップショットが外部公開 URL に載り得る（[static-sharing.md](static-sharing.md#gui共有ダイアログ)）。プレビュー・停止・再公開・削除・表示名の変更は成果物を読まないので実行中も通す。受付後に run が始まるケースは止めない（窓を狭めるだけで、保証ではない）。
- 資格情報が未登録なら 409。保存済みの `providerAccount` が現在の接続と違う場合も 409。
- 停止・再公開・削除は `sourcePath` とセッションを必要としない（セッションを削除しても管理できる）。セッション / ソースが要るのは更新だけ。
- 公開実績の無い行を停止しても `stopped` にはしない。応答は `200 { id, status: "failed" }` で、行の `lastError` に固定文言が入り、`stoppedAt` は入らない。再公開は `publishedAt === null` を 409 で拒否し、更新を促す固定文言を返す。更新の失敗も同じ規則で戻り先を決める（停止中からの更新の確定失敗は `stopped` + `lastError`、未公開の行なら `failed`）。
- 停止は `published` と、結果不明で `publishing` のまま残った行から受け付ける。`failed` / `stopped` と進行中の `publishing` は 409。再公開は `stopped` のうち公開実績（`publishedAt !== null`）のある行だけ。更新は `published` / `failed` / `stopped` を受け付ける（停止中からの更新は成果物を送り直し、成功時に subdomain を有効へ戻す）。削除は `publishing` を一律で 409 にし、停止で状態を確定させてから行う。
- script の不在が確定した場合（照会の 404、停止 / 再公開の要求自体の 404）は、一度も公開できていない行だけ `failed` にし、公開実績のある行は `stopped` + `lastError`（`publishedAt` は残す）にする。停止の場合は `502` を返し、行は `publishing` のまま残さない（削除できる）。照会できない間は `publishing` + `lastError` に留める。
- 削除は provider が 404 を返したときも成功扱い（外部で既に消えている）。同じ id への 2 回目は行が無いので 404。
- 同じ id の変更系が進行中なら 409（表示名の変更は provider を呼ばず状態も変えないので対象外）。停止 / 再公開 / 削除の状態保存に失敗したときは provider の操作を成功として返さず 503（操作は冪等なので再試行で収束する）。
- 変更系の失敗は `{ error }`。`state: "not_stored"` は「この要求で行を保存しなかった」ときだけ付き、`published` になったかは GET で確認する。停止の `502` は終端状態 / `publishing` / 開始状態のいずれかを保存してから返すため `state` を付けない（状態保存に失敗した `503` は未保存なので付く）。
- 一覧・詳細・プレビュー（GET）の失敗応答は `{ error }` だけで、`state` を付けない（読み取りは何も保存しない）。
- Cloudflare の応答本文と API トークンは応答・ログ・`lastError` に載せない。

### Cloudflare の接続

設定 → 共有 → 接続（`/settings/sharing/connections`、既定タブの正準形は `/settings/sharing`）。BFF 専用の資格情報で、API トークンは write-only（応答・ログ・agent / sandbox へ出さない）。保存方式と権限は [static-sharing-design.md](static-sharing-design.md#cloudflare-資格情報) を正とする。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/cloudflare` | 登録状態とアカウント ID |
| PUT | `/api/settings/cloudflare` | 登録・更新 |
| DELETE | `/api/settings/cloudflare` | 削除（冪等） |
| POST | `/api/settings/cloudflare/check` | 保存済みの資格情報で接続を確認（何も保存しない） |

```json
// GET / PUT / DELETE の応答
{
  "configured": true,
  "accountId": "0123456789abcdef0123456789abcdef",
  "available": true,
  "unavailableReason": null
}
```

```json
// PUT の入力
{ "accountId": "0123456789abcdef0123456789abcdef", "apiToken": "…" }
```

- `accountId` は 32 桁の 16 進数。前後の空白を除き、小文字へ正規化する。
- `apiToken` は空白を含まない印字可能文字 20〜512 文字。初回は必須で、2 回目以降は省略でき、その場合は保存済みの暗号文を維持する。
- 変更系の成功応答は `state: "applied"` を足す。保存されなかった 503 は `{ "error": "…", "state": "not_stored" }`。
- `available: false` は暗号化の master key が未設定 / 読めない状態。このとき PUT は 503 になり、トークンの復号も 503 になる。
- 別アカウントで公開した共有物が残っているアカウントへの登録・切替は 409。資格情報を削除しても共有物の `providerAccount` は残るため、削除 → 別アカウント登録でも迂回できない。
- エラー文言にはトークンを含めない。`GET` は `accountId` と登録状態だけを返す。

### `POST /api/settings/cloudflare/check`

保存済みの資格情報が Cloudflare へ届くかを、`GET /accounts/{account_id}/workers/subdomain` 1 本で確認する。未保存の下書きは確認しない（トークンの経路を 1 本に保つ）。結果は保存せず、応答にだけ載せる。`GET /api/settings/cloudflare` はこの確認に依存せず、外部通信しないまま。

```json
// 200（成功）
{
  "checkedAt": 1730000000000,
  "accountId": "0123456789abcdef0123456789abcdef",
  "subdomain": "demo",
  "failure": null,
  "httpStatus": null,
  "message": null
}
```

```json
// 200（Cloudflare 側の失敗）
{
  "checkedAt": 1730000000000,
  "accountId": "0123456789abcdef0123456789abcdef",
  "subdomain": null,
  "failure": "unauthorized",
  "httpStatus": 403,
  "message": "Cloudflare のアカウント ID または Workers Scripts の権限を確認してください"
}
```

- **`failure === null` が成功**。成功は `subdomain` が非空・`message` が `null`、失敗は `subdomain` が `null`・`message` が非 null。`failure` は `unauthorized` / `not_found` / `quota` / `rate_limited` / `invalid` / `transient` / `timeout` / `network` / `unverifiable` に、空の subdomain を表す `no_subdomain` を加えた値（正は `server/src/schema.ts`）。
- **Cloudflare 側の失敗も 200 で返す**。HTTP エラーにすると、分類（`failure`）と `httpStatus` がクライアントの汎用エラー経路へ落ちて結果として扱えなくなるため。
- `httpStatus` は Cloudflare が返した 400 以上の status だけ。`unverifiable` は 2xx を持ち得るので、失敗行に `HTTP 200` を出さない。`timeout` / `network` / `no_subdomain` は `null`。
- `message` は接続確認専用の固定文言。401 と 403 は status で分ける（401 はトークンの拒否、403 はアカウント / `Workers Scripts` の権限かアカウント ID の誤り）。404 はアカウント ID と workers.dev の設定へ寄せ、公開向けの Worker の文言を出さない。
- 空の subdomain は workers.dev 未有効として失敗にし、公開の受付（409）と同じ文言を使う。
- 未登録は 409、master key 不在・復号不可は 503。どちらも `state` を付けない（何も保存しない操作なので `not_stored` ではない）。
- API トークンと Cloudflare の応答本文は、応答・ログ・例外へ載せない。
