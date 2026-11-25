# 全体構成

ブラウザ ⇄ BFF（`server/src/app.ts`、Hono）⇄ pi SDK（`server/src/agent.ts`）⇄ サンドボックス（`server/src/sandbox/`、ツール実行）という 4 層構成。エージェントの実行ライフサイクルは HTTP リクエストから完全に切り離され、`server/src/sessions.ts` の `SessionStore` が所有する。LLM 認証情報は BFF 層までで止まり、サンドボックス層へは渡らない。

## 基本原則

1. **実行は裏で続く**: `POST /messages` は 202 で即時返却する。クライアントが切断されても、タブを閉じても、ラン（1 回の `session.prompt()` と、そこへ注入される追加入力）は最後まで続く。
2. **イベントはセッション単位のログに積む**: 全イベントは連番（`seq`）付きでメモリ上のログに追記され、後から購読したクライアントに取りこぼしなくリプレイできる。
3. **停止は明示的に**: SSE 切断では止めない。`POST /stop` のみが実行を中断し、未配信の入力（BFF の配送待ちと SDK の実キュー）を回収して未送信として残す。

## 版の互換の範囲

client・BFF・サンドボックスは同じイメージで配る（`Dockerfile` の `final` を共有し、command だけを変える）。**サポートするのは、同じイメージから配られた組み合わせだけ**とする。版が食い違う組み合わせ（新 client × 旧 BFF、BFF × 旧サンドボックスなど）は互換の契約にせず、片側だけを更新した環境で動くことを約束しない。

この節は「どの分岐を残すか」を決める。版だけが理由の分岐は決定だけでは消さず、決定を受けた別の変更で消す（下表の「削除済み」の括弧がその変更）。消すコードと、そのコードだけを固定しているテストは同時に消してよい（Epic の共通の制約の例外）。

- **残す**: 版以外の理由でも通る分岐。サーバー再起動・SSE の取りこぼし・保存済みデータの欠け・セッション消滅・`payload.messages` からの初期表示・capability の不一致の診断・`gitConfig` / `networkAccess` の省略・予約名の除去・古い SDK が書いた履歴の値欠けの縮退。
- **消す**: 版だけが理由の分岐。現行のイメージが常に載せる値の「無いとき」の縮退、旧 client 専用の HTTP の互換名、旧 client のためだけに残した DTO のフィールド。
- **保存済みデータの互換**: 旧 meta / JSONL / `sends.json` / DB の移行 / 旧 URL の読み替え / 旧カタログのスキル名の表示は、版の互換とは別に残す。永続ボリュームに残るデータを読めなくしない。
- **旧 SDK**: オブジェクトの形が欠けることは想定しない。依存は固定ではないが、SDK は同じイメージに入るため実運用では起こらない。欠けた形を渡すのはテストのスタブと、古い SDK が書いた履歴の値であり、型はそれに合わせて緩くし、コードは変えない。
- **版ずれの案内**: 版が食い違うことを検知して利用者へ再読み込みを促すかは、新しい挙動として別に決める。この節は案内を出さないことを決めていない。

下表の「扱い」は決定と、その決定を実装した変更（括弧内の Issue）を示す。「削除済み」の行の分岐は実装から消えているが、理由欄に書いた版以外の理由で通る分岐（`tool_start.assistantId` と一覧の `lastRunDurationMs`）は残る。決定の記録として「削除済み」の行は消さない（同じ組み合わせを互換の契約へ戻さないため）。

