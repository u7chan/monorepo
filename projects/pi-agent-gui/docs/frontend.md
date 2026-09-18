# フロントエンド

チャット UI は `client/` ワークスペースに切り出し、React 19 + Vite + TypeScript + Tailwind CSS v4 で実装している。ソースは `client/src` 配下に置き、エントリは `main.tsx`（`index.html` から読み込む）。SSE イベントは reducer で状態に変換し、旧実装（命令的な DOM 操作）の挙動を忠実に再現する。レイアウトの判定は [ui-layout.md](ui-layout.md)、API 呼び出しの型は [api.md](api.md) を参照する。

## テーマシステム

- テーマは `html` 要素の `data-theme` 属性で決定し、各プリセットが CSS 変数（`--c-*`）を定義する。Tailwind v4 の `@theme inline` で CSS 変数をセマンティックトークンにマップし、コンポーネントはトークンクラス（背景色・文字色など）だけで書く。プリセットの再配色は CSS 変数定義だけで完結するが、テーマの**追加**は CSS 変数（`html[data-theme]` プリセットと `.theme-swatch`）に加えて `client/src/theme/themes.ts` の `THEMES` と `client/public/theme-init.js` の id 配列も更新する（両者の同期は `client/test/themeSync.test.ts` が固定する）。
- アクセントは面用途（`--c-accent` / `--c-accent-bright`。送信ボタン・自分の発言バブル・テーマの色見本）と線・リング用途（`--c-focus`。入力欄の focus 枠・`focus-visible` リング・アクティブタブの下線・checkbox）でトークンを分ける。面用途は明るいまま、`--c-focus` は各プリセットで隣接面に対して 3:1 以上（WCAG 1.4.11）を満たす値にする。
- 文字サイズは Tailwind 既定の段（`xs`=12px / `sm`=14px / `base`=16px）に加えて、小さい側の段を `@theme` に定義する（`--text-3xs`=9px / `--text-2xs`=10px / `--text-1xs`=11px / `--text-1sm`=13px / `--text-md`=16px）。数字が大きいほど小さい t-shirt 記法で、トークンはフォントサイズだけを持ち行間は使う側の `leading-*` が決める。`text-base` は色トークン `--color-base` が取るため使えない（フォントサイズではなく色になる）。uppercase の小見出しの字間は `--tracking-label`（0.14em）に集約する。
- プリセットは 6 種類（ミッドナイト / デイライト / モカ / フォレスト / サクラ / スカイ）に加え、`prefers-color-scheme` に追従する「システム」を選択できる。
- 状態は `ThemeProvider`（`useTheme` フックで参照・変更）が持ち、選択は `localStorage` に保存される。削除済みのテーマ id など無効な値が残っていても system 追従として解決し、保存値は書き換えない（新しく知るテーマを選び直したときに初めて上書きされる）。
- `client/public/theme-init.js` は React 初回描画より前に `data-theme` を適用する外部 classic script。ここを React 側でやると初期化完了までテーマなしで点滅するため、意図的に React の外に置いている。ロジック（localStorage のキー、system 追従の解決）は `ThemeProvider` と同じ選択結果になるよう同期を取る（system の解決先 id は `client/test/themeSync.test.ts` が突き合わせる）。
- BFF の CSP は `style-src 'self'`（インラインスタイル不可）のため、テーマはすべて外部 CSS + 属性切替で実装する。`<style>` の注入やインライン `style` 属性には頼らない。

## コンポーネントの契約

- コンポーネントは自分の見た目（余白・文字サイズ・色・効果）を持ち、呼び出し側が `className` / `wrapperClassName` で上書きできるのは layout（位置・幅・伸縮）だけにする。見た目の切替は props で表す（例: `SelectField` の `density`（`sm` / `md` / `lg`）と `compact`、`CopyButton` の `reveal`）。
- この契約は `shadcn/no-restyle`（`.oxlintrc.json` で `allow: ["layout"]`）が検査する。コンポーネントの認識は `settings.shadcn.componentImports` の正規表現で行い、client は path alias を持たずコンポーネントを相対 import でしか参照しないため `^\.\.?/` を登録している（この指定は client/src 配下の全 module に当たるが、JSX のタグとして解決されるのはコンポーネントだけ）。
- バーやゲージなどの図形は CSS（幅と背景色）で描く。ブロック要素のグリフ（`█` / `▁` など）は端末のフォント次第で字形が崩れ、等幅にならないため `tabular-nums` も効かない。
- 認識済みコンポーネントへ渡す className は静的に読める形で書く（`shadcn/require-static-classes` が error）。ヘルパー関数の戻り値や、別 module から import したクラス定数を渡すと違反になるので、その場合はコンポーネント側に props を足す。

## チャット状態とレンダリング

