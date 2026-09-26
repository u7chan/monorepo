# フロントエンド

チャット UI は `client/` ワークスペースに切り出し、React 19 + Vite + TypeScript + Tailwind CSS v4 で実装している。ソースは `client/src` 配下に置き、エントリは `main.tsx`（`index.html` から読み込む）。SSE イベントは reducer で状態に変換し、旧実装（命令的な DOM 操作）の挙動を忠実に再現する。レイアウトの判定は [ui-layout.md](ui-layout.md)、API 呼び出しの型は [api.md](api.md) を参照する。

## テーマシステム

- テーマは `html` 要素の `data-theme` 属性で決定し、各プリセットが CSS 変数（`--c-*`）を定義する。Tailwind v4 の `@theme inline` で CSS 変数をセマンティックトークンにマップし、コンポーネントはトークンクラス（背景色・文字色など）だけで書く。プリセットの再配色は CSS 変数定義だけで完結するが、テーマの**追加**は CSS 変数（`html[data-theme]` プリセットと `.theme-swatch`）に加えて `client/src/theme/themes.ts` の `THEMES` と `client/public/theme-init.js` の id 配列も更新する（両者の同期は `client/test/themeSync.test.ts` が固定する）。
- アクセントは面用途（`--c-accent` / `--c-accent-bright`。送信ボタン・自分の発言バブル・テーマの色見本）と線・リング用途（`--c-focus`。入力欄の focus 枠・`focus-visible` リング・アクティブタブの下線・checkbox）でトークンを分ける。面用途は明るいまま、`--c-focus` は各プリセットで隣接面に対して 3:1 以上（WCAG 1.4.11）を満たす値にする。
- 文字サイズは Tailwind 既定の段（`xs`=12px / `sm`=14px / `base`=16px）に加えて、小さい側の段を `@theme` に定義する（`--text-3xs`=9px / `--text-2xs`=10px / `--text-1xs`=11px / `--text-1sm`=13px / `--text-md`=16px）。数字が大きいほど小さい t-shirt 記法で、トークンはフォントサイズだけを持ち行間は使う側の `leading-*` が決める。`text-base` は色トークン `--color-base` が取るため使えない（フォントサイズではなく色になる）。uppercase の小見出しの字間は `--tracking-label`（0.14em）に集約する。
- プリセットは 6 種類（ミッドナイト / デイライト / モカ / フォレスト / サクラ / スカイ）に加え、`prefers-color-scheme` に追従する「システム」を選択できる。
- 状態は `ThemeProvider`（`useTheme` フックで参照・変更）が持ち、選択は `localStorage` に保存される。削除済みのテーマ id など無効な値が残っていても system 追従として解決し、保存値は書き換えない（新しく知るテーマを選び直したときに初めて上書きされる）。
- `client/public/theme-init.js` は React 初回描画より前に `data-theme` を適用する外部 classic script。ここを React 側でやると初期化完了までテーマなしで点滅するため、意図的に React の外に置いている。ロジック（localStorage のキー、system 追従の解決）は `ThemeProvider` と同じ選択結果になるよう同期を取る（system の解決先 id は `client/test/themeSync.test.ts` が突き合わせる）。
- BFF の CSP は `style-src 'self'`（インラインスタイル不可）のため、テーマはすべて外部 CSS + 属性切替で実装する。`<style>` の注入やインライン `style` 属性には頼らない。エージェントのアイコン（`AgentDef.icon` の data URL）を `<img>` で描くため、`img-src` だけ `'self' data:` を許す（`script-src` は `'self'` のまま）。

## コンポーネントの契約

