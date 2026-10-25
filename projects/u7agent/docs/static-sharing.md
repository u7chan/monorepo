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

## GUI（共有ダイアログ）

手動で公開する最小の導線。取り消しにくい確認と結果だけを 1 画面に閉じる。

- **入口はチャット右パネル（作業フォルダ面）の行の ⋯ の「共有」だけ**。ディレクトリ行はそのディレクトリ、作業フォルダ直下（ツリーの root）の `index.html` 行は「このフォルダを共有」で作業フォルダ全体を対象にする。`compact` では同じ中身が全画面のシートで開くため入口は増やさない（ツールバーにも第 2 入口を置かない）。**設定 → ファイル（`/settings/files`）には出さない**（共有 API の `directory` はセッションの作業フォルダ相対で、共有物も `sessionId` を持つため）。会話が決まっていない面（プロジェクト起点の新規会話 / スキル面 / 読み取り専用の面）も出さない。symlink の行にも出さない
- **作業フォルダ自身の入口は非プロジェクト会話だけ**（`SessionSummary.projectSession` が明示的な false のときだけ出す。true / 未指定 / 会話が未確定は出さない側へ倒す）。**ディレクトリ行の「共有」はセッション種別で制限しない**（プロジェクト会話でも従来どおり使える）。サブディレクトリの `index.html` 行には出さない（そのディレクトリ行の「共有」で足りる）
- ダイアログは 確認 → 受付 → 状態 → 結果 の 1 画面。確認には 公開対象の path（作業フォルダ相対）、外部から誰でも見られること、静的ファイルに含めた秘密値も公開されること、公開すると URL が発行されること、停止・削除ができないことを出す。**確認画面に最終 URL は出さない**（URL は受付時に確定するため、公開前にはクライアントから決められない）。表示名は任意の入力欄（最大 100 文字）で、既定はセッションタイトル。空欄で送ると API がディレクトリ名（root ではセッション ID）へ落とす。**表示名は URL を変えない**（URL は script 名 = 共有物 id 由来）ことを確認画面に書く。同じ公開元の共有物が既にあるときは「共有済み（更新は 設定 → 共有 から）」を出す（公開済みなら情報提供だけで、サーバーは重複を拒否しない。公開中は下記のとおり再送を止める）
- **プレビューは補助で、公開されるものの確定は公開ジョブの検証。** ダイアログを開いた時点でプレビューを 1 回取り、件数（ディレクトリも数えるので「ファイル数」とは書かない）・合計サイズ・上位のパス・一覧の打ち切り・公開されないもの（symlink / 特殊ファイル）・`problems` を出す。一覧は行数でも絞るため、**取得の打ち切り（計画の件数上限）と表示の絞り込み（先頭 N 件）は別の注記**にし、11 件以上でも省略されたことが分かるようにする。**除外は「何件の設定か」と「実際に落ちた名前（`skipped`）」を分けて出す**（件数だけでは、設定したのに効いていない場合を見分けられない）。取得中 / 失敗 / 成功を分けて表示し、**失敗しても公開の操作は塞がない**（見え方はその時点のもので、公開直前にファイルは変わり得る）。`index.html` の不在はプレビューの `problems` にも出すが、公開の成否は公開ジョブの検証結果（`failed` + `lastError`）を固定文言としてそのまま出す
- 受付（`POST /api/shared-contents` の `202`）の後は `GET /api/shared-contents/:id` を `publishing` の間だけポーリングし、その間は確定の操作を出さない。完了で URL・share id・「開く」・「URL をコピー」を出す
- ダイアログ内の「この会話の共有物」は `GET /api/shared-contents?sessionId=<id>` の結果だけを並べる。**閉じて開き直すと状態と URL が戻る**（画面は状態を持ち越さず、開くたびに一覧から復元する）。`publishing` が含まれる間は一覧もポーリングする。**公開中に閉じても公開ジョブは止まらない**（キャンセルの API は無く、202 の前の受付も中断できない）。そのため閉じる・Escape は塞がず、公開中は公開が続くことと結果の確認先（設定 → 共有）を出し、閉じたことでキャンセルされたと誤解させない。一方で、**閉じて開き直したときに同じ公開元が `publishing` の間は確認画面から再送できない**（`activeId` が失われても Worker と URL を二重に作らない）。全共有物の管理一覧は 設定 → 共有（`/settings/sharing`）が持つ
- 資格情報が未登録でもメニューは出し、受付時に BFF の固定文言（設定 → 共有 → 接続 で登録）をそのまま見せる
- Escape は共有ダイアログだけを閉じる。`compact` ではダイアログが作業環境のシートの中に開くため、`cancel` / `close` を背面のシートへ伝播させない（1 回でシートごと閉じない）
- **`serve`（サービス）との違いを文言で示す。** 共有は Cloudflare への外部公開、サービスはアプリを開いている間だけの一時プレビュー
- 失敗時も BFF が分類した固定文言（`lastError` / `error`）だけを出し、API トークン・Cloudflare の生レスポンス・内部識別子は画面へ出さない