| 想定 | 組み合わせ | 扱い | 理由 |
| --- | --- | --- | --- |
| 送信IDを持たない応答を、run id → 本文の順に突き合わせる縮退 | 新 client × 旧サーバー | 残す | 版以外でも通る（サーバー再起動・保存前に再起動した履歴・応答IDが片方にしか無い保存済みの履歴） |
| 履歴 API の 404 で `payload.messages` の全量へ表示を戻す | 新 client × 旧サーバー | 残す | 版以外でも通る（セッション消滅） |
| 開始時刻・所要時間を載せない応答（`tool_start.startedAt` / `run_end.durationMs`） | 新 client × 旧サーバー | 削除済み（#2730） | 版だけが理由。現行は常に載せる（一覧の `lastRunDurationMs` は `runOutcomes` がメモリのみなので、再起動後と未ロードの会話では載らず残す） |
| SSE の識別子の省略（`run_start.initialSendId` / `text`・`usage`・`assistant_end` の `assistantId` / `queued.sendId` / `queue_cleared.sendIds` / `assistant_end.model`） | 新 client × 旧サーバー | 削除済み（#2730） | 版だけが理由。現行は常に載せる（`model` の `null` は「生成元が不明」で、欠けではない。`tool_start.assistantId` は、その run で assistant の応答が始まる前にツールが始まったときだけ載らないので残す） |
| payload と一覧の省略（`pendingSends` / `canHandoff` / `hasRawLog` / `networkAccess` / `notify` / `titleSummary` / `historyGeneration` / `pinned`） | 新 client × 旧サーバー | 削除済み（#2730） | 版だけが理由。現行は常に載せる（`pinned` は DTO も client も元から必須で、消したものは無い） |
| `tool_end.endedAt` を載せないツール | 新 client × 旧サーバー | 残す | 版以外でも通る（開始を観測しなかったツール。run の外で始まった・取りこぼした） |
| `pendingSends[].position` を載せない送信 | 新 client × 旧サーバー | 残す | 版以外でも通る（キューに無い送信。steering へ移った・注入済み） |
| `assistantMeta` のキー省略 | 新 client × 旧サーバー | 残す | 版以外でも通る（載せる応答が無い） |
| 保存済みデータの欠け（`pinned` / `parentSessionId` / `handoff` / 履歴の `model` と usage など） | — | 残す | 永続ボリュームに残るデータを読めなくしない。`null` と「生成元が不明」は区別して残す |
| SSE カーソルの数値のみ | 旧 client × 新サーバー | 残す | 現行 client も世代が空なら数値だけを送る。どちらも resync に収束する |
| notifications の部分更新（省略 = 据え置き） | 旧 client × 新サーバー | 残す | `enabled` と同じ部分更新の契約で、版に依らない |
| `resendRunId`（`resendSendId` の互換名） | 旧 client × 新サーバー | 削除済み（#2732） | 版だけが理由。現行 client は `resendSendId` を送る |
| `POST /api/sessions/:id/abort` のエイリアス | 旧 client × 新サーバー | 削除済み（#2732） | 版だけが理由。現行 client は `POST /stop` を呼ぶ |
| `usedBy.builtin` | 旧 client × 新サーバー | 削除済み（#2732） | 版だけが理由。サーバーは `false` しか返さないので、client の「（組み込み）」の分岐ごと `usedBy` から消した |
| `gitConfig` / `networkAccess` の省略 | BFF × 旧 sandbox / 旧 BFF | 残す | 現行の BFF も、serve の起動・停止や identity を注入できない実行では省略する |
| 予約名（Git identity を差し替える環境変数）の除去 | BFF × 旧 sandbox / 旧 BFF | 残す | 保存済みの環境変数の行を守る。`gitConfig` 付きの実行は現行でも剥がす |
| capability の不一致の診断（`git-config-v1` / `egress-policy-v1`） | BFF × 旧 sandbox / 旧 BFF | 残す | サンドボックスを差し替えた環境でも診断は害が無く、bash を止めない |
| `network-access.ts` の既定 `allow` | — | 残す | 版以外でも通る（承認 UI を持たない API 直叩きの経路） |
| 旧 SDK のオブジェクトの形の欠け | 旧 SDK | 想定しない | 実運用では起こらない。型は SDK とテストのスタブに合わせ、コードは変えない |

表に無い「旧〜」の分岐を新しく足さない。版以外の理由が無いことを確かめずに、版だけの分岐を残さない。

## 責務の所在