- コンポーネントは自分の見た目（余白・文字サイズ・色・効果）を持ち、呼び出し側が `className` / `wrapperClassName` で上書きできるのは layout（位置・幅・伸縮）だけにする。見た目の切替は props で表す（例: `SelectField` の `density`（`sm` / `md` / `lg`）と `compact`、`CopyButton` の `reveal`）。
- この契約は `shadcn/no-restyle`（`.oxlintrc.json` で `allow: ["layout"]`）が検査する。コンポーネントの認識は `settings.shadcn.componentImports` の正規表現で行い、client は path alias を持たずコンポーネントを相対 import でしか参照しないため `^\.\.?/` を登録している（この指定は client/src 配下の全 module に当たるが、JSX のタグとして解決されるのはコンポーネントだけ）。
- バーやゲージなどの図形は CSS（幅と背景色）か SVG で描く。ブロック要素のグリフ（`█` / `▁` など）は端末のフォント次第で字形が崩れ、等幅にならないため `tabular-nums` も効かない。設定 → ランタイムの比率ゲージは数値と桁を揃えて並べるので、幅を `viewBox` の内側で決められる `rect` で描く（`RuntimePage.tsx` の `MetricGauge`。`style` 属性は CSP と `shadcn/no-inline-styles` で使えない）。
- 折りたたみ（`<details>`）は `summary` のブラウザー既定マーカーを外し、`DisclosureChevronIcon` の chevron を開閉の印にする。回転は CSS（`.disclosure-chevron`）が持ち、本文の高さは `details::details-content` の `block-size` を 0 → `auto` へ遷移させる（`interpolate-size: allow-keywords` と `content-visibility` の `allow-discrete` 遷移が要る）。どちらも無いブラウザーでは瞬時に開閉するだけで、機能は落ちない。`prefers-reduced-motion` では遷移を止める。
- 認識済みコンポーネントへ渡す className は静的に読める形で書く（`shadcn/require-static-classes` が error）。ヘルパー関数の戻り値や、別 module から import したクラス定数を渡すと違反になるので、その場合はコンポーネント側に props を足す。
- 状態で見た目を切り替えるボタンの土台（`.btn-quiet` / `.icon-button`）は `client/src/styles/index.css` の `@layer components` に置く。utilities 同士で同じプロパティを並べると（`border-line` と `border-accent/50` など）生成 CSS の順序で勝敗が決まり、`cn()` の後勝ちにならない（compact の通知トグルで On の accent が出なかった原因）。

## チャット状態とレンダリング