- SSE イベント（`text` / `tool_start` / `tool_end` / `run_end` など）を React の reducer で受け、イベントログから UI 状態（メッセージ列、ツールカード、実行状態）を導出して仮想 DOM へ反映する。旧 `app.js` のようにイベントハンドラで DOM を直接書き換えるのではなく、「イベントの適用」を純粋な状態遷移として書くことで、再接続時のリプレイ / `resync` も同じ reducer で処理できる。
- 接続管理（`EventSource` の再接続、`Last-Event-ID`、`resync` の検知）はカスタムフックに集約し、コンポーネントは描画に集中する。
- セッションの作成は送信経路（`sendMessage` → `ensureSession`）に置く。未作成チャットで送信したときだけ `POST /api/sessions` を呼び、その応答で sessionId / 履歴 / 実効 Model を差し替えてから SSE を張り直して送信する。作成待ちの間に別のチャットへ切り替えられたら選択は奪わず、送信先は `ensureSession` の戻り値を使う（入力も作成済みセッションも捨てず、空のセッション行を残さない）。作成に失敗したときは未作成チャットのままエラーを表示する。
- 設定変更の応答適用は `client/src/hooks/settingsChange.ts` に切り出す。応答や回復 GET を待っている間にサイドバーで別のチャットへ切り替えられるため、各 await の後に「要求したセッションがまだ選択中か」を確認し、切替済みの古い応答では履歴 / Model / Effort / `lastSeq` / 活動表示を更新しない。
- フックの分割は `useAgentDesk` を facade とし、`useRuntimeCatalog`（health / catalog）、`useProjects`、`useSessions`（一覧・lifecycle・SSE）、`sessionActions`（送信 / 停止の手順）が実装を持つ。

## 開発フローと配信

- 開発時は `pnpm dev`（BFF :4317）と `pnpm dev:web`（Vite :5173、HMR 付き）を併用する。Vite は `/api` を 4317 へプロキシするため、フロントエンドは同一オリジンの API としてそのまま動く。
- 本番は `pnpm build` の産物 `client/dist/` を BFF が配信する。静的配信はリクエストパスを `client/dist` 内のファイルに解決し（ディレクトリ外は 404）、`index.html` は `no-cache`、Vite のハッシュ付き `assets/` 配下は `immutable` でキャッシュする。未ビルドのときは 503 で案内を出す。CSP は変わらず `default-src 'self'` のため、ビルド産物も同一オリジンのアセットだけで動く。
- SPA フォールバック（`server/src/static.ts`）: 既存の静的ファイルを優先し、見つからない GET / HEAD のうち**拡張子なしのパス**に限って `index.html` を `/` と同じ本文・`no-cache`・CSP で返す。「拡張子なし」は最後の非空セグメントに `.` を含まない意味で、末尾スラッシュは許容し、dotfile と末尾ドットは対象外にする。`/api` と `/assets` は prefix の境界ごと（`/api` と `/api/` 配下、`/assets` と `/assets/` 配下）対象外にし、除外判定は decode 後のパスで行う（`%2F` で迂回させない）。`Accept` に `text/html` が `q>0` で含まれるときだけ返し（`text/html;q=0`・`application/json`・ワイルドカードのみは対象外）、POST 等も対象外にする。不正な percent encoding と `client/dist` 外へのパスはフォールバックに回さず 404 にする。
- このフォールバックは存在しない拡張子なしパスにも HTTP 200 と `index.html` を返す（soft 404）。**HTTP 200 はパスの存在確認には使えない**。`/foo.txt`・`/assets/missing`・`/api/unknown` は 404 のままで SPA も起動しない。

## URL と画面の対応

画面は URL がただ 1 つの正で、サイドバーのモードや表示中のセクションを state では持たない（`client/src/lib/route.ts` の `parseRoute` / `routePath` が pathname と画面を相互変換し、`client/src/hooks/useRoute.ts` が `popstate` の購読と URL の置換を 1 箇所に集約する）。