| 責務 | 正 | 変更テーマ |
| --- | --- | --- |
| ラン / 未配信入力（送信ID）の配送 / 購読 / セッション状態 | `server/src/sessions.ts` | [run-lifecycle.md](run-lifecycle.md) |
| 調査の子セッション（investigate） | `server/src/investigate-tool.ts`、`server/src/investigate-runner.ts` | [subagent.md](subagent.md) |
| 会話ストア（永続化 / 復元） | `server/src/session-store.ts` | [session-files.md](session-files.md)、[persistence.md](persistence.md) |
| 会話の引き継ぎ（ファイルの移動 / メモの書込み / 確定と巻き戻し） | `server/src/handoff-move.ts` | [run-lifecycle.md](run-lifecycle.md#引き継ぎと復旧) |
| 会話履歴のクリア（meta の書換え / 履歴と実測の削除 / 確定と片付け） | `server/src/history-clear.ts` | [session-files.md](session-files.md#ライフサイクルと排他)、[api-session-state.md](api-session-state.md#post-apisessionsidhistoryclear) |
| 会話の分岐（親の読み直し / 境界までの複製 / 子の保存と巻き戻し） | `server/src/fork-session.ts` | [run-lifecycle.md](run-lifecycle.md#分岐) |
| 会話タイトルの AI 要約の進行（1 会話 1 試行 / 順番待ち / 適用 / 取消） | `server/src/title-summary-progress.ts` | [session-title.md](session-title.md) |
| pi イベント → SSE イベント変換 | `server/src/run-events.ts` | [run-lifecycle.md](run-lifecycle.md) |
| 履歴 / payload / compaction の DTO 組み立て | `server/src/session-projection.ts`、`session-payload.ts`、`compaction-view.ts` | [run-lifecycle.md](run-lifecycle.md)、[compaction.md](compaction.md) |
| HTTP 契約（DTO の正） | `server/src/schema.ts` | [api.md](api.md) |
| ルート登録のフェーズと `AppType` | `server/src/app.ts`、`server/src/routes/` | [api.md](api.md) |
| pi ランタイム / モデル解決 | `server/src/agent.ts`、`server/src/model-state.ts` | [model-effort.md](model-effort.md) |
| 組み込みツール（Web 検索 / 画像生成 / 音声生成） | `server/src/web-search-tool.ts`、`server/src/image-tools.ts`、`server/src/speech-tools.ts` | [web-search.md](web-search.md)、[image-generation.md](image-generation.md)、[speech-generation.md](speech-generation.md) |
| プロジェクトと cwd | `server/src/projects.ts` | [projects.md](projects.md) |
| ツール実行のサンドボックス | `server/src/sandbox/` | [sandbox.md](sandbox.md) |
| 同梱のヘッドレスブラウザ | `server/src/browser/` | [browser.md](browser.md) |
| サービスの状態と起動・停止 | `server/src/serve.ts`、`server/src/serve-tool.ts`、`server/src/routes/serve.ts` | [sandbox.md](sandbox.md)、[api-sharing.md](api-sharing.md#サービスserveの状態と起動停止) |
| 共有した静的コンテンツの記録と公開（Cloudflare） | `server/src/shared-content-repository.ts`（`shared_contents` / `shared_content_settings`）、`server/src/app-db.ts`（`cloudflare_settings`）、`server/src/shared-contents.ts`、`server/src/shared-content-rules.ts`、`server/src/cloudflare-api.ts` | [static-sharing.md](static-sharing.md) |
| サービス オリジンの転送と公開ポート | `server/src/service-proxy.ts`、`server/src/preview-port.ts`、`server/src/index.ts` | [sandbox.md](sandbox.md#serveサービスの公開と起動停止) |
| 秘密値のマスク | `server/src/redact.ts`、`server/src/secret-guard.ts` | [secrets.md](secrets.md) |
| クライアント（状態 / テーマ / レイアウト） | `client/src/` | [frontend.md](frontend.md)、[ui-layout.md](ui-layout.md) |

セッション状態の所有者は `SessionStore` 1 つに保つ（create と project 削除・settings 変更中の送信抑止・未配信入力 / run / subscriber は複数箇所へ分けると競合を追えなくなる）。pi イベント変換と DTO 組み立ては純関数・アダプタとして外へ出し、ストア本体はライフサイクルだけを持つ。引き継ぎのファイルと保存の手順も `handoff-move` へ出し、`SessionStore` は予約・確定・配信の順序だけを呼ぶ。履歴クリアの保存と削除の手順は `history-clear` へ出し、同じく `SessionStore` は検証と予約・確定・配信の順序を持つ。分岐のファイルと保存の手順は `fork-session` へ出し、`SessionStore` は予約（`lifecycle` / `pendingMoves`）・確定・配信の順序だけを呼ぶ。会話の読み書きは `session-store` へ出し、SDK セッションは `SessionManager.inMemory` + entries として扱う（ファイルは SDK に持たせない）。

## 写す規則と定数の置き場

client / server / サンドボックスは、別のバンドル・別のプロセスで動く。同じ値や規則を両方に書くと、片方だけ変えても型検査では気付けない。共有するかどうかは「同じ見た目か」ではなく、**ずれたときに何が起きるか**で決める。

| 規則（ずれたときに起きること） | 置き場 | 理由 | 例外 |
| --- | --- | --- | --- |
| 保存した本文の区切りと、その分解が食い違う（本文へ付ける添付の注記など） | server の import を持たない葉モジュールと、それを指す `exports` のサブパス。両側がそこから import する | server が書いたバイト列を client が読む。写しのままだと、片側だけ変えても server のテストは自分の書式を読むだけなので通り、画面だけが黙って変わる。その区切りはモデルへの指示文も名指ししているので、食い違えばモデルに渡る説明と実際の本文もずれる。定義を 1 つにする以外に検出する手段がない | 外部の版に追従する形式（SDK の記法など）は、その版の契約として写しを持つ |
| 両側の計算が食い違う（片方だけが集計を直す） | 既にある共有の葉（`server/src/wait-total.ts`）へ計算を足す | 同じ入力から同じ値を出す計算が 2 つあると、画面の値と計測の値がずれる。サブパスを増やさずに済むなら、増やさない | 結果を片側だけが使う計算は写さない |
| server が 4xx で止める（client が上限・形を先回りして検査する） | client の写し。コメントに正の module を書く | 入力欄の `maxLength` と残量の表示には client 側の値が要る。ずれても server が止めるか、client が有効な値を送らせないだけで、保存されたデータは変わらない | サンドボックスの上限は別プロセスの契約なので、その protocol の module を正とする（BFF 側の写しは protocol に合わせる） |
| 表示と集計だけが変わる（履歴のツール名でカードの注記を選ぶ、保存した値を client が読み直して数える） | client の写し | 保存されたデータの意味は変わらず、送信もしないので server は止められないが、変わるのは表示と数字だけ。片側を変えるときは、`rg` で見つかる語か式 | その値で分岐して保存内容・送信先・警告の有無が変わるなら、上の共有の行へ移す |
| 何も起きない（入力欄の例示、既定の表示） | client の写し | 例示が実際の既定と違っても、保存される値は API が返す | 既定そのものを API が返さず両側に書くなら、「server が 4xx で止める」の行と同じ扱いにする |
| 値が同じでも契約が違う（チャットの添付、ワークスペースのアップロード、共有コンテンツの上限など） | それぞれのプロセスの module に置く。共有しない | 同じ定数にすると「同じでなければならない」という嘘の制約ができ、片方を変えるときに無関係な上限まで動かすことになる | 同じ契約であることが読んで分かるなら、その 1 か所へ寄せる |

### サブパスの追加と、パッケージを作らない理由

client が `server/*` から値 import できるのは、`.oxlintrc.json` の許可リストにリテラルで並べたパスだけにする（ワイルドカードは使わない。1 本増やすたびに diff に出る）。共有の葉は import を持たず、それも同じ場所で lint が強制する。client の bundle に `node:sqlite` などが入ると、ビルドは通ってもブラウザで起動しない。

サブパスを増やすのは、上の表で「定義を 1 つにする以外に検出する手段がない」に当たる組だけにする（「保存したバイト列の形式」は写しではずれを検出できないのでサブパスに置く）。

ワークスペースパッケージは作らない。共有する中身は数個の文字列と数十行の純関数で、パッケージの境界を引く量ではない。作ると `pnpm-workspace.yaml`、Dockerfile の `manifests` と `dependencies` の COPY（CI はコンテナ内で `pnpm check` を回す）、lockfile、2 つの tsconfig の解決を同時に追随させることになる。client は既に `server` へ workspace 依存しているので、サブパスの追加は依存を増やさない。

### 写しを許容した組を突き合わせない理由

写しを許容した組に、server と突き合わせるテストは置かない。client のテストから server の内部 module を値 import すると、`server/*` の許可リストをテスト用に緩めることになり、本番の制約とテストの制約が別になる。source を読み取って数値を抜く検査は [AGENTS.md](../AGENTS.md#テスト方針) のテスト方針に反する。写した値は client のテストで固定してある組があり、片側を変えたときは差分として見える。固定していない組も、ずれた結果は 4xx か表示の欠落に閉じる。ずれた結果がそれより重くなる組が出たら、写しではなく共有へ移す。

### クライアントの中で見た目を共有する部品

同じ絵を 2 つの画面に置くときは、寸法と色まで持った部品を専用の module に置く（例: `client/src/components/generationKindIcons.tsx` の生成物の種類の印。置いた側の文字色を継承させず、色を自分で固定する）。`client/src/components/icons.tsx` は 1 アイコン 1 定義の集合で、寸法は自分で持ち、色は置いた側の文字色（`currentColor`）を継承する（例外は `RunSpinnerIcon` の `tone`）。色を固定するか継承するかで契約が違うので寄せない（寄せると、キャプションとバッジで色を揃える規則が呼び出し側へ散る）。同じ絵を 3 か所以上で使う、または寸法まで呼び出し側が決める形へ変えるなら、そのときに寄せるかを決め直す。

## ドキュメントの読み方

変更テーマ別の入口は [README.md](README.md) の索引にまとめている。個別の設計は次のドキュメントを正とする。

- ランとセッション: [run-lifecycle.md](run-lifecycle.md)
- 調査の委譲: [subagent.md](subagent.md)
- プロジェクトと cwd: [projects.md](projects.md)
- モデル / Effort: [model-effort.md](model-effort.md)
- アプリ側の組み込みツール: [web-search.md](web-search.md) / [image-generation.md](image-generation.md) / [speech-generation.md](speech-generation.md)
- サンドボックス: [sandbox.md](sandbox.md) / [sandbox-api.md](sandbox-api.md) / [browser.md](browser.md)
- 静的コンテンツ共有: [static-sharing.md](static-sharing.md)
- APIキー保護: [secrets.md](secrets.md)
- フロントエンド: [frontend.md](frontend.md) / [ui-layout.md](ui-layout.md)
- 圧縮表示: [compaction.md](compaction.md)
- 永続化: [persistence.md](persistence.md)