- SSE イベント（`text` / `tool_start` / `tool_end` / `run_end` など）を React の reducer で受け、イベントログから UI 状態（メッセージ列、ツールカード、実行状態）を導出して仮想 DOM へ反映する。旧 `app.js` のようにイベントハンドラで DOM を直接書き換えるのではなく、「イベントの適用」を純粋な状態遷移として書くことで、再接続時のリプレイ / `resync` も同じ reducer で処理できる。
- 接続管理（`EventSource` の再接続、`Last-Event-ID`、`resync` の検知）はカスタムフックに集約し、コンポーネントは描画に集中する。
- セッションの作成は送信経路（`sendMessage` → `ensureSession`）に置く。未作成チャットで送信したときだけ `POST /api/sessions` を呼び、その応答で sessionId / 履歴 / 実効 Model を差し替えてから SSE を張り直して送信する。作成待ちの間に別のチャットへ切り替えられたら選択は奪わず、送信先は `ensureSession` の戻り値を使う（入力も作成済みセッションも捨てず、空のセッション行を残さない）。作成に失敗したときは未作成チャットのままエラーを表示する。
- 実行中インジケータの経過時間の起点は `ChatState.runStartedAt`。`run_start` はサーバーが配る `startedAt`、reload / 再接続の `resync` は `payload.run.startedAt` を使い、どちらもサーバー時計になる（受信時刻は使わない。時計がずれた環境では差分が負になり 0 秒に丸まる）。`run_end` と `running` を抜けた `resync` で `undefined` に戻る
- 手動圧縮（compaction）も同じ流儀で、`resync` の `status === "compacting"` から `runStatus` / activity（`会話を整理中…`）/ `compactionStartedAt` を導出し、終端 `resync` で解除する。経過時間の起点は payload の `compactionStartedAt`（サーバー時計）で、`runStartedAt` は再利用しない。`status` イベントは表示文言だけを担う（状態の正は payload）。圧縮中の `queued` は `compacting` を維持し（実際に走っているのは圧縮）、文言も「圧縮中のため待機キューに追加しました」にする。次の `run_start` では開始時刻を引き継がない
- 圧縮の同期 POST（`POST /api/sessions/:id/compact`）と `stop` の応答は、表示の正ではなく補助として扱う。応答の到着が SSE の終端 `resync` より遅くなっても表示を戻さないよう、`useSessions` の操作世代（新しい要求と、`compacting` を抜けた payload で進む）と選択中のセッション id を await の後に確認し、一致しなければ捨てる。圧縮中は `stop` の応答 status（圧縮前の run の値）で解除しない（終端 `resync` / `status` が正）。`sendChatMessage` も圧縮中の `setRun` を `compacting` のままにするほか、`POST /messages` の応答（`queued` の `queueDepth` と `runStatus`）に同じ世代と選択の確認を挟み、終端 `resync` や新しい要求より後に届いた応答で実行中の表示を戻さない
- 手動圧縮のボタンの活性は実効 busy（`running` / `queued` / `compacting`）と送信 / 設定変更の通信中で判定する（`client/src/lib/composerSettings.ts` の `compactDisabled`）。`runStatus === "idle"` は同期義ではない（`statusOf` は idle 相当でも `completed` / `stopped` / `error` を返すため）
- 設定変更の応答適用は `client/src/hooks/settingsChange.ts` に切り出す。応答や回復 GET を待っている間にサイドバーで別のチャットへ切り替えられるため、各 await の後に「要求したセッションがまだ選択中か」を確認し、切替済みの古い応答では履歴 / Model / Effort / `lastSeq` / 活動表示を更新しない。
- フックの分割は `useU7Agent` を facade とし、`useRuntimeCatalog`（health / catalog）、`useProjects`、`useSessions`（一覧・lifecycle・SSE）、`sessionActions`（送信 / 停止の手順）が実装を持つ。
- チャットのスキル一覧（`client/src/components/composer/SkillField.tsx`）は入力欄の補助で、選択すると `/skill:<name> ` を挿入するだけ。展開は送信時に BFF が行う（ファイルは送信時点の内容、組み込みは同梱の registry、カタログはセッション作成時の本文）。一覧はセッションが確定していれば `GET /api/sessions/:id/skills`、新規チャットなら `GET /api/skills/session`（作成前の選択で解決するプレビュー）から `useSessionSkills` が取得し、同名の影になった行は注意書きを付けて出す（それでも選択はでき、優先順位で一意に解決される）。場所の表示はカタログも仮想パス（`.u7agent/agent-skills/<name>/SKILL.md`）を出す。
- 一覧の取得キーは `sessionId`、無ければ `(projectId, agentId)` の組で、これが変わるときだけ取り直す（セッションを開いている間のプロジェクト / エージェントの切替では取り直さない）。切替中に届いた古い応答は `createRequestGate` で捨てる（`ensureSession` の await 中に画面が変わっても、古いプレビューを新しいチャットへ混ぜない）。状態は `SessionSkillsState` の 4 つで、`unavailable` は取得先がまだ判明していないとき（起動直後でカタログ未読み込み）だけ＝ボタンを押せない。取得先がある状態での失敗（サンドボックス未設定の 503 など）は `error` としてパネルに理由を出し、ボタンは押せるままにする。
- 履歴の user 本文には添付の注記と `/skill:` の展開結果が入る。表示は注記を落とし、スキルブロックは `client/src/lib/skillBlock.ts` で分解して畳んで見せる（引数だけを吹き出しに残す）。送信エコーの照合も同じ分解を使い、展開前の入力と `run_start` の本文を同じ形へ寄せてから突き合わせる（`chatReducer.ts`）。

