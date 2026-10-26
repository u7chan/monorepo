# Discord 通知

会話（セッション）ごとのトグルが On のとき、エージェントの応答が返ってきたら Discord の Incoming Webhook へ 1 通送る。ブラウザを閉じてもランは BFF で続く（[run-lifecycle.md](run-lifecycle.md)）ため、離席中に終わったことを Discord で知るための仕組み。応答が返らない `ask_user` の回答待ちも、設定 → 通知の「質問の通知」から同じ Webhook へ知らせる（[送るタイミング](#送るタイミング)）。プロバイダーは Discord だけを対象にする。

Discord 通知リンク `/s/<sessionId>?space=<spaceId>` は会話を指定した URL（同じ形のリンクを設定 → ランタイムの「起動元の会話」も使う）。開いた会話は URL に残る（[frontend.md](frontend.md#会話-url)）。`space` は開くスペースの明示で、既定スペースは `default`。`/` は会話を自動復元せず、リンク先を開けない場合も別の会話へ移らない。

正は `server/src/notifications.ts`（設定の読み書き・宛先検証・送信・直近結果・専用マスク）で、ルートは `server/src/routes/notifications.ts`、per-session のトグルは `server/src/sessions.ts` の `setNotify()` が持つ。設定画面は `client/src/components/NotificationSettingsPage.tsx` と `client/src/components/notifications/`。

## 送るタイミング

- トリガーは 2 点だけ。完了通知は `SessionStore.finish()` が `run_end` を記録するときで、`status === "completed"` かつ最終 assistant の本文が空でないとき**1 通**。質問通知は `SessionStore.askQuestion()` が待機を登録するときで、**未 settle の待機が 0 → 1 になる瞬間**だけ**1 通**
- 質問通知の送信ゲートは **全体通知 On・質問の通知 On・Webhook 設定済み**の 3 つ。全体通知が Off なら、質問の通知が On でも送らない。abort シグナルが既に済んでいる登録（回答できない待機）でも送らない
- 質問通知の件数 (N) と本文は、通知の引き金になった最初の呼び出しの質問だけを使う。同じ assistant バッチで並行する後続の呼び出しでは送らない（集約はしない。settle 済みの待機は数えず、全待機が解消した後の再質問は再び 0 → 1 として送る）
- 送信は fire-and-forget で、`run_end` の記録・`persist`・キューの pump・質問の登録と回答を待たせない。fetch の例外はすべて捕捉し、失敗してもランは完了し質問は回答できる。プロセス終了時に未完了の送信は破棄する（結果も記録しない）
- 送るかどうかは **完了なら finish 時点の `notify`**、**質問なら待機の登録時点の `notify`** で決まる。本文はそのランで確定した最終 assistant テキストだけで、履歴は遡らない（assistant を生成しなかったランで前の応答を再送しない）
- エラー / 停止 / 圧縮の通知は送らない。通知履歴は直近 1 件だけ保存する

### 送る内容

```
✅ 完了  <会話のタイトル>
<エージェント名> ・ <実行時間> ・ ツール <n>件
<最終 assistant テキストの先頭 200 文字>
<ベース URL>/s/<sessionId>?space=<spaceId>   ← 会話の所属。ベース URL 未設定なら行ごと出さない
```

- `<実行時間>` はランの所要時間（[run-lifecycle.md](run-lifecycle.md#状態)）で、キュー待ちと回答待ち（`ask_user` の実行区間）を含めない。回答待ちが長い会話では、実際に待った時間より短い値になる
- `space` はその会話の所属スペース。**保存値に依存させず、そのスペースで開くために常に載せる**（既定スペースも `default` として載せる）。所属が引けない / 不正な値のときは `?space=` を付けずに送り、保存値で解決させる（正規化は通知層で行い、通知そのものは失わない）
- 会話を別のスペースへ引っ越すと、移動前に送った通知の `?space=` は旧スペースを指すため 404 になる（会話は移動先にある）。既知の制限で、通知の再送や URL の書換えはしない（[api-sessions.md](api-sessions.md#post-apisessionsidmove)）
- 本文は **mask → truncate** の順（逆順だと上限の境界でキーの末尾が欠ける）。mask は APIキーの masker と Webhook URL の専用マスクの両方で、質問通知の質問文も同じ
- 通知本文は Discord の embed として送る。embed 内の文字列からメンション通知は発生しないため、メンション設定は提供しない
- **会話のタイトル・エージェント名・応答本文の先頭 200 文字が Discord へ送られるのは、会話の通知を On にした会話だけ。** 機微な内容を扱う会話は通知を Off にする（Off でも質問通知は届く。[質問通知](#質問通知)を参照）
- テスト送信は実通知と区別できる本文（`🧪 テスト通知  u7agent`）で、保存済み設定を使って 1 通送る。全体通知と質問の通知の On / Off には関係しない

### 質問通知

会話の通知が On なら、質問通知にもタイトルと第 1 問の本文を載せる。Off ならタイトルも質問文も載せず、何が起きたか・エージェント名・質問件数・会話リンクだけを送る。**機微な会話でも、質問が発生したことと会話リンク（`/s/<sessionId>?space=<spaceId>`）は Discord へ届く**（通知を Off にする意味が「本文を出さない」に変わる）。

- タイトルは最初のユーザー発言から自動生成されるため、本文ありのときのタイトルにも会話の内容が含まれ得る
- 件数が実際の待機数とずれる場合がある（並行する後続の `ask_user` は件数にも本文にも入らない）

## 会話の通知トグル（チャットのバー）

- 押すと `PATCH /api/sessions/:id/notify` を送り、値は `meta.json` に残る（新規チャットは作成時に引き継ぐ先行選択を切り替える）。送るかどうかの判断はサーバーが完了の finish 時点と質問の登録時点で行う
- このトグルが決めるのは、**完了通知を送るかどうか**と**通知本文を載せるかどうか**の 2 点。質問の発生そのものは送信可否に影響せず、**Off の会話でも本文なしの質問通知は届く**（[質問通知](#質問通知)）
- **配信できない設定では On にできない。** 押しても値は変わらず、理由をバーの下に 1 行で出し、`設定を開く` から 設定 → 通知（`/settings/notifications`）へ移動できる。**Off へ戻す操作は常に許可する**（機微な会話の通知を、設定を直すまで止められない状態を作らないため）
- 理由は `disabled`（通知は設定で無効です）と `unconfigured`（Webhook が未設定です）を分ける。判定は `client/src/lib/notifications.ts` が持ち、バーは渡された値を描くだけにする
- 判定は 2 つに分ける。`notifyDeliverable`（今の On が実際に送られるか。色とラベルの根拠）と `notifyCannotEnable`（Off から On へ切り替えられないか。押下を止める根拠）で、保存済みの On は前者が false でも後者も false（Off へ戻せる）。混ぜると、設定が無効なのにベルが accent のまま残る
- 注記は On の間は常に出す（リロード後も出る）。まだ On でないときは押した後だけ出す（設定が無効なだけの会話でバーを埋めないため）。押した後に出す分は会話を移ると捨てる（その場のフィードバックで、戻ってきたときに復活させない）
- 設定が未取得（`null`）の間は判定せず、注記も切替の禁止も accent の変更もしない（起動直後の一瞬だけボタンが効かないと壊れて見えるため）
- accent（強調色）は「実際に送られる」の意味に保つ。配信できない On は accent にせず、バーのラベル / 読み上げ名を「通知（停止中）」にする（色だけに頼らない）
- Off → On の瞬間だけ、ベルが一度鳴る（揺れ + 音の輪 + きらめき。`client/src/components/NotifyBell.tsx` と `styles/index.css` の `.notify-bell-*`）。鳴る根拠は値の立ち上がりではなく**押して On にした操作**で、`App` が On にしたときだけ進める世代を渡し、判定は `client/src/lib/notifyBell.ts` が持つ（会話の切替・リロード・会話 URL (`/s/<id>`) の復元でも値は On へ上がるため、値だけで鳴らすと押していない操作に反応して見える）。配信できない設定では On にならないので、ここでも鳴らない
- 演出はベルの図形に重ねた層（音の輪・きらめき）が担い、鳴り終わりか Off への切替で外れる。素の `opacity` を 0 にしてあるので、動きを止める設定（`prefers-reduced-motion`）では重ねた層ごと出さず、静止したベルと鳴っている印だけが残る（`animation` が無効でも、時間の保険で層を外す）

## API 契約

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/notifications` | `{ enabled, askUser, provider: "discord", configured, webhookAvailable, webhookEvaluated, webhookErrorMessage, baseUrl?, lastResult? }` |
| PUT | `/api/notifications` | `{ enabled?, askUser?, webhookUrl?（null で解除）, baseUrl?（null で解除） }`。宛先とベース URL を検証し、保存時に送信テストはしない。旧クライアントの `mention` は無視する |
| POST | `/api/notifications/test` | 保存済み設定で 1 通。`{ ok, status, latencyMs, message?, code?, retryAfter?, at }` を 200 で返す（アプリ側のエラーだけ 4xx）。タイムアウトは 5 秒 |
| PATCH | `/api/sessions/:id/notify` | `{ notify: boolean }` → `{ sessionId, notify }` を 200 で返す |
| POST | `/api/sessions` | `notify?: boolean`（新規チャットで選んだ値を、作成されるセッションへ引き継ぐ） |
| GET | `/api/sessions` / `/api/sessions/:id` | `notify: boolean`（サーバーは常に載せ、読む側は省略を false として扱う） |

- `PATCH /api/sessions/:id/notify` は専用経路。Model / Effort の `PATCH /settings` には相乗りせず、SDK の設定変更も busy 判定も通さないため実行中でも切り替えられる。live / 未ロードのどちらでも同じ応答で、会話全文は返さない（未ロードでは SDK セッションを開かない）。未知の id は 404
- 直近結果（`lastResult`）は通常通知・質問通知・テスト送信で共通の 1 件。送信開始の世代で新しい方を優先し、古い完了で新しい結果を上書きしない。Webhook URL を変えるとクリアする。再起動後は SQLite から復元する
- `askUser` はキー省略で現在値を維持する（`enabled` と同じ扱い。既定の補完は読み取り / 応答の側だけで行い、`PUT` は保存値をそのまま使う）
- `retryAfter` は 429 のときだけ載る待機秒数（Discord の `retry_after` を切り上げた整数）。429 以外では本文に `retry_after` があっても載せず、読めない値（文字列 / 負 / 非数値）も載せない
- 失敗の表示に使うのは status と Discord の `message` / `code`（429 は `retryAfter`）だけ。リクエスト URL とレスポンス原文は API 応答にも画面にも出さない

## セキュリティ

### Webhook URL は write-only

- `GET /api/notifications` は URL の断片も返さない。`configured`（暗号文の有無）/ `webhookAvailable`（復号できて送信に使える）/ `webhookEvaluated`（復号を評価したか）/ `webhookErrorMessage`（サーバーの固定文言）だけを返し、保存済み URL は API 応答にも画面にも再表示しない。末尾 4 文字の `webhookHint` は廃止した（「GET で復号しない」と両立しないため）。変更するときは空の入力から入れ直す
- Webhook URL は AEAD で保存する（AAD は `u7agent-app-secret:notification_settings:webhookUrl`。[secrets.md](secrets.md#アプリ-db-に保存する-apiキーと-webhook-url)）。復号は起動時と保存 / 置換のときだけで、GET では復号しない。保存済みでも復号できない（誤鍵・未知の鍵版・改ざん・master key 未設定）ときは送信せず、`webhookAvailable: false` と固定文言で利用不可にし、固定の失敗分類を `lastResult` に残す。テスト送信は 503。URL のクリアは復号が要らないため master key 無しでも通す
- URL 全体と `/api/webhooks/…` 以降を `[REDACTED]` へ置換する専用マスクを `server/src/notifications.ts` に置き、API 応答・ログ・エラー本文・fetch 例外へ通す。変更直後も旧 URL をマスクできるよう、メモリ上に直前の値を数件保持する

### 宛先の制限（SSRF / リダイレクト）

- `PUT /api/notifications` が許可するのは `https://discord.com/api/webhooks/<id>/<token>` の形だけ。host は `discord.com` 固定（`discordapp.com` やサブドメインは不可）、パスは `/api/webhooks/` で始まる 2 セグメントで、userinfo / クエリ / フラグメント / 非標準ポートは 400
- 送信は `redirect: "error"` でリダイレクトを追わない（3xx でもトークンを転送しない）。例外のメッセージへ URL を入れない（`server/src/app.ts` の onError がそのまま応答本文へ載せる経路があるため）
- ベース URL は `http` / `https` の origin だけを許可する。`/s/<id>` の組み立ては `new URL()` + `encodeURIComponent` + `space` クエリ（`searchParams.set`）で行う

## 保存先と再起動後

- 会話ごとの `notify` は `SessionMeta`（`meta.json`）に保存する。`version: 1` のまま optional フィールドとして足し、boolean 以外は無視する。live な record は in-memory の meta を更新し、既存の書込みキューで永続化する。一覧（live / 未ロードの descriptor）・`SessionPayload`・`resync` は同じ値を使う。保存に失敗したら 500 を返し、成功扱いにしない
- グローバル設定はアプリデータの SQLite（`PI_SESSION_STORE/u7agent.db`）の `notification_settings`（1 行）に保存する。`APP_DB_SCHEMA_VERSION` 30 → 31 の移行で、Webhook URL は平文の `webhookUrl` から暗号文の `webhookCiphertext` / `webhookNonce` / `webhookKeyVersion` へ移し、既存の URL は破棄する（再入力で復旧する）。`enabled` / `askUser` / `baseUrl` / `lastResult` は残す（[persistence.md](persistence.md#アプリデータsqlite)）
- どちらも会話ストアと同じ永続ボリュームに載るため、再起動後も復元される

## 設定画面

- **Discord カード**: 有効トグルと Webhook URL。保存済みなら「登録済み」+ `[変更]` を出し（URL の断片は出さない）、`[変更]` を押したときだけ入力欄を出す（保存済みの値は入れない）。復号できない・未評価のときは「登録済み（利用できません）」とサーバーの固定文言を出し、`[変更]` で再入力を導く。`[取り消し]` で編集をやめる
- **質問の通知カード**: 質問が発生したことを送るかどうかの全体トグル。全体通知が Off のときは On でも送らない
- **テスト送信カード**: 未設定なら無効 + 「Webhook URL を保存するとテストできます。」。URL に未保存の変更があるときはラベルが「保存してテスト」になり、保存してから送る。直近結果（日時 / status / latencyMs）と失敗理由を出す。429 のときは `retryAfter` があれば「Retry-After N 秒待ってから再試行してください。」、無ければ「時間を置いて再試行してください。」を出す
- **リンクカード**: 通知から会話を開く URL のベース。`[今開いている URL を使う]` で `location.origin` を入れる。空にするとリンク行を載せない
- **メッセージカード**: プレビューを表示する。プレビューは見本（`?space=` 付きのリンク）で、実データはサーバーが組み立てる
- 編集はすべて下書きで、`[保存]` が PUT、`[破棄]` が保存済みの値へ戻す。`webhookUrl` は「変更」で新しく入力したときだけ送り、空にすると解除（null）。`baseUrl` は空なら null。[再読み込み] / [破棄] / [保存] はヘッダ直下の帯へ常設し、[再読み込み] → 区切り線 → 保存群の順に並べる。[再読み込み] は下書きを捨てるため未保存の変更がある間は無効にし、理由をヘッダの説明へ 1 行で出す（[ui-layout.md](ui-layout.md)）
- 設定ナビの「通知」の行には、直近の送信が失敗しているときだけ ⚠ を出す。直近結果は 4 秒ごとに取り直すため、バックグラウンドのラン完了で失敗してもリロードなしで反映される

### リンクの制約

- 既定の `http://127.0.0.1:3000` は**同じ端末のブラウザでしか開けない**（スマホから開くにはトンネル / VPN が要る）
- このアプリには認証がない。**LAN / インターネットへ公開しない**（[README](../README.md#セキュリティ) の警告と同じ）

## 非ゴール

- Slack / メール等の他プロバイダー、複数チャンネル、プロジェクト別の振り分け
- 実行時間の下限・まとめ送り・「タブを開いている間は送らない」などの配信制御
- 質問の発生を N 秒未回答で再送するデバウンスやタイムアウト通知、並行する `ask_user` を集約するためのバッチ識別・待ち合わせ
- Discord からの回答と、`ask_user` 自体の有効 / 無効を設定で切り替えること
- エラー / 停止 / 圧縮の通知（「エラーも送る」は将来）
- 通知履歴の保存（直近 1 件だけ）と本文のカスタムテンプレート