## GUI（接続）

設定 → 共有 → 接続（`/settings/sharing/connections`）は、保存済みの資格情報が Cloudflare へ届くかを明示ボタンで確認できる。

- 確認するのは**保存済みの値だけ**。未保存の下書きは確認しない（トークンの経路を 1 本に保つ）。保存直後にも自動で走らせず、利用者が押したときだけ動かす。
- 確認は `GET /accounts/{account_id}/workers/subdomain` の 1 本だけ。公開の受付が最初に呼ぶのと同じなので、権限 / アカウント / workers.dev の失敗が同じ形で出る。副産物として workers.dev のサブドメインが分かり、公開先のドメインを公開前に見られる（script 名は共有物の id から作るので、URL 全体は公開まで確定しない）。
- 結果は保存せず、その場で見せるだけ。再読み込み後は再確認が要る。設定画面の GET は外部通信に依存させない。
- 確認の進行中も保存・削除は止めない。確認中に設定が変わったら、遅れて届いた結果だけを捨てる。公開の進行中でも確認は独立して実行できる。
- 成功文言は「公開できます」と言わない。subdomain GET は `Workers Scripts Read` でも通るため、Write（Edit）権限の有無は保証できない。
- 失敗は HTTP status を添えて切り分けられるようにする。文言は接続確認専用で、公開処理向けの文言（404 の「対象の Worker」など）を流用しない。
- ボタンの無効条件・結果の出し分け・確認時刻の整形は `client/src/lib/cloudflareSettings.ts` を正とする。API 契約は [api.md](api.md#post-apisettingscloudflarecheck)。

## GUI（管理一覧）

設定 → 共有（`/settings/sharing`）が、公開した共有物の管理一覧を持つ。同じセクションの「公開の除外」は公開対象から落とす名前、「接続」は公開先の資格情報だけを扱う。

- 一覧はカードで並べ、狭い面でも横スクロールを要求する表にしない。名前・状態・公開 URL・公開元の path・更新 / 公開 / 停止の時刻・操作中の状態を出す
- 状態ごとに受け付ける操作を変える。`published` は開く / URL コピー / 更新 / 停止 / 削除、`stopped` は再公開 / 削除、`failed` は公開の再試行 / 削除。`publishing` は二重操作を出さず、結果不明（`publishing` + `lastError`）は停止だけを出す。UI の出し分けは案内で、安全性の正は API の状態遷移検証
- 更新は現在の `source_path` を再公開する。実行前に確認ダイアログで対象の path を示す。停止・再公開・削除は path を必要としない
- 停止中も URL は残して表示し、開く・コピーは出さない。停止は URL と記録を残す操作で、削除と違うことを文言でも示す
- 削除は確認ダイアログを出し、provider の削除が成功してから一覧から消す（BFF の 204 を待つ）
- セッションが削除された共有物も一覧に残し、その旨を示す。更新だけを無効にし、停止・再公開・削除は使える。会話一覧をまだ取得できていない間は削除済みと言い切らず、更新も無効にしない（BFF が 409 で拒否する）
- 公開元の会話が一覧に居るときは、カードに会話へのリンクを出す（通常クリックは設定を閉じてその会話へ移り、所属が別スペースならスペースを切り替えてから開く。修飾キー付きクリックはブラウザ既定の新規タブ）。会話が削除済みのときと、会話一覧をまだ取得できていない間は出さない
- 一覧全体の取得失敗と、1 件の操作失敗を分ける。前者は表示中の内容が最後に取得できたものであることをバナーで伝え、後者は該当のカードに出す。どちらも BFF の固定文言をそのまま使い、provider の生レスポンスやトークンを画面へ出さない
- `publishing` の共有物がある間は一覧をポーリングする。停止・再公開・更新・削除の応答後も一覧を読み直し、API が確定させた状態へ追随する
- 状態フィルタと件数、再読み込みを持つ。件数は絞り込みの外側の全件から数え、結果不明も `status` が `publishing` のままなので公開処理中として数える
- 狭い面では操作を「主操作 + URL コピー + ⋯」に畳み、⋯ に更新 / 停止 / 削除を入れる（結果不明は停止だけ）。⋯ は一覧のスクロール枠の外へ浮かせ、外側クリック・Escape・スクロールで閉じる。メタ情報は公開元と 1 つの時刻に絞る
- 空状態、一覧取得失敗、接続未登録の案内を出す。接続未登録では BFF の固定文言をそのまま出し、接続タブへの導線を添える
- `serve`（サービス）の管理とは混ぜない（同じ画面に置かず、操作も共有しない）

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
- 実装時に、実際のトークンで作成・更新・停止・削除が通ることを確認し、必要な権限名を確定する（下表の実機確認）。

### 共有物のライフサイクル

状態は `SharedContentStatus`（`server/src/app-db.ts`）で表し、許可する遷移は API 側で検証する。`status` は**外部から見た現在の公開状態**で、最後の操作の成否ではない。

- `failed` は一度も公開できていない状態（復帰時に外部の script が無いと分かった場合も含む）。停止は受け付けず、公開の再試行だけを受け付ける。
- 公開済みの共有物の更新・再公開・停止が**確定した失敗**をしたときは、前回の状態（`published` / `stopped`）へ戻し、理由を `lastError` に残す。旧 deployment は有効なままなので、外部の状態と DB を一致させる。
- provider の結果が不明なとき（timeout など）は状態を確定させない。`publishing` のまま `lastError` を記録し、**停止だけ**を受け付ける。停止は subdomain を無効にする冪等な操作なので、外部が公開中でも安全側に倒せる。照会できない間も同じ扱いにする。
- `stoppedAt` は停止で立ち、公開成功で消す。
- 停止は `published` と、結果不明で `publishing` のまま残った行から受け付ける。
- 停止・再公開・削除は**成果物を送らない**。停止と再公開は workers.dev の subdomain だけを切り替え、削除は script を消す。

### deployment と状態の関係

1 共有物 = 1 script（Worker）で、公開・更新のたびに新しい version とその deployment が積まれる。URL は script 名とアカウントの subdomain から決まるため、deployment が増えても変わらない。

- 配信されるのは script の active deployment が指す版で、更新が成功すると新しい版へ切り替わる。
- 停止は script / deployment を消さず subdomain を無効にするだけなので、再公開で戻るのは**最後に公開した版**。`source_path` を読み直して作り直すことはしない。
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
- 変更系は共有物 id 単位でロックし、全共有物を 1 本に直列化しない。同じ id の操作が進行中なら、状態に関係なく `409` で断る（待たせない）。

### セッションと作業ディレクトリ

- `sessionId` から BFF が作業ディレクトリを解決する。公開の入力 `directory` はその作業ディレクトリ相対で、保存する `sourcePath` はワークスペース root 相対へ解決した値。client / agent から任意のホストパスは受け取らない。
- **`directory` の字面が `.` のときだけセッションの作業フォルダ自身を指す**（`./` も含む。trim して末尾スラッシュを落とした字面で判定する）。正規化の結果だけで判定しない: `a/..` も `./.` も正規化すると `.` になるため、字面が `.` でない入力は従来どおり 400 にする。`foo/.` は今までどおり `foo` として扱う。ワークスペース root 自身（作業フォルダが `""` のセッション）は従来どおり公開できない
- **作業フォルダ自身を指せるのは非プロジェクト会話だけ。** 記録に `projectCwd` がある会話で `.` を指定したら 409（プロジェクト全体の公開になるため）。判定は `SessionSummary.projectSession` と同じ規則で `projectCwd` の有無を見て、`projectId` は使わない（登録解除で `projectId` が `undefined` に戻るため）。ディレクトリの共有はセッション種別で制限しない
- 絶対パス・`..`・symlink でワークスペース root の外へ出る指定は拒否する。
- セッションを削除しても共有物の行は残す。設定 → 共有（`/settings/sharing`）の一覧から停止・再公開・削除できる。
- 更新はセッションが存在し、その作業ディレクトリ配下に `sourcePath` が実在するときだけ行える。セッションが無い / ソースが無い場合は更新だけを明示エラーにし、停止・再公開・削除は通す。セッション削除では作業フォルダが残るが、`sourcePath` の意味が履歴になるため更新の可否はセッションの存在も条件にする。
- 公開はスナップショット。`source_path` の中身を書き換えただけでは反映されず、更新したときだけ反映される。

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
- provider の結果が不明になったとき（timeout など）と、BFF 再起動で `publishing` のまま残ったときは、subdomain を問い合わせて状態を確定する。有効なら `published`、無効なら `stopped`、script が無ければ一度も公開できていない行だけ `failed`（公開実績のある行は `stopped` + `lastError`。`publishedAt` は残す）。更新・初回公開の中断では配信中の版が分からないため、その旨を `lastError` に残す。問い合わせできないときは `publishing` + `lastError` に留め、停止だけを受け付ける。
- script の不在は「照会が 404」だけでなく「操作の要求自体が 404」でも確定する。どちらも同じ規則（公開実績あり → `stopped` + `lastError`、未公開 → `failed`）で終端へ収束させ、`publishing` のまま残さない。
- 停止の結果が不明なときも同じ問い合わせを行う。無効なら `stopped`、有効なら開始状態 + `lastError`（停止を再試行できる）。問い合わせできない間は開始状態にかかわらず `publishing` + `lastError` に留める（誤って「停止済み」と表示せず、停止を受け付ける）。照会または停止要求が 404 を返したときは不在の確定として終端へ収束させる（次の節と同じ規則）。
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

- 却下: 対象ディレクトリの全量を一覧に載せる必要があり、上限（10,000 entries）に近いディレクトリでは選択 UI 自体が成立しない。プレビュー（[GUI](#gui共有ダイアログ)）+ 名前の除外で足りる範囲に留め、含めるものを選ぶ逆方向の指定は持たない。

### 共有物ごとに除外を上書きする

- 却下: 共有物は受付時のスナップショットで、除外は「そのときの設定」で決まる。共有物ごとに値を持つと、同じ設定画面の意味が対象ごとに変わり、更新のたびにどの一覧が効くかを説明できなくなる。まず全体で 1 つの一覧にし、必要性が出たら状態遷移とセットで設計する。

### glob / パス指定の除外

- 却下: サンドボックスの `exclude` は 1 セグメント名の完全一致で、パスや `*` を解釈しない（[sandbox-api.md](sandbox-api.md#get-v1filesdownload)）。BFF 側だけで解釈すると、計画（walk）と ZIP の生成で別の規則を持つことになり、見えたものと上がるものがずれる。`.env.*` は既定に個別で列挙する。

### 同期 HTTP で公開する

- 却下: 数十 MB の送信で proxy やブラウザのタイムアウトに当たる。受付と状態取得を分ける。

### `/user/tokens/verify` でトークンを検証する

- 却下: account-owned token の検証は `/accounts/{account_id}/tokens/verify` と別 endpoint で、user 側の `/user/tokens/verify` は 401 になり得る。誤アカウントの切り分けのために 2 本目の確認を足すと、かえって失敗の意味が曖昧になる。接続確認は公開の受付と同じ subdomain GET 1 本にする。

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

作成・一覧・詳細・更新・停止・再公開・削除を実装済み。エラーの形は既存の API と同じ `{ error }` とし、何も保存していない変更系の失敗には `state: "not_stored"` を付ける。

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/api/shared-contents` | 一覧（`?sessionId=` で会話の共有物だけに絞れる） |
| `GET` | `/api/shared-contents/preview` | 公開前のプレビュー（`?sessionId=&directory=`）。補助で、確定は公開ジョブ |
| `POST` | `/api/shared-contents` | 作成して公開を開始（202） |
| `GET` | `/api/shared-contents/:id` | 詳細と状態 |
| `POST` | `/api/shared-contents/:id/publish` | 更新（同じ URL へ再公開、202）。未公開（`failed`）からの再試行も同じ経路 |
| `POST` | `/api/shared-contents/:id/stop` | 停止（200） |
| `POST` | `/api/shared-contents/:id/resume` | 再公開（202） |
| `DELETE` | `/api/shared-contents/:id` | 削除（204） |
| `GET` | `/api/settings/cloudflare` | 登録状態（トークンは返さない） |
| `PUT` | `/api/settings/cloudflare` | 登録・更新 |
| `DELETE` | `/api/settings/cloudflare` | 削除 |
| `POST` | `/api/settings/cloudflare/check` | 保存済みの資格情報での接続確認（何も保存しない。詳細は [api.md](api.md#post-apisettingscloudflarecheck)） |
| `GET` | `/api/settings/shared-content-exclusions` | 公開の除外名（実効値・未設定かどうか・上限） |
| `PUT` | `/api/settings/shared-content-exclusions` | 一覧を丸ごと差し替える（空配列は「除外なし」） |
| `DELETE` | `/api/settings/shared-content-exclusions` | 保存行を消して未設定（既定）へ戻す |

作成の入力は `{ sessionId, directory, name? }`。`directory` はセッションの作業ディレクトリ相対で、BFF が root 相対の `sourcePath` へ解決して保存する。絶対パス・`..`・ワークスペース root 自身を指す指定は 400。字面が `.` のときだけセッションの作業フォルダ自身を指し、プロジェクト会話では 409（[セッションと作業ディレクトリ](#セッションと作業ディレクトリ)）。`name` を省略したときはディレクトリ名（root ではセッション ID）を使う。

一覧は `sessionId` クエリで絞り込める（共有ダイアログの「この会話の共有物」）。省略時は全件で、管理一覧はこちらを使う。空文字は指定なしとして扱う。

公開の受付時に `sourcePath` の存在を sandbox へ確認する。ソースは `GET /v1/files/download?path=<dir>&exclude=…` で ZIP 全量を取得し、`exclude` には受付時に解決した公開の除外名（[公開の除外](#公開の除外)）を渡す（空でも明示する）。ZIP は一時ディレクトリへ展開し、成功・失敗にかかわらず削除する。

プレビューは `GET /api/shared-contents/preview?sessionId=&directory=`。公開と同じ対象解決と `GET /v1/files/download/plan` を使うが、**公開の入力には使わない**（差し替えの競合と秘密値の検査は公開ジョブだけが確定できる）。応答は `{ sourcePath, entries, bytes, files, truncated, links, linksTruncated, oversizeFiles, oversizeTruncated, hasIndexHtml, skipped, excludeNames, limited, problems }`。

- `entries` はディレクトリも数える。`files` / `links` / `oversizeFiles` は先頭だけを返し、それぞれ打ち切りの印を持つ
- 上限超過（413）は `limited: true` にし、`entries` / `bytes` / `hasIndexHtml` は `null`、一覧は空、`problems` は上限超過の 1 件だけにする（走査が終わっていないので `index.html` の不在は判定しない）
- `limited: false` のときだけ `index.html` 不在と 1 ファイル 25 MiB 超を `problems` に入れる。問題なしと言い切らない
- パス不正 400 / セッションなし 404 / `directory` がファイル 409 / サンドボックス未設定 503。Cloudflare の資格情報は使わない
- `GET /api/shared-contents/:id` と衝突しないよう、専用のルートを先に登録する

**除外が入る前（Phase 1）は `excludeNames` が空配列で、公開も `exclude=[]` のままだった。** 現在は最後の Phase で追加した「公開の除外」（[公開の除外](#公開の除外)）が実効値になり、同じダイアログの `excludeNames` と `skipped` に反映される。共有物（`shared_contents`）は除外を記録しないため、設定を変えて既存の公開物が変わるのは次の更新から。

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

非同期の受付（作成・更新・再公開）は `202 { id, status: "publishing" }` を返し、状態は GET で読む。停止は provider の結果を待って `200 { id, status: "stopped" }` を返す（停止は subdomain の切替 1 回で終わり、`publishing` を経由しない）。script の不在が確定した停止は `502` を返し、行は `stopped`（公開実績あり）/ `failed`（未公開）+ `lastError` に確定する。削除は本文なしの `204`。

変更系は共有物 id 単位で排他し、同じ id の操作が進行中なら状態を読まずに `409` を返す。別の共有物の操作は待たせない。

公開は BFF のバックグラウンドジョブで、受付は応答だけを返す。`publishing` 中の別の変更は `409`。受付の失敗（セッションなし 404、ソースなし / 資格情報なし / アカウント不一致 / 状態不一致 409、DB・sandbox 503、Cloudflare の受付失敗 502）は 202 を返さない。

一覧・詳細の DTO は `{ id, sessionId, name, sourcePath, provider, status, publicUrl, createdAt, updatedAt, publishedAt, stoppedAt, lastError }`。`lastError` は利用者に見せられる分類済みの文言だけを入れ、provider のレスポンス本文やトークンを含めない。`remoteId` / `providerAccount` は通常の UI に出さない。

状態遷移:

| 現在 | 操作 | 次 |
| --- | --- | --- |
| なし | 作成 | `publishing` |
| `publishing`（初回） | 成功 | `published` |
| `publishing`（初回） | 確定した失敗 | `failed` |
| `publishing`（公開・更新・再公開） | 結果不明 | `publishing`（+ `lastError`、停止のみ可） |
| `publishing`（+ `lastError`） | 停止 | `stopped` |
| `failed` | 公開（再試行） | `publishing` |
| `published` | 更新 | `publishing` |
| `publishing`（更新） | 成功 | `published` |
| `publishing`（更新） | 確定した失敗 | `published`（+ `lastError`） |
| `published` | 停止 | `stopped` |
| `published` | 停止（確定した失敗） | `published`（+ `lastError`） |
| `published` / `publishing`（+ `lastError`） | 停止（結果不明で照会不能） | `publishing`（+ `lastError`、停止のみ可） |
| `published` / `publishing`（+ `lastError`） | 停止（script 不在が確定） | `stopped` + `lastError`（公開実績あり）/ `failed`（未公開） |
| `stopped` | 再公開 | `publishing` |
| `publishing`（再公開） | 成功 | `published` |
| `publishing`（再公開） | 確定した失敗 | `stopped`（+ `lastError`） |
| `publishing`（再公開、script 不在が確定） | 収束 | `stopped` + `lastError`（公開実績あり）/ `failed`（未公開） |
| `published` / `stopped` / `failed` | 削除 | 行なし |

- `publishing` の共有物への別の変更は `409`。ただし結果不明で止まった行への停止だけは受け付ける（削除は停止で確定させてから）。
- 停止の結果不明は、subdomain を照会できたときだけ確定する（無効なら `stopped`、有効なら開始状態 + `lastError`）。照会できない間は開始状態にかかわらず `publishing` + `lastError` に留め、停止を受け付ける。停止をやり直すか、接続が戻ってから停止で確定させる。
- **「結果不明」と「script の不在が確定」は別扱い**。停止・再公開の要求自体が 404 を返した場合と、照会が 404 を返した場合は、外部に公開物が無いことの確定なので、公開実績に応じた終端（公開実績あり → `stopped` + `lastError`、未公開 → `failed`）へ収束させる。`publishing` のまま残して停止も削除もできない状態にはしない（停止の応答は `502`）。
- 再公開は確定失敗なら `stopped` + `lastError` に戻し、結果不明は照会できたときだけ確定する（有効なら `published`、無効なら `stopped` + `lastError`）。照会できない間は `publishing` + `lastError` に留める。再公開は版を変えないので `publishedAt` を進めない。
- 復帰・照会の結果 script が無いと分かった場合、一度も公開できていない行は `failed`、公開実績のある行は `stopped` + `lastError`（`publishedAt` は残す）にする。`failed` は「一度も公開できていない」場合だけに使い、公開実績を消さない。
- `lastError` は受付時に消し、公開・更新・再公開・停止の成功時も消す。確定した失敗と結果不明のときだけ、分類済みの文言を入れる。
- 操作の成否は終端の `status` と `lastError` で判定する。公開・更新・再公開は `published` かつ `lastError` が null なら成功、停止は `stopped` かつ null なら成功。`publishing` + `lastError` は結果不明で、停止を再試行すると `stopped` に確定する。
- 存在しない id は `404`。他の共有物を誤って操作しないよう、id だけで対象を決める。
- 記録した `providerAccount` が現在の接続と一致しないときは `409`。資格情報を入れ替えても既存共有物の操作先を変えない。
- 更新はセッションが存在し、`sourcePath` が実在するときだけ受け付ける。どちらかが欠けていれば `409`。停止・再公開・削除はこの条件を見ない。
- 削除は provider 成功後に `204`。provider が 404 を返したときも成功扱い。`providerAccount` または `remoteId` が無い行は provider を呼ばずに行だけ消す。それ以外の provider 失敗では行を残して `502`。同じ id への 2 回目の削除は行が無いので `404`。
- 資格情報が未登録のときの公開・停止・再公開・削除は、provider を呼ぶ前に `409` で止める。
- 停止・再公開・削除の状態保存に失敗しても provider の操作は成功扱いにせず `503` を返す。操作が冪等なので、再試行すると同じ結果へ収束する。
- 一覧のページングは初期実装では持たない（個人運用の件数に収める）。
- Cloudflare の失敗は認証 / 不存在 / 枠不足 / レート制限 / 一時障害 / タイムアウト / 通信不能に分類し、固定文言だけを `lastError` と応答へ載せる。応答本文とトークンは載せない。タイムアウト・通信不能・5xx は結果不明として workers.dev subdomain を照会し、確定できなければ `publishing` + `lastError` に留める。

## 既知の制限

- URL は「知っていれば誰でも見られる」公開 URL で、認証・期限・アクセス制御は無い。秘密値を含む成果物を公開しないための注意は GUI と tool の案内で行う。
- URL は Cloudflare のアカウントサブドメインに依存する。サブドメインを変更すると既存の URL も変わる。
- アカウントの Free 枠（Worker 数）を他の用途と共有する。
- 中断した公開の復帰は subdomain の有効・無効だけを照会する。配信中の版までは照会しないため、更新の中断では新しい版が配信されている可能性がある（`published` + `lastError` で知らせる）。
- provider の状態を問い合わせできない間は `publishing` + `lastError`（停止を受け付ける）で止まる。接続が戻るまで停止も実行できないため、外部が公開中のまま残り得る。接続を復旧して停止するか、再試行する。
- 停止の結果不明で `publishing` + `lastError` になった行は、停止を再試行すれば `stopped` に確定する（冪等）。停止で確定するまで削除はできない。接続が戻った時点で script が既に無ければ、停止の再試行で `stopped` + `lastError`（公開実績あり）または `failed`（未公開）に確定し、削除できる。
- 同じ共有物の更新は新しい deployment を積む。過去の deployment の掃除はしない（Cloudflare 側の保持に任せる）。
- 削除の冪等性は応答では表さない。同じ id への 2 回目は `404` で、外部で既に消えていたときの 1 回目だけが `204` になる。
- 停止した共有物の script が外部で削除されていると再公開できない（subdomain を有効にする先が無い）。その行は削除してから公開し直す。
- セッションまたはソースの作業フォルダが消えた共有物は更新できない。停止・再公開・削除だけができる。
- 公開先アカウントを変えるには、旧アカウントで既存の共有物を停止・削除する。接続を先に切り替える操作は `409` で止まる。
- 接続確認では Write（Edit）権限を確かめられない。subdomain GET は `Workers Scripts Read` でも通るため、確認できたのは「接続できた」ところまでで、公開の可否は公開時に判定する。
- 公開の除外を変えても、公開済みの共有物の配信内容は変わらない（次回の更新で反映される）。更新前に何が落ちるかは共有ダイアログのプレビューで確認する。
- 除外名はベース名の完全一致で全階層に当たるため、対象ディレクトリ自身と同じ名前の除外はその共有では無効になる（代わりに、その名前の下位ディレクトリも除外されない）。
- 作業フォルダ自身の共有はプロジェクト会話ではできない（プロジェクト全体の公開になるため）。プロジェクト会話ではディレクトリ単位で公開する。
- 作業フォルダ自身の共有は作業フォルダ全量が対象なので、エージェントが置いた調査メモや `.env` の派生名なども既定の除外に当たらなければ含まれ得る。公開前のプレビューで確認する。
- 公開はスナップショットなので、エージェントが後から `index.html` を書き換えても更新を押すまで反映されない。

## 実機で確認する項目

設計時点では Cloudflare のドキュメントで確認できる範囲だけを決めている。実装の最初に実アカウントで確かめ、結果をこの節へ追記する。

- `Workers Scripts: Edit`（Account スコープ）の API トークンで、Worker の作成・更新・subdomain の切り替え・削除が通る
- 静的アセットだけの Worker を API で作れる（Worker スクリプト無し。`main_module` を省略できるか）
- manifest の hash の作り方が Cloudflare の期待と一致する（Wrangler と同じ結果になるか）
- アセット送信の 1 リクエストが 100 MB を超えないよう、bucket をサイズで分割する必要があるか
- subdomain を `enabled=false` にすると外部から 404 になり、`enabled=true` で同じ URL が戻る
- `previews_enabled` を false にできる（不要な Preview URL を増やさない）
- `GET /accounts/{account_id}/workers/subdomain` でアカウントの workers.dev サブドメインを取得でき、公開 URL を受付時に確定できる
- 存在しない script の削除が 404 を返す（冪等扱いの確認）
- 残枠が無いときの API エラー（Worker 数の上限）を分類できる
- `GET /accounts/{account_id}/workers/subdomain` の応答（`result.subdomain`）と、workers.dev 未有効のアカウントでの status と `code`（空文字か 404 か）。接続確認の `no_subdomain` と 404 の文言のどちらに寄せるかを決める
- 誤ったアカウント ID で接続確認したときの status と `code`（トークン種別で 403 と 404 のどちらになるか）