## 開発フローと配信

- 開発時は `pnpm dev`（BFF :4317）と `pnpm dev:web`（Vite :5173、HMR 付き）を併用する。Vite は `/api` を 4317 へプロキシするため、フロントエンドは同一オリジンの API としてそのまま動く。
- 本番は `pnpm build` の産物 `client/dist/` を BFF が配信する。静的配信はリクエストパスを `client/dist` 内のファイルに解決し（ディレクトリ外は 404）、`index.html` は `no-cache`、Vite のハッシュ付き `assets/` 配下は `immutable` でキャッシュする。未ビルドのときは 503 で案内を出す。CSP は `default-src 'self'` に画像だけ `img-src 'self' data:` を足した形（エージェントのアイコン用）で、ビルド産物も同一オリジンのアセットと data URL 画像だけで動く。
- SPA フォールバック（`server/src/static.ts`）: 既存の静的ファイルを優先し、見つからない GET / HEAD のうち**拡張子なしのパス**に限って `index.html` を `/` と同じ本文・`no-cache`・CSP で返す。「拡張子なし」は最後の非空セグメントに `.` を含まない意味で、末尾スラッシュは許容し、dotfile と末尾ドットは対象外にする。`/api` と `/assets` は prefix の境界ごと（`/api` と `/api/` 配下、`/assets` と `/assets/` 配下）対象外にし、除外判定は decode 後のパスで行う（`%2F` で迂回させない）。`Accept` に `text/html` が `q>0` で含まれるときだけ返し（`text/html;q=0`・`application/json`・ワイルドカードのみは対象外）、POST 等も対象外にする。不正な percent encoding と `client/dist` 外へのパスはフォールバックに回さず 404 にする。
- このフォールバックは存在しない拡張子なしパスにも HTTP 200 と `index.html` を返す（soft 404）。**HTTP 200 はパスの存在確認には使えない**。`/foo.txt`・`/assets/missing`・`/api/unknown` は 404 のままで SPA も起動しない。

## URL と画面の対応

画面は URL がただ 1 つの正で、サイドバーのモードや表示中のセクションを state では持たない（`client/src/lib/route.ts` の `parseRoute` / `routePath` が pathname と画面を相互変換し、`client/src/hooks/useRoute.ts` が `popstate` の購読と URL の置換を 1 箇所に集約する）。

