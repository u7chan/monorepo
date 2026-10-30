# 静的コンテンツ共有の設計判断

公開単位・Cloudflare の資格情報・記録と移行・共有物のライフサイクル・公開の実行モデルなど、実装より先に決めた契約と、採用しなかった案。実装は `server/src/shared-contents.ts`、HTTP 契約は [static-sharing-api.md](static-sharing-api.md)、画面と既知の制限は [static-sharing.md](static-sharing.md) を参照する。状態・列・上限値の正は実装とテスト（`server/src/app-db.ts`）。

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
- 保存・復号したトークンは `retainSecret()` へ渡し、例外やログに値が現れてもマスクする。平文を読むのは公開処理と接続確認の `CloudflareSettingsService.credential()` だけで、応答・tool・sandbox へ渡す経路を持たない。
- サンドボックスの環境変数、agent tool の引数、`session.jsonl`、ログ、tool 出力へ渡さない。
- 登録・読み込み時に `retainSecret()` へ渡し、例外やログに値が現れてもマスクする。
- アセット送信に使うアップロード用 JWT は API トークンとは別物で、メモリ上だけで使う。
- master key を失うと保存済みトークンは復号できない。再登録が必要になる（鍵の置き場所はデプロイ側の責務）。

### 記録と移行

- `shared_contents` と `cloudflare_settings` をアプリデータの SQLite に持つ。列は `server/src/app-db.ts` を正とする。
- どちらも**列追加だけの加算移行**を恒久ルールとし、`DROP_TABLES` に入れない（[persistence.md](persistence.md#アプリデータsqlite)）。行が消えると Cloudflare 側の公開物を追跡・停止・削除できなくなるため。
- `shared_contents` は `provider` と `providerAccount` と `remoteId` の組を一意にし、同じ公開先を 2 つの共有物が指さないようにする（`remoteId` が未作成の行は複数持てる）。
- 公開の受付時に `provider` / `providerAccount` / `remoteId` / `publicUrl` を確定して保存する（script 名は id から、URL は script 名とアカウントの workers.dev サブドメインから決まり、以後変えない）。
- 公開元の種類（`sourceKind`）を作成時に記録する。`sourcePath` がセッションの作業フォルダと等しいとき `session-root`、それ以外は `directory`。一覧の公開元は `session-root` を「セッションの作業フォルダ」と表示し、生のパスを出さない。
- 公開先のアカウントを `providerAccount` に記録する。更新・停止・再公開・削除は記録したアカウントへ行い、現在の接続と一致しないときは provider を呼ばずに `409` で拒否する。資格情報の削除・再登録では `providerAccount` を消さない。
- 公開済みの共有物がある状態で別のアカウントへ接続を切り替える要求は `409` にする。切り替えるには、旧アカウントで共有物を停止・削除してから登録し直す。

### アカウント側の権限

- トークンは **Account スコープの `Workers Scripts: Edit`**（API の accepted permission は `Workers Scripts Write`）だけでよい。作成・更新・subdomain の切替・削除のいずれもこの権限で行う（per-Worker の権限は存在しない Worker には付与できないため、アカウント単位で付ける）。
- 作成手順: Cloudflare ダッシュボード → My Profile → API Tokens → Create Token → Custom token。Permissions は **Account → Workers Scripts → Edit**（画面では「レガシー」表示）、Account Resources は **Include → 対象アカウント**だけにする。Zone Resources は選ばない。
- `Workers Routes` などの zone 権限は不要（workers.dev のみ使うため）。
- 権限の範囲はアカウント内の全 Worker に及ぶ。トークンの漏洩時の影響が広いので、保存先とマスクの扱いを他機能より厳しくする。
- 実装時に、実際のトークンで作成・更新・停止・削除が通ることを確認し、必要な権限名を確定する（[実機で確認する項目](static-sharing.md#実機で確認する項目)）。

### 共有物のライフサイクル

状態は `SharedContentStatus`（`server/src/app-db.ts`）で表し、許可する遷移は API 側で検証する。`status` は**外部から見た現在の公開状態**で、最後の操作の成否ではない。

- `failed` は一度も公開できていない状態。未公開の行を停止したとき、照会で無効や script の不在を確認したときもここへ寄せる。停止は受け付けず、公開の再試行（更新）だけを受け付ける。
- `stopped` は公開実績（`publishedAt !== null`）のある行だけが取る。**`published` / `stopped` は `publishedAt !== null` を不変条件にする。** 公開実績の無い行を再公開で `published` に戻すと、subdomain を有効にしただけで deployment の無い URL が「公開済み」になる。
- 公開実績のある行の更新・再公開・停止が**確定した失敗**をしたときは、前回の状態（`published` / `stopped`）へ戻し、理由を `lastError` に残す。公開実績の無い行（`failed` と既存の壊れた行）の更新が確定失敗したときは `failed` にする。旧 deployment は有効なままなので、外部の状態と DB を一致させる。
- provider の結果が不明なとき（timeout など）は状態を確定させない。`publishing` のまま `lastError` を記録し、**停止だけ**を受け付ける。停止は subdomain を無効にする冪等な操作なので、外部が公開中でも安全側に倒せる。照会できない間も同じ扱いにする。
- `stoppedAt` は停止で立ち、公開の成功で消す。停止中からの更新の受付では消さない。
- 停止は `published` と、結果不明で `publishing` のまま残った行から受け付ける。応答の `status` は公開実績に応じて `stopped` / `failed` になる。
- 更新は `published` / `failed` に加えて `stopped` からも受け付ける。停止中からの更新は成果物を送り直して subdomain を有効に戻す（新しい deployment を積むため版が変わる）。
- 再公開は `stopped` のうち公開実績のある行だけ。公開実績の無い行は `409` で拒否し、更新で公開し直すよう固定文言で案内する。
- 停止・再公開・削除は**成果物を送らない**。停止と再公開は workers.dev の subdomain だけを切り替え、削除は script を消す。

### deployment と状態の関係

1 共有物 = 1 script（Worker）で、公開・更新のたびに新しい version とその deployment が積まれる。URL は script 名とアカウントの subdomain から決まるため、deployment が増えても変わらない。

- 配信されるのは script の active deployment が指す版で、更新が成功すると新しい版へ切り替わる。
- 停止は script / deployment を消さず subdomain を無効にするだけなので、再公開で戻るのは**最後に公開した版**。`source_path` を読み直して作り直すことはしない。停止中の内容を差し替えるときは再公開ではなく更新を使う。
- 停止中からの更新は、新しい deployment を積んでから subdomain を有効に戻す。
- 過去の deployment は削除しない（Cloudflare 側の保持に任せる）。版を戻す操作は API に置かない。
- 更新が確定失敗したときに前回の状態へ戻すのは、active deployment が旧版のまま残っているため。DB と外部の見え方を一致させる。

| 操作 | Cloudflare 側 | 必要なもの |
| --- | --- | --- |
| 公開 | script 作成 + アセットの deployment | `source_path` の成果物、セッション、資格情報、Worker の残枠 |
| 更新 | 同じ script に新しい deployment（URL は変わらない） | `source_path` の成果物、セッション、資格情報 |
| 停止 | workers.dev の subdomain を `enabled=false` にする | 資格情報だけ（成果物・セッションは不要） |
| 再公開 | 同じ subdomain を `enabled=true` に戻す | 資格情報だけ（成果物・セッションは不要） |
| 削除 | script を削除してから DB の行を消す | 資格情報だけ（成果物・セッションは不要） |

- すべての操作は、記録した `providerAccount` の資格情報が登録されているときだけ行える。
- 停止と削除は別操作。停止は URL と行を残したまま外部閲覧だけを止める。
- 停止・再公開・削除は provider の操作が冪等（subdomain の `enabled` 設定と script の削除）なので、provider のあとで状態を保存できなかったときは状態を進めず `503` を返す。同じ操作を再試行すると同じ結果へ収束する。
- 削除は provider 側の削除が成功してから行を消す。provider が「既に無い」を返したときだけ成功扱いにし、それ以外の失敗で行を消さない。
- 削除は同じ id への 2 回目で `404` になる（行が無い）。外部で既に消えていた場合は 1 回目が `204` で成功する。この 2 つを合わせて「外から見える公開物は残らない」ことを保証する。
- 削除は `publishing` の行を一律で `409` にする。進行中ならジョブと重なって消したはずの script が後から作り直され得るため、結果不明なら「公開の状態が確定していない」ため。どちらも停止で状態を確定させてから削除する（停止は結果不明の `publishing` からも受け付ける）。
- 削除中を表す状態は設けない（同期削除 + 共有物単位のロックで足りるため）。追加するなら状態遷移とセットで設計する。
- 状態遷移を伴う変更系（公開・更新・停止・再公開・削除）は共有物 id 単位でロックし、全共有物を 1 本に直列化しない。同じ id の操作が進行中なら、状態に関係なく `409` で断る（待たせない）。**表示名の変更はロックに乗せない**（provider を呼ばず、状態も時刻も変えないため、公開ジョブと重ねても書き込む列が競合しない）。

### セッションと作業ディレクトリ

- `sessionId` から BFF が作業ディレクトリを解決する。公開の入力 `directory` はその作業ディレクトリ相対で、保存する `sourcePath` はワークスペース root 相対へ解決した値。client / agent から任意のホストパスは受け取らない。
- **`directory` の字面が `.` のときだけセッションの作業フォルダ自身を指す**（`./` も含む。trim して末尾スラッシュを落とした字面で判定する）。正規化の結果だけで判定しない: `a/..` も `./.` も正規化すると `.` になるため、字面が `.` でない入力は従来どおり 400 にする。`foo/.` は今までどおり `foo` として扱う。ワークスペース root 自身（作業フォルダが `""` のセッション）は従来どおり公開できない
- **作業フォルダ自身を指せるのは非プロジェクト会話だけ。** 記録に `projectCwd` がある会話で `.` を指定したら 409（プロジェクト全体の公開になるため）。判定は `SessionSummary.projectSession` と同じ規則で `projectCwd` の有無を見て、`projectId` は使わない（登録解除で `projectId` が `undefined` に戻るため）。ディレクトリの共有はセッション種別で制限しない
- 絶対パス・`..`・symlink でワークスペース root の外へ出る指定は拒否する。
- セッションを削除しても共有物の行は残す。設定 → 共有（`/settings/sharing`）の一覧から停止・再公開・削除できる。
- 更新はセッションが存在し、その作業ディレクトリ配下に `sourcePath` が実在するときだけ行える。セッションが無い / ソースが無い場合は更新だけを明示エラーにし、停止・再公開・削除は通す。セッション削除では作業フォルダが残るが、`sourcePath` の意味が履歴になるため更新の可否はセッションの存在も条件にする。
- 公開はスナップショット。`source_path` の中身を書き換えただけでは反映されず、更新したときだけ反映される。
- **作成と更新は、公開元の会話か、同じ作業フォルダを共有する会話が実行中（実行 / キュー待ち / 圧縮中）なら 409。** プロジェクト会話は `projectCwd` を全セッションで共有するため、兄弟会話の書き込みも半端なスナップショットになる（未所属の会話は会話ごとの scratch なので、他の会話と一致しない）。判定は `SessionStore.busyInWorkdir` で、公開元の作業フォルダを使う会話全体を見る（`isBusy` と同じ集合。live でない会話は走っていないものとして通す）。プレビュー・停止・再公開・削除・表示名の変更は成果物を読まないので実行中も通す（逃げ道を塞がない）。受付の後に run が始まるケースは止めない（[既知の制限](static-sharing.md#既知の制限)）

### 公開の除外

共有は「配る成果物のディレクトリ」を対象にするため、ダウンロード ZIP の除外（設定 → ファイル（`/settings/files`）の「ダウンロードの除外」、`archive_settings`）とは既定も保存行も分ける。アーカイブの既定には `dist` / `build` / `out` が入っており、流用すると `dist/` を公開できなくなる（サンドボックスは対象ディレクトリ名が除外名と一致すると 400 を返す）。

- 規則はダウンロードの除外と同じく**ベース名の完全一致・全階層**で、glob とパス指定は持たない。`.env.*` のようなパターンは使えないので、既定では個別に列挙する
- 既定の一覧は `server/src/shared-content-rules.ts` の `DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES` を正とする（ここには写さない）。成果物の名前（`dist` / `build` / `out` など）は入れない。対象そのものが `dist` のときに共有できなくなるため
- `index.html` は保存を拒否する。名前は全階層一致なので、許可すると入れ子の `index.html`（サブディレクトリ直下の `index.html` など）も落とせてしまい、SPA の入口を守れない
- **適用タイミングは受付時。** `create` / `publish` が実効値を解決してジョブへ渡すため、ジョブ実行中に設定が変わっても、走っている公開は受付時の一覧を使う。共有物ごとの除外は DB に記録しない（設定は 1 行で、次の公開から効く）
- プレビューも同じ実効値を使う（見えたものと上がるものをずらさない）
- **対象ディレクトリ自身のベース名と一致する名前は、その要求に限り落とす。** 落とさないと `dist` を除外した状態で `dist/` を共有できず、設定と操作が自己矛盾する。副作用として、対象の直下以外にある同名ディレクトリも解禁される（名前は全階層一致で、見るのは対象のベース名だけのため）
- 既定へ戻すのは行を消す操作で、既定名を保存し直さない（以後の既定の追加に追随させる）
- 保存行が壊れている（JSON 配列でない）ときは設定 API を 503 にし、プレビュー / 公開は既定へ落として警告を出す（空へ倒すと、除外したつもりの名前が公開対象へ戻る）
- 除外は事故防止で、秘匿の保証ではない。既知の秘密値の検査（[読み出し](#読み出し)）は別に走るため、除外しなかったファイルに秘密値が含まれていれば公開は失敗する

### 公開の実行モデル

Cloudflare への送信は時間がかかるため、同期 HTTP では扱わない。

- 公開・更新・再公開は受付だけを返し（`202`）、状態は GET で読む。GUI は状態をポーリングして表示する。
- 受付時に `lastError` を消して `publishing` にする。終端は `publishing` でなくなったときで、成功・失敗は `status` と `lastError` の組で読む。
- agent tool は受付のあと内部で終端までポーリングし、状態が確定してから URL かエラーを返す。`publishing` + `lastError`（結果不明）を見たらそこで打ち切って、停止で安全側に倒すよう案内する。
- provider の結果が不明になったとき（timeout など）と、BFF 再起動で `publishing` のまま残ったときは、subdomain を問い合わせて状態を確定する。有効なら `published`、無効なら `stopped`（公開実績あり）/ `failed`（未公開）、script が無ければ一度も公開できていない行だけ `failed`（公開実績のある行は `stopped` + `lastError`。`publishedAt` は残す）。更新・初回公開の中断では配信中の版が分からないため、その旨を `lastError` に残す。問い合わせできないときは `publishing` + `lastError` に留め、停止だけを受け付ける。
- script の不在は「照会が 404」だけでなく「操作の要求自体が 404」でも確定する。どちらも同じ規則（公開実績あり → `stopped` + `lastError`、未公開 → `failed`）で終端へ収束させ、`publishing` のまま残さない。
- 停止の結果が不明なときも同じ問い合わせを行う。無効なら `stopped`（公開実績あり）/ `failed`（未公開）、有効なら開始状態 + `lastError`（停止を再試行できる）。問い合わせできない間は開始状態にかかわらず `publishing` + `lastError` に留める（誤って「停止済み」と表示せず、停止を受け付ける）。照会または停止要求が 404 を返したときは不在の確定として終端へ収束させる（[API 契約](static-sharing-api.md#api-契約) の停止と同じ規則）。
- deployment 成功後に DB を更新できなかった場合も同じ復帰規則を使う。subdomain が有効なままなら `published` になり、版の不明は `lastError` に残る。
- provider の確定した失敗と、DB の書き込み失敗を混ぜない。公開が成功しても DB を更新できなかった場合は成功を返さず、行の状態を進めない。

### 読み出し

- サンドボックスの既存 `GET /v1/files/download` を、共有の除外名（[公開の除外](#公開の除外)）の実効値で使う。除外名が空でも `exclude=` を明示する（サンドボックスは省略を「BFF が指定していない」= 既定を使う意図として扱う）。ZIP の walk はアーカイブ設定（ダウンロードの除外）に依存せず、渡された共有の除外名だけを全階層で落として全量を走査し、件数 / 合計サイズの上限超過は切れた ZIP ではなく失敗（413）として返る
- 公開前のプレビューは `GET /v1/files/download/plan` を使う。公開と同じ計画（`planDownload`）を通すため、除外・上限・symlink の扱いは公開と一致する。ただしプレビューは補助で、公開直前の差し替えと秘密値の検査は公開ジョブだけが確定できる
- **`index.html` の存在確認を一覧に依拠しない。** 一覧 API（`GET /v1/files`）は 1 ディレクトリあたりの件数上限で打ち切られ、計画の一覧も件数上限で打ち切られる。計画の `hasIndexHtml` は走査中に見た結果で打ち切りとは無関係だが、プレビューは補助なので、公開の確定は ZIP 全量の検証で行う
- BFF は ZIP を一時ディレクトリへ展開し、manifest を作って送信する。一時ディレクトリは成功・失敗にかかわらず削除する
- 上限は「Cloudflare の制限」と「u7agent の ZIP の制限」の厳しいほうを定数化する。超過・打ち切り相当は部分公開せず失敗させる
- 公開前の検証で `index.html` の存在、ディレクトリであること、ファイル数・容量・個別サイズ、不正パスを検査する
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

- 却下: 公開の入力に使うと、1 ディレクトリあたりの件数上限で打ち切られた一部だけをアップロードする危険がある。公開の入力は ZIP 全量（walk が全量を走査し、上限超過を失敗として返す）に限る。計画の一覧（`GET /v1/files/download/plan`）はプレビューに見せるだけで、公開の入力には使わない

### 公開対象をチェックボックスで選ぶ（include ツリー）

- 却下: 対象ディレクトリの全量を一覧に載せる必要があり、上限（10,000 entries）に近いディレクトリでは選択 UI 自体が成立しない。プレビュー（[GUI](static-sharing.md#gui共有ダイアログ)）+ 名前の除外で足りる範囲に留め、含めるものを選ぶ逆方向の指定は持たない。

### 共有物ごとに除外を上書きする

- 却下: 共有物は受付時のスナップショットで、除外は「そのときの設定」で決まる。共有物ごとに値を持つと、同じ設定画面の意味が対象ごとに変わり、更新のたびにどの一覧が効くかを説明できなくなる。まず全体で 1 つの一覧にし、必要性が出たら状態遷移とセットで設計する。

### glob / パス指定の除外

- 却下: サンドボックスの `exclude` は 1 セグメント名の完全一致で、パスや `*` を解釈しない（[sandbox-api-files.md](sandbox-api-files.md#get-v1filesdownload)）。BFF 側だけで解釈すると、計画（walk）と ZIP の生成で別の規則を持つことになり、見えたものと上がるものがずれる。`.env.*` は既定に個別で列挙する。

### 同期 HTTP で公開する

- 却下: 数十 MB の送信で proxy やブラウザのタイムアウトに当たる。受付と状態取得を分ける。

### `/user/tokens/verify` でトークンを検証する

- 却下: account-owned token の検証は `/accounts/{account_id}/tokens/verify` と別 endpoint で、user 側の `/user/tokens/verify` は 401 になり得る。誤アカウントの切り分けのために 2 本目の確認を足すと、かえって失敗の意味が曖昧になる。接続確認は公開の受付と同じ subdomain GET 1 本にする。

### QR を共有の唯一の経路・常設の表示にする

- 常設の表示にはしない。会話から公開する共有ダイアログ（`client/src/components/ShareContentDialog.tsx`）でも、結果と「共有物」の行から押したときのダイアログに限る。
- QR だけにしない。読めない端末やスクリーンリーダーでも渡せるよう、ダイアログには URL のテキストと開く / コピーを併置する。
- カードには常時表示しない。一覧の高さと走査性を保つため、押したときのダイアログに限る。
- QR の画像生成・保存・ダウンロード・印刷、SNS 共有、短縮 URL、ロゴ入り・色付き QR は扱わない。既に公開されている URL を画面に出すだけで、新たな露出は増やさない。

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
