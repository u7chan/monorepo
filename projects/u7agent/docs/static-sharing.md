# 静的コンテンツ共有

エージェントが会話の中で生成・ビルドした静的成果物を Cloudflare へ公開し、共有 URL を管理する機能の設計。
`serve`（サービス）とは別機能として扱い、実装より先に決めた契約と、採用しなかった案、既知の制限を残す。
状態・列・上限値の正は実装とテスト（[persistence.md](persistence.md#アプリデータsqlite)）。

## 責務の分離

| | `serve`（サービス） | 静的コンテンツ共有 |
| --- | --- | --- |
| 対象 | サンドボックスの `:8080` で動くアプリ（動的も可） | ビルド済みの静的成果物だけ |
| 公開先 | BFF 経由の一時プレビュー | Cloudflare（workers.dev） |
| 寿命 | プロセスが動いている間 | 停止・削除するまで |
| URL | アプリを開いている間だけ有効 | 外部へ配れる安定 URL |
| 起動 | コマンドを実行する | 実行しない（成果物を置くだけ） |

`ServeService` / `serve` tool と実装・状態を共有しない。共有は「ビルド済みディレクトリをスナップショットとして置く」だけで、
ビルドやサーバー起動は行わない（ビルドはエージェントが既存の bash で行う）。

## 全体の流れ

```text
セッション（作業ディレクトリ）
  │ エージェントが HTML / CSS / JS を生成し、必要なら pnpm build
  ▼
source_path（例 dist/）
  │ BFF がサンドボックスから ZIP で取得して検証
  ▼
BFF（Cloudflare 資格情報はここだけ）
  │ manifest 登録 → アセット送信 → version / deployment
  ▼
Cloudflare Workers（workers.dev）
  ▼
公開 URL
```

## 決定事項

### 公開単位と URL

- **1 共有物 = 1 Worker（script）**。1 セッションに複数の共有物を持てる（例: HTML を 3 パターン作り、3 つを別々に公開する）。
- script 名は共有物の id から機械生成し、以後変えない。表示名を変えても URL は変わらない。
- URL は `https://<script-name>.<account>.workers.dev/` だけを使う。custom domain / route / zone の設定は行わない（ドメインを持たない前提）。
- Worker は静的アセットだけを持ち、Worker スクリプトを置かない。Worker が起動しないため、配信は Workers のリクエスト数として課金されない。

### Cloudflare 資格情報

- BFF 専用。API トークンとアカウント ID は `cloudflare_settings` に保存し、トークンは既存 `server/src/secret-crypto.ts` の AES-256-GCM で暗号化する（[secrets.md](secrets.md#master-key-と保存時の暗号化)）。
- 設定 API は write-only。`GET /api/settings/cloudflare` は `{ configured, accountId, available, unavailableReason }` を返し、トークンは返さない。`available: false` は master key が使えない状態で、登録は 503 になる。
- `PUT /api/settings/cloudflare` は `{ accountId, apiToken? }`。初回はトークンが必須で、2 回目以降は省略できる（省略時は保存済みの暗号文を維持する）。アカウント ID は 32 桁の 16 進数へ正規化し、トークンは空白を含まない印字可能文字 20〜512 文字に限る。
- `DELETE /api/settings/cloudflare` は行を消す（冪等）。共有物の `providerAccount` は消さない。
- 別アカウントで公開した共有物が残っている間は、そのアカウントの登録・切替を 409 で拒否する。資格情報を消してから別アカウントを登録する経路も塞ぐ。
- 保存・復号したトークンは `retainSecret()` へ渡し、例外やログに値が現れてもマスクする。平文を読むのは公開処理の `CloudflareSettingsService.credential()` だけで、応答・tool・sandbox へ渡す経路を持たない。
- サンドボックスの環境変数、agent tool の引数、`session.jsonl`、ログ、tool 出力へ渡さない。
- 登録・読み込み時に `retainSecret()` へ渡し、例外やログに値が現れてもマスクする。
- アセット送信に使うアップロード用 JWT は API トークンとは別物で、メモリ上だけで使う。
- master key を失うと保存済みトークンは復号できない。再登録が必要になる（鍵の置き場所はデプロイ側の責務）。

### 記録と移行

- `shared_contents` と `cloudflare_settings` をアプリデータの SQLite に持つ。列は `server/src/app-db.ts` を正とする。
- どちらも**列追加だけの加算移行**を恒久ルールとし、`DROP_TABLES` に入れない（[persistence.md](persistence.md#アプリデータsqlite)）。行が消えると Cloudflare 側の公開物を追跡・停止・削除できなくなるため。
- `shared_contents` は `provider` と `providerAccount` と `remoteId` の組を一意にし、同じ公開先を 2 つの共有物が指さないようにする（`remoteId` が未作成の行は複数持てる）。
- 公開の受付時に `provider` / `providerAccount` / `remoteId` / `publicUrl` を確定して保存する（script 名は id から、URL は script 名とアカウントの workers.dev サブドメインから決まり、以後変えない）。
- 公開先のアカウントを `providerAccount` に記録する。更新・停止・再公開・削除は記録したアカウントへ行い、現在の接続と一致しないときは provider を呼ばずに `409` で拒否する。資格情報の削除・再登録では `providerAccount` を消さない。
- 公開済みの共有物がある状態で別のアカウントへ接続を切り替える要求は `409` にする。切り替えるには、旧アカウントで共有物を停止・削除してから登録し直す。

### アカウント側の権限

- トークンには Workers の **Admin（product scope）** が要る。Cloudflare の Workers ロールでは、既存 Worker の更新は `Editor` で足りるが、**新規作成と削除は Admin が要る**（per-Worker の権限は存在しない Worker には付与できない）。
- `Workers Routes` などの zone 権限は不要（workers.dev のみ使うため）。
- 権限の範囲はアカウント内の全 Worker に及ぶ。トークンの漏洩時の影響が広いので、保存先とマスクの扱いを他機能より厳しくする。
- 実装時に、実際のトークンで作成・更新・停止・削除が通ることを確認し、必要な権限名を確定する（下表の実機確認）。

### 共有物のライフサイクル

状態は `SharedContentStatus`（`server/src/app-db.ts`）で表し、許可する遷移は API 側で検証する。`status` は**外部から見た現在の公開状態**で、最後の操作の成否ではない。

- `failed` は一度も公開できていない状態（復帰時に外部の script が無いと分かった場合も含む）。停止は受け付けず、公開の再試行だけを受け付ける。
- 公開済みの共有物の更新・再公開・停止が**確定した失敗**をしたときは、前回の状態（`published` / `stopped`）へ戻し、理由を `lastError` に残す。旧 deployment は有効なままなので、外部の状態と DB を一致させる。
- provider の結果が不明なとき（timeout など）は状態を確定させない。`publishing` のまま `lastError` を記録し、**停止だけ**を受け付ける。停止は subdomain を無効にする冪等な操作なので、外部が公開中でも安全側に倒せる。
- `stoppedAt` は停止で立ち、公開成功で消す。
- 停止は `published` と、結果不明で `publishing` のまま残った行から受け付ける。

| 操作 | Cloudflare 側 | 必要なもの |
| --- | --- | --- |
| 公開 | script 作成 + アセットの deployment | `source_path` の成果物、セッション、資格情報、Worker の残枠 |
| 更新 | 同じ script に新しい deployment（URL は変わらない） | `source_path` の成果物、セッション、資格情報 |
| 停止 | workers.dev の subdomain を `enabled=false` にする | 資格情報だけ（成果物・セッションは不要） |
| 再公開 | 同じ subdomain を `enabled=true` に戻す | 資格情報だけ（成果物・セッションは不要） |
| 削除 | script を削除してから DB の行を消す | 資格情報だけ（成果物・セッションは不要） |

- すべての操作は、記録した `providerAccount` の資格情報が登録されているときだけ行える。
- 停止と削除は別操作。停止は URL と行を残したまま外部閲覧だけを止める。
- 削除は provider 側の削除が成功してから行を消す。provider が「既に無い」を返したときだけ成功扱いにし、それ以外の失敗で行を消さない。
- 削除中を表す状態は設けない（同期削除 + 共有物単位のロックで足りるため）。追加するなら状態遷移とセットで設計する。
- 変更系は共有物 id 単位でロックし、全共有物を 1 本に直列化しない。

### セッションと作業ディレクトリ

- `sessionId` から BFF が作業ディレクトリを解決する。公開の入力 `directory` はその作業ディレクトリ相対で、保存する `sourcePath` はワークスペース root 相対へ解決した値。client / agent から任意のホストパスは受け取らない。
- 絶対パス・`..`・symlink でワークスペース root の外へ出る指定は拒否する。
- セッションを削除しても共有物の行は残す。設定 → 共有（`/settings/sharing`）の一覧から停止・再公開・削除できる。
- 更新はセッションが存在し、その作業ディレクトリ配下に `sourcePath` が実在するときだけ行える。セッションが無い / ソースが無い場合は更新だけを明示エラーにし、停止・再公開・削除は通す。セッション削除では作業フォルダが残るが、`sourcePath` の意味が履歴になるため更新の可否はセッションの存在も条件にする。
- 公開はスナップショット。`source_path` の中身を書き換えただけでは反映されず、更新したときだけ反映される。

### 公開の実行モデル

Cloudflare への送信は時間がかかるため、同期 HTTP では扱わない。

- 公開・更新・再公開は受付だけを返し（`202`）、状態は GET で読む。GUI は状態をポーリングして表示する。
- 受付時に `lastError` を消して `publishing` にする。終端は `publishing` でなくなったときで、成功・失敗は `status` と `lastError` の組で読む。
- agent tool は受付のあと内部で終端までポーリングし、状態が確定してから URL かエラーを返す。`publishing` + `lastError`（結果不明）を見たらそこで打ち切って、停止で安全側に倒すよう案内する。
- provider の結果が不明になったとき（timeout など）と、BFF 再起動で `publishing` のまま残ったときは、subdomain を問い合わせて状態を確定する。有効なら `published`、無効なら `stopped`、script が無ければ `failed`。更新・初回公開の中断では配信中の版が分からないため、その旨を `lastError` に残す。問い合わせできないときだけ `publishing` + `lastError` に留め、停止だけを受け付ける。
- 停止の結果が不明なときも同じ問い合わせを行う。無効なら `stopped`、有効なら `published` + `lastError`（停止を再試行できる）。問い合わせできない間は、開始状態が `published` なら `published` + `lastError`、結果不明の `publishing` からなら `publishing` + `lastError` に留める（誤って「停止済み」と表示しない）。
- deployment 成功後に DB を更新できなかった場合も同じ復帰規則を使う。subdomain が有効なままなら `published` になり、版の不明は `lastError` に残る。
- provider の確定した失敗と、DB の書き込み失敗を混ぜない。公開が成功しても DB を更新できなかった場合は成功を返さず、行の状態を進めない。

### 読み出し

- サンドボックスの既存 `GET /v1/files/download` を、除外名を空にして使う（`exclude=` を明示する）。ZIP の walk はアーカイブ設定に依存せず全量を走査する。
- 一覧 API は 1 ディレクトリあたりの件数上限（`SANDBOX_MAX_FILE_ENTRIES`）で打ち切るため、公開の入力には使わない（[sandbox-api.md](sandbox-api.md#get-v1filesdownload-の上限)）。
- BFF は ZIP を一時ディレクトリへ展開し、manifest を作って送信する。一時ディレクトリは成功・失敗にかかわらず削除する。
- 上限は「Cloudflare の制限」と「u7agent の ZIP の制限」の厳しいほうを定数化する。超過・打ち切り相当は部分公開せず失敗させる。
- 公開前の検証で `index.html` の存在、ディレクトリであること、ファイル数・容量・個別サイズ、不正パスを検査する。
- 既知の秘密値（`retainSecret()` が保持する値）と完全一致する内容が成果物に含まれていたら公開を止める。`VITE_*` のようにビルド成果物へ実際の値が入る経路があるため、初期実装から入れる。

### SPA の配信

- 静的アセットの `not_found_handling` を `single-page-application` にして、一致しないナビゲーション要求へ `index.html` を返す。React / Vite などの direct navigation が 404 にならない。
- `html_handling` は既定（`auto-trailing-slash`）を使い、特別な設定をしない。
- 未知のパスも `index.html` を 200 で返すため、404 を返したいサイトでも同じ挙動になる。複数 HTML のサイトは `index.html` を入口として扱う。
- `_headers` / `_redirects` はファイルとして置かれていれば Cloudflare の静的アセット規則に従う（BFF は変換しない）。

## 採用しなかった案

### 既存 Worker へ集約する

1 つの Worker に全共有物のアセットを入れ、パスで分ける案。トークンは `Editor` で足り、Worker の枠も 1 つで済む。

- 却下: Workers Static Assets は Worker version ごとに 1 つのアセット集合を持つため、1 件の更新でも全共有物のアセットを送り直すことになる。停止・削除をパス単位で行うには固定の Worker スクリプトとアセットの再構成が要り、「任意の Worker コードを deploy しない」という制約と衝突する。

### Workers for Platforms

- 却下: 多数のユーザー Worker を捌くための有償機能で、個人運用の規模に対して過剰。無料枠の範囲でもない。

### Pages Direct Upload

- 却下: 停止に当たる操作が無く（project / deployment の削除しかない）、「停止して同じ URL で再公開」を自然に表現できない。Worker の script 削除と subdomain の切り替えのほうが状態遷移に対応しやすい。

### 資格情報を環境変数で渡す

- 却下: デプロイ定義の変更なしに GUI から登録・更新・削除できず、既存の BFF 専用設定（モデル / コンテンツ生成 / Web 検索）と操作が揃わない。DB 暗号化の master key は既にデプロイに設定されている。

### 一覧 API で成果物を読む

- 却下: 1 ディレクトリあたりの件数上限で打ち切られ、部分公開の検出に別の仕組みが要る。ZIP の walk は全量を走査し、上限超過を失敗として返す。

### 同期 HTTP で公開する

- 却下: 数十 MB の送信で proxy やブラウザのタイムアウトに当たる。受付と状態取得を分ける。

## Cloudflare の現行値（Free）

出典: [Limits](https://developers.cloudflare.com/workers/platform/limits/)、[Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)、[Direct Uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/)。

| 項目 | 値 |
| --- | --- |
| Workers / アカウント | 100 |
| 静的アセットのファイル数 / Worker version | 20,000 |
| 静的アセットの 1 ファイル | 25 MiB |
| リクエストボディ（Cloudflare プラン Free） | 100 MB |

- u7agent 側の ZIP の上限（`server/src/sandbox/protocol.ts`）とこの表の値を突き合わせ、厳しいほうを公開の上限にする。
- 個別ファイルは 25 MiB を u7agent 側でも検査する（ZIP の総量に収まっていても 1 ファイルで超え得る）。
- 共有物が Worker の枠を消費する。作成時に provider が枠超過を返したら、原因を分類して明示エラーで止める。
- 静的アセットの配信は無料・無制限で、Workers のリクエスト数に数えられない（Worker スクリプトを置かないため。[Billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)）。

## API 契約

作成・一覧・詳細・更新（再公開）は実装済み。停止・再公開・削除は後続で追加する。エラーの形は既存の API と同じ `{ error }` とし、何も保存していない変更系の失敗には `state: "not_stored"` を付ける。

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/api/shared-contents` | 一覧 |
| `POST` | `/api/shared-contents` | 作成して公開を開始（202） |
| `GET` | `/api/shared-contents/:id` | 詳細と状態 |
| `POST` | `/api/shared-contents/:id/publish` | 更新（同じ URL へ再公開、202）。未公開（`failed`）からの再試行も同じ経路 |
| `POST` | `/api/shared-contents/:id/stop` | 停止（後続） |
| `POST` | `/api/shared-contents/:id/resume` | 再公開（後続） |
| `DELETE` | `/api/shared-contents/:id` | 削除（後続） |
| `GET` | `/api/settings/cloudflare` | 登録状態（トークンは返さない） |
| `PUT` | `/api/settings/cloudflare` | 登録・更新 |
| `DELETE` | `/api/settings/cloudflare` | 削除 |

作成の入力は `{ sessionId, directory, name? }`。`directory` はセッションの作業ディレクトリ相対で、BFF が root 相対の `sourcePath` へ解決して保存する。絶対パス・`..`・ワークスペース root 自身を指す指定は 400。`name` を省略したときはディレクトリ名を使う。

公開の受付時に `sourcePath` の存在を sandbox へ確認する。ソースは `GET /v1/files/download?path=<dir>&exclude=`（明示空）で ZIP 全量を取得し、除外名は適用しない。ZIP は一時ディレクトリへ展開し、成功・失敗にかかわらず削除する。

公開前の検証:

- `index.html` がルートに存在すること（SPA の入口）
- ファイル数 10,000 件以内、合計 100 MiB 以内、1 ファイル 25 MiB 以内
- 絶対パス・`..`・重複・symlink・特殊ファイルを含まないこと
- `retainSecret()` が保持する既知の秘密値と完全一致する内容を含まないこと
- 上記のいずれかに違反したら部分公開せず、共有物を `failed`（更新なら前回の状態 + `lastError`）にする

非同期の受付（作成・更新・再公開）は `202 { id, status: "publishing" }` を返し、状態は GET で読む。停止は `200 { id, status: "stopped" }`、削除は `204`（どちらも後続）。

公開は BFF のバックグラウンドジョブで、同じ共有物の受付は id 単位に直列化する。`publishing` 中の別の変更は `409`。受付の失敗（セッションなし 404、ソースなし / 資格情報なし / アカウント不一致 / 状態不一致 409、DB・sandbox 503、Cloudflare の受付失敗 502）は 202 を返さない。

一覧・詳細の DTO は `{ id, sessionId, name, sourcePath, provider, status, publicUrl, createdAt, updatedAt, publishedAt, stoppedAt, lastError }`。`lastError` は利用者に見せられる分類済みの文言だけを入れ、provider のレスポンス本文やトークンを含めない。`remoteId` / `providerAccount` は通常の UI に出さない。

状態遷移:

| 現在 | 操作 | 次 |
| --- | --- | --- |
| なし | 作成 | `publishing` |
| `publishing`（初回） | 成功 | `published` |
| `publishing`（初回） | 確定した失敗 | `failed` |
| `publishing`（公開・更新・再公開） | 結果不明 | `publishing`（+ `lastError`、停止のみ可） |
| `publishing`（+ `lastError`） | 停止（後続） | `stopped` |
| `failed` | 公開（再試行） | `publishing` |
| `published` | 更新 | `publishing` |
| `publishing`（更新） | 成功 | `published` |
| `publishing`（更新） | 確定した失敗 | `published`（+ `lastError`） |
| `published` | 停止（後続） | `stopped` |
| `published` | 停止（確定した失敗・結果不明、後続） | `published`（+ `lastError`） |
| `stopped` | 再公開（後続） | `publishing` |
| `publishing`（再公開、後続） | 成功 | `published` |
| `publishing`（再公開、後続） | 確定した失敗 | `stopped`（+ `lastError`） |

- `publishing` の共有物への別の変更は `409`。ただし結果不明で止まった行への停止だけは受け付ける。
- 停止の結果不明は、開始状態が `published` なら `published` + `lastError`、結果不明の `publishing` からなら `publishing` + `lastError` に留める（照会できたときだけ `stopped` / `published` に確定する）。
- `lastError` は受付時に消し、公開・更新・再公開・停止の成功時も消す。確定した失敗と結果不明のときだけ、分類済みの文言を入れる。
- 操作の成否は終端の `status` と `lastError` で判定する。公開・更新・再公開は `published` かつ `lastError` が null なら成功、停止は `stopped` かつ null なら成功。`publishing` + `lastError` は結果不明で、停止を再試行すると `stopped` に確定する。
- 存在しない id は `404`。他の共有物を誤って操作しないよう、id だけで対象を決める。
- 記録した `providerAccount` が現在の接続と一致しないときは `409`。資格情報を入れ替えても既存共有物の操作先を変えない。
- 更新はセッションが存在し、`sourcePath` が実在するときだけ受け付ける。どちらかが欠けていれば `409`。停止・再公開・削除はこの条件を見ない。
- 削除は provider 成功後に `204`。provider が 404 を返したときも成功扱い。`providerAccount` または `remoteId` が無い行は provider を呼ばずに行だけ消す。それ以外の provider 失敗では行を残して `502`（後続）。
- 資格情報が未登録のときの公開は、provider を呼ぶ前に `409` で止める。
- 一覧のページングは初期実装では持たない（個人運用の件数に収める）。
- Cloudflare の失敗は認証 / 不存在 / 枠不足 / レート制限 / 一時障害 / タイムアウト / 通信不能に分類し、固定文言だけを `lastError` と応答へ載せる。応答本文とトークンは載せない。タイムアウト・通信不能・5xx は結果不明として workers.dev subdomain を照会し、確定できなければ `publishing` + `lastError` に留める。

## 既知の制限

- URL は「知っていれば誰でも見られる」公開 URL で、認証・期限・アクセス制御は無い。秘密値を含む成果物を公開しないための注意は GUI と tool の案内で行う。
- URL は Cloudflare のアカウントサブドメインに依存する。サブドメインを変更すると既存の URL も変わる。
- アカウントの Free 枠（Worker 数）を他の用途と共有する。
- 中断した公開の復帰は subdomain の有効・無効だけを照会する。配信中の版までは照会しないため、更新の中断では新しい版が配信されている可能性がある（`published` + `lastError` で知らせる）。
- provider の状態を問い合わせできない間は `publishing` + `lastError`（停止を受け付ける）で止まる。接続が戻るまで停止も実行できないため、外部が公開中のまま残り得る。接続を復旧して停止するか、再試行する。
- 停止の結果不明で `published` のまま残った行は、停止を再試行すれば `stopped` に確定する（冪等）。
- 同じ共有物の更新は新しい deployment を積む。過去の deployment の掃除はしない（Cloudflare 側の保持に任せる）。
- セッションまたはソースの作業フォルダが消えた共有物は更新できない。停止・再公開・削除だけができる。
- 公開先アカウントを変えるには、旧アカウントで既存の共有物を停止・削除する。接続を先に切り替える操作は `409` で止まる。

## 実機で確認する項目

設計時点では Cloudflare のドキュメントで確認できる範囲だけを決めている。実装の最初に実アカウントで確かめ、結果をこの節へ追記する。

- Workers `Admin`（product scope）の API トークンで、Worker の作成・更新・subdomain の切り替え・削除が通る
- 静的アセットだけの Worker を API で作れる（Worker スクリプト無し。`main_module` を省略できるか）
- manifest の hash の作り方が Cloudflare の期待と一致する（Wrangler と同じ結果になるか）
- アセット送信の 1 リクエストが 100 MB を超えないよう、bucket をサイズで分割する必要があるか
- subdomain を `enabled=false` にすると外部から 404 になり、`enabled=true` で同じ URL が戻る
- `previews_enabled` を false にできる（不要な Preview URL を増やさない）
- `GET /accounts/{account_id}/workers/subdomain` でアカウントの workers.dev サブドメインを取得でき、公開 URL を受付時に確定できる
- 存在しない script の削除が 404 を返す（冪等扱いの確認）
- 残枠が無いときの API エラー（Worker 数の上限）を分類できる