- `/` は未選択のチャット、`/settings/<section>` は設定の 7 画面（`agents` / `skills` / `files` / `archive` / `appearance` / `runtime` / `notifications`）、`/s/<sessionId>` は通知のリンクから会話を指定して開く入口（[通知のディープリンク](#通知のディープリンク)）。大文字・末尾スラッシュ・連続スラッシュ・percent encoding は正準形（小文字・末尾スラッシュなし）へ畳む。`/settings` 単体は画面を特定できないため、未知のセクションや不正な encoding と同じくチャットにする
- 画面切替は `replaceState` で、履歴は追加しない（Back / Forward はブラウザーの既存履歴に従う）。URL の置換と表示の更新は `navigate()` だけが行い、両者を独立に同期させない
- クエリとフラグメントは解釈も破棄もしない。`#foo` のような断片リンク（チャット本文の Markdown が通す）を壊さないため、画面切替でもそのまま持ち越す
- 「設定」の行き先は URL のセクションを優先し、`/` では保存した最後のセクションへ。直接 `/settings/<section>` を開いた場合もそのセクションを「最後」として保存する。`Sidebar` の「設定」は `onSelectMode("settings")` を呼ぶため、App は `navProps` と `drawerProps` の両方をこの経路へ接続する
- 設定 → ランタイムは health の診断サマリを使い、全モデルカタログはページを開いたときだけ `GET /api/runtime/models` で取得する。未認証プロバイダーは初期表示で折りたたみ、ページを離れて戻ると再取得する。モデルは モデル名 / ID / 利用可能 / whitelist の 4 列の表（`table-fixed`）で出し、数値はカタログ数を分母にした比率ゲージと丸・盾の印で示す（ID を名前と同じ行に続けて出すと、名前と識別子の境目が読めない）
- 実行環境カードは `GET /api/runtime/environment` の `state`（`connected` / `not_configured` / `unreachable` / `unauthorized` / `timeout` / `probe_failed`）だけで分岐し、HTTP ステータスや文言を解釈しない。`connected` のときだけ OS / アーキテクチャ / 実行ユーザー / ワークスペースを出し、検出できたコマンドだけを名前とバージョンの表にする（バージョンを取れなかったものは「バージョン不明」。存在しないコマンドの一覧やインストール・実行の UI は持たない）。接続状態カードの「サンドボックス = 設定済み」は設定の有無で、実行環境カードの「接続中」は診断 API の正常応答だけを指す
- 開いたときの取得はカタログと実行環境の 2 系統で、health は親が持つ値を使う。再読み込みは親の `refreshHealth()` を含む 3 系統を `Promise.allSettled` 相当でまとめて取り直し、全 settled までボタンを処理中にする。各結果は独立して保持し、1 系統の失敗で他を消さない。`refreshHealth()` は失敗もキャンセルも `null` を返す契約なので、画面側で `null` を失敗へ変換し、health の失敗は「前回値を表示中」と明示する。古い応答の適用は世代番号（`client/src/lib/runtimeEnvironment.ts` の `createRuntimeReloadGate`）で排除し、その判定は親の `refreshHealth(isCurrent)` にもそのまま渡す（画面の state だけでなく親が持つ health も、アンマウント後 / 新しい取得後の応答で上書きしない）
- Vite dev は SPA フォールバックを持つが、本番は BFF が返す（[配信](#開発フローと配信) の SPA フォールバック）。存在しない拡張子なしパスも 200 と `index.html` になる **soft 404** なので、HTTP 200 はパスの存在確認には使えない

## 通知のディープリンク

`/s/<sessionId>` は通知のリンクから会話を開くための**一時的な入口**（入口専用ルート）で、`Route` ではチャット + 保留中の入口（`pendingSessionId`）として表す。リンクの生成（ベース URL + `encodeURIComponent`）はサーバー側（設定 → 通知）が担い、クライアントは受け側だけを持つ。

- `parseRoute` は `/s/<id>` を `pendingSessionId` 付きのチャットとして返し、`routePath` も `/s/<id>` を返す。起動時の正準化は `routePath(parseRoute(pathname))` の比較なので、これが一致しないと選択前に URL が消える（ここが「保留」の実装）
- 起動処理（`useU7Agent` の boot）は、保留の `/s/<id>` があるときだけ一覧からその id を選ぶ。保留が無い `/` は常に未選択のままで、セッション一覧の先頭や以前開いた会話を自動では開かない
- 選択が確定したら `useRoute` の `consumePendingEntry` が `replaceState` で `/` へ畳む（履歴は増やさない）。既に別の画面へ移っていたら何もしない
- 見つからない / 削除済みの id は「リンク先の会話が見つかりませんでした。」を状態行に出し、未選択のチャットのまま `/` へ畳む。一覧に無い場合だけでなく、一覧に載っていた会話が取得までに削除された場合や `GET /api/sessions/:id` が失敗した場合も、別の会話へフォールバックしない
- 遅延した応答が後からのユーザー選択を奪わないよう、**起動処理を始めた時点**の選択世代（`selectionSeqRef`）と比べる（health / catalog / projects の待ちの間の選択も「後からの選択」に含める）。待機中に別の会話や「新しい会話」を選んでいたら、その選択を残して URL だけを畳む（`GET /api/sessions/:id` の待機中も同じ）
- 不正な percent encoding は既存どおりチャットへ畳む（入口にしない）。id は decode した値を使い、URL へ戻すときだけ `encodeURIComponent` する。id に `/` を含む形（`%2F`）はセグメントが余るため入口にしない
- 一覧の取得に失敗したときは入口を解決しない（空の一覧として畳まない）。URL を保ち、次に届いた一覧（4 秒のポーリング）で改めて解決する。サーバー未接続で起動処理が health の時点で止まったときも同じく URL を保ち、リロードで再試行できる

## 保存キーと保存範囲

| キー | 内容 | 復元するもの |
| --- | --- | --- |
| `u7agent-files` | cwd ごとの snapshot を 1 キーに持つ（version 付き）。cwd は 設定 → ファイル の `"."` と、チャットの右パネルで開いたセッションの作業フォルダ | タブの並び・表示中・タブごとの表示モード・開いているディレクトリ |
| `u7agent-settings-section` | 最後に開いていた設定セクション | 「設定」で戻る先（正は URL で、これは `/` からの補助） |

会話の選択は保存しない。会話を指定して開く唯一の入口は通知リンクの `/s/<sessionId>` で、開いた後は `/` に畳む。

- `u7agent-files` は本文・children・loading・error を保存しない（他キーや複数 cwd と合算した容量と、鮮度の問題。復帰時は既存の取得経路で取り直す）。範囲の詳細は [file-preview.md](file-preview.md#復帰f5画面の往復)
- 右パネルはセッションごとに cwd が増えるため、多数のセッションで開くと先に書かれた cwd から落ちる（cwd 上限）。パネルの開閉自体は保存しないので、閉じた状態では何も書かない（タブと展開が空の snapshot は cwd ごと消す）
- cwd は取得 root と同じ単位（`normalizeFileTreeRoot` の結果）で保存するため、`""` と `"."` は同じキーになり、絶対パスも root へ畳む
- 保存値は version を持ち、形（paths の重複と上限、active が paths 内か null、modes の enum と対象タブ、root 相対の展開パス）を検証する。JSON 全体が壊れているときだけ全体を捨て、形の合わない cwd は 1 件ずつ捨てる。`__proto__` / `constructor` のような名前も合法なパスとして往復させる（own property で読み書きする）
- 総量の上限（cwd 20 件 / 展開 200 件 / 書き込み前の JSON 64 KiB）を超える書き込みは捨てる。cwd 数が上限を超えたら先に書かれた cwd から落とす。書き込み側も読み手と同じ検証を通し、読み手が捨てる形（上限超えや active の不整合）は書かない（書くと次の起動でその cwd のタブもモードも失われる）
- 新規 2 キーの read / write は例外を握り、保存領域が使えない環境でも操作を止めず、無限リトライもしない。write が失敗した cwd はメモリ snapshot が最新になるため、同一セッション内の往復（設定を離れて戻る等）は復元できる。ただし write 失敗後の F5 では古い保存値が戻り得る（復元は保証しない）
- 既存 2 キー（`u7agent-project` / `u7agent-agent`）の `localStorage` 直接アクセスは例外を握っていない。**保存領域が使えない環境では現状すでに起動が失敗する**（頑健化は別 Issue）

## クライアントの Effect 契約

- 起動時の `/s/<id>` 解決とセッション一覧のポーリングは別の Effect とする。起動処理は表示期間に一度開始し、エージェント選択の変更では再実行しない。保留 URL が無ければセッションを開かず未作成チャットのまま表示し、最初の送信で作成する。
- 左バーで選択したセッションを開く要求（`GET /api/sessions/:id`）が失敗したときの移り先は、一覧の未試行の先頭とする。**1 回の選択で試すのは一覧 1 周まで**とし、全滅したら未作成チャットへ落として理由（サーバーの文言）を状態行に出す。破損が複数あると「自分以外の先頭」が互いを指して同じ 2 つを往復し、1 回の選択で数百リクエストになるため（判定は `client/src/hooks/sessionFallback.ts`、`client/test/sessionFallback.test.ts` が固定する）。通知リンク `/s/<id>` の失敗時はこのフォールバックを使わず、未選択のまま警告を出す。
- cleanup 後は、起動処理から呼ぶカタログ取得・一覧取得・セッション復元・health 取得の応答を適用しない。一覧取得は後から開始した要求を優先する。送信経路（`sendMessage` → `ensureSession`）のセッション作成 POST 自体を取り消す保証はない。
- SSE はセッション ID・再接続カウンタに同期し、通知処理は `useEffectEvent` で最新の callback を参照する。OS テーマは `useSyncExternalStore` で購読する。
- 管理フォームの下書き（選択中の定義の編集値）はページが持つ。選択対象とカタログの変更を render 中に検出して初期化し、カタログ再読込でも未保存入力をリセットする既存の挙動を維持する（置き場所の理由は [ui-layout.md](ui-layout.md) の「compact の詳細シート」）。
- DOM のテーマ反映・入力欄の高さ・チャットのスクロール・dialog のフォーカス同期・設定ページの Escape には Effect を残す（チャットのスクロールは設定ページを開いている間は触らず、戻ったときに追従中なら最新へ揃える。送信は `ChatState.sendSeq`（`localUser` でだけ 1 進む）の増加で拾い、バブルの形からは推測しない。追従の状態遷移としきい値は [ui-layout.md](ui-layout.md#チャットの自動追従と最下部ボタン)）。作業フォルダのシートを閉じる判定だけは、子の `showModal()` より先に state を確定させる必要があるため Effect ではなく描画中の同期にする（[ui-layout.md](ui-layout.md#既定オープンと手動操作)）。コピー完了待ちの要求は cleanup で無効化する。
- フォームの入力値は state updater の外でイベントから読む。updater は遅延評価されるため、その中で `event.currentTarget` を読むと null 参照でツリーごと落ちる（型では防げない）。この形がソースに戻っていないことは `client/test/eventInStateUpdater.test.ts` が固定する。
- ファイル画面の復元は `FileBrowser` の mount ごとに 1 回。設定 → ファイル の root は常にワークスペース root（`cwd=""` → `"."`）で確定し、チャットの作業フォルダ（`SessionFilesPanel`）は選択中セッションの作業フォルダ（`payload.cwd`）、セッション未作成では作成先プロジェクトの `cwd` を root にする。どちらも起動処理（`useU7Agent` の boot）の完了を待たずに復元・取得・保存する
- チャットの作業フォルダの開閉は `App` の state で、desktop のパネルと compact のシートを分ける（保存しない。URL にも載せない）。パネルの既定は「作成先がプロジェクトなら開」で、適用するのは起動時の初期化と利用者操作の新規会話の入口（`App` の `handleNewChat`）だけ。派生 state（プロジェクト一覧の到着や root の解決）を契機にしない。コンパクトのシートは既定を持たず、設定ページへの出入り / root の変更 / desktop への復帰で閉じる（Effect ではなく描画中の同期。判定は `compact` / `mainView` / `filesRoot` の 3 キーで、`route` オブジェクトは比べない）。条件と期待値の表は [ui-layout.md](ui-layout.md#作業先と作業フォルダの導線)。run_end での取り直しは `ChatState.runEndSeq`（reducer が `run_end` と、`running` を抜けた `resync` で 1 ずつ進める）を起点にし、値が変わったときだけ撃つ。描画間の `runStatus` の差では、同じバッチで届いた `run_start` / `run_end` を React が 1 回の描画にまとめるため取りこぼす
- 復元の順序は 検証 → tabs / modes / 開いているディレクトリを一体で初期化（lazy initializer）→ 取得と保存を許可。復元前の空状態を保存せず、復元した modes を空の `tabs.paths` で掃除しない（StrictMode の再実行でも同じ結果になる）。`u7agent-files` の書き込みは他 cwd を消さない read-modify-write で、内容が同じときは書かない