- `/` はチャット、`/settings/<section>` は設定の 5 画面（`agents` / `skills` / `files` / `backup` / `appearance`）。大文字・末尾スラッシュ・連続スラッシュ・percent encoding は正準形（小文字・末尾スラッシュなし）へ畳む。`/settings` 単体は画面を特定できないため、未知のセクションや不正な encoding と同じくチャットにする
- 画面切替は `replaceState` で、履歴は追加しない（Back / Forward はブラウザーの既存履歴に従う）。URL の置換と表示の更新は `navigate()` だけが行い、両者を独立に同期させない
- クエリとフラグメントは解釈も破棄もしない。`#foo` のような断片リンク（チャット本文の Markdown が通す）を壊さないため、画面切替でもそのまま持ち越す
- 「設定」の行き先は URL のセクションを優先し、`/` では保存した最後のセクションへ。直接 `/settings/<section>` を開いた場合もそのセクションを「最後」として保存する。`Sidebar` の「設定」は `onSelectMode("settings")` を呼ぶため、App は `navProps` と `drawerProps` の両方をこの経路へ接続する
- Vite dev は SPA フォールバックを持つが、本番は BFF が返す（[配信](#開発フローと配信) の SPA フォールバック）。存在しない拡張子なしパスも 200 と `index.html` になる **soft 404** なので、HTTP 200 はパスの存在確認には使えない

## 保存キーと保存範囲

| キー | 内容 | 復元するもの |
| --- | --- | --- |
| `pi-agent-files` | cwd ごとの snapshot を 1 キーに持つ（version 付き） | タブの並び・表示中・タブごとの表示モード・開いているディレクトリ |
| `pi-agent-settings-section` | 最後に開いていた設定セクション | 「設定」で戻る先（正は URL で、これは `/` からの補助） |

- `pi-agent-files` は本文・children・loading・error を保存しない（他キーや複数 cwd と合算した容量と、鮮度の問題。復帰時は既存の取得経路で取り直す）。範囲の詳細は [file-preview.md](file-preview.md#復帰f5画面の往復)
- cwd は取得 root と同じ単位（`normalizeFileTreeRoot` の結果）で保存するため、`""` と `"."` は同じキーになり、絶対パスも root へ畳む
- 保存値は version を持ち、形（paths の重複と上限、active が paths 内か null、modes の enum と対象タブ、root 相対の展開パス）を検証する。JSON 全体が壊れているときだけ全体を捨て、形の合わない cwd は 1 件ずつ捨てる。`__proto__` / `constructor` のような名前も合法なパスとして往復させる（own property で読み書きする）
- 総量の上限（cwd 20 件 / 展開 200 件 / 書き込み前の JSON 64 KiB）を超える書き込みは捨てる。cwd 数が上限を超えたら先に書かれた cwd から落とす。書き込み側も読み手と同じ検証を通し、読み手が捨てる形（上限超えや active の不整合）は書かない（書くと次の起動でその cwd のタブもモードも失われる）
- 新規 2 キーの read / write は例外を握り、保存領域が使えない環境でも操作を止めず、無限リトライもしない。write が失敗した cwd はメモリ snapshot が最新になるため、同一セッション内の往復（設定を離れて戻る等）は復元できる。ただし write 失敗後の F5 では古い保存値が戻り得る（復元は保証しない）
- 既存 3 キー（`pi-agent-session` / `pi-agent-project` / `pi-agent-agent`）の `localStorage` 直接アクセスは例外を握っていない。**保存領域が使えない環境では現状すでに起動が失敗する**（頑健化は別 Issue）

## クライアントの Effect 契約

- 起動時の復元とセッション一覧のポーリングは別の Effect とする。起動処理は表示期間に一度開始し、エージェント選択の変更では再実行しない。起動処理はセッションを作らない（復元先が無ければ未作成チャットのまま表示し、最初の送信で作成する）。
- cleanup 後は、起動処理から呼ぶカタログ取得・一覧取得・セッション復元・health 取得の応答を適用しない。一覧取得は後から開始した要求を優先する。送信経路（`sendMessage` → `ensureSession`）のセッション作成 POST 自体を取り消す保証はない。
- SSE はセッション ID・再接続カウンタに同期し、通知処理は `useEffectEvent` で最新の callback を参照する。OS テーマは `useSyncExternalStore` で購読する。
- 管理フォームの下書き（選択中の定義の編集値）はページが持つ。選択対象とカタログの変更を render 中に検出して初期化し、カタログ再読込でも未保存入力をリセットする既存の挙動を維持する（置き場所の理由は [ui-layout.md](ui-layout.md) の「compact の詳細シート」）。
- DOM のテーマ反映・入力欄の高さ・チャットのスクロール・dialog のフォーカス同期・設定ページの Escape には Effect を残す（チャットのスクロールは設定ページを開いている間だけ止めて、戻ったときに最新位置へ揃える）。コピー完了待ちの要求は cleanup で無効化する。
- フォームの入力値は state updater の外でイベントから読む。updater は遅延評価されるため、その中で `event.currentTarget` を読むと null 参照でツリーごと落ちる（型では防げない）。この形がソースに戻っていないことは `client/test/eventInStateUpdater.test.ts` が固定する。
- ファイル画面の復元は `FileTreePage` の mount ごとに 1 回。root は常にワークスペース root（`cwd=""` → `"."`）で確定するため、起動処理（`useAgentDesk` の boot）の完了を待たずに復元・取得・保存する
- 復元の順序は 検証 → tabs / modes / 開いているディレクトリを一体で初期化（lazy initializer）→ 取得と保存を許可。復元前の空状態を保存せず、復元した modes を空の `tabs.paths` で掃除しない（StrictMode の再実行でも同じ結果になる）。`pi-agent-files` の書き込みは他 cwd を消さない read-modify-write で、内容が同じときは書かない
