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

## チャット状態とレンダリング

- SSE イベント（`text` / `tool_start` / `tool_end` / `run_end` など）を React の reducer で受け、イベントログから UI 状態（メッセージ列、ツールカード、実行状態）を導出して仮想 DOM へ反映する。旧 `app.js` のようにイベントハンドラで DOM を直接書き換えるのではなく、「イベントの適用」を純粋な状態遷移として書くことで、再接続時のリプレイ / `resync` も同じ reducer で処理できる。
- 接続管理（`EventSource` の再接続、`Last-Event-ID`、`resync` の検知）はカスタムフックに集約し、コンポーネントは描画に集中する。
- セッションの作成は送信経路（`sendMessage` → `ensureSession`）に置く。未作成チャットで送信したときだけ `POST /api/sessions` を呼び、その応答で sessionId / 履歴 / 実効 Model を差し替えてから SSE を張り直して送信する。作成待ちの間に別のチャットへ切り替えられたら選択は奪わず、送信先は `ensureSession` の戻り値を使う（入力も作成済みセッションも捨てず、空のセッション行を残さない）。作成に失敗したときは未作成チャットのままエラーを表示する。
- 設定変更の応答適用は `client/src/hooks/settingsChange.ts` に切り出す。応答や回復 GET を待っている間にサイドバーで別のチャットへ切り替えられるため、各 await の後に「要求したセッションがまだ選択中か」を確認し、切替済みの古い応答では履歴 / Model / Effort / `lastSeq` / 活動表示を更新しない。
- フックの分割は `useAgentDesk` を facade とし、`useRuntimeCatalog`（health / catalog）、`useProjects`、`useSessions`（一覧・lifecycle・SSE）、`sessionActions`（送信 / 停止の手順）が実装を持つ。

## 開発フローと配信

- 開発時は `pnpm dev`（BFF :4317）と `pnpm dev:web`（Vite :5173、HMR 付き）を併用する。Vite は `/api` を 4317 へプロキシするため、フロントエンドは同一オリジンの API としてそのまま動く。
- 本番は `pnpm build` の産物 `client/dist/` を BFF が配信する。静的配信はリクエストパスを `client/dist` 内のファイルに解決し（ディレクトリ外は 404）、`index.html` は `no-cache`、Vite のハッシュ付き `assets/` 配下は `immutable` でキャッシュする。未ビルドのときは 503 で案内を出す。CSP は変わらず `default-src 'self'` のため、ビルド産物も同一オリジンのアセットだけで動く。

## クライアントの Effect 契約

- 起動時の復元とセッション一覧のポーリングは別の Effect とする。起動処理は表示期間に一度開始し、エージェント選択の変更では再実行しない。起動処理はセッションを作らない（復元先が無ければ未作成チャットのまま表示し、最初の送信で作成する）。
- cleanup 後は、起動処理から呼ぶカタログ取得・一覧取得・セッション復元・health 取得の応答を適用しない。一覧取得は後から開始した要求を優先する。送信経路（`sendMessage` → `ensureSession`）のセッション作成 POST 自体を取り消す保証はない。
- SSE はセッション ID・再接続カウンタに同期し、通知処理は `useEffectEvent` で最新の callback を参照する。OS テーマは `useSyncExternalStore` で購読する。
- 管理フォームは選択対象とカタログの変更を render 中に検出して自身の state を初期化する。カタログ再読込でも未保存入力をリセットする既存の挙動を維持する（設定ページはメイン領域に置き、dialog ではない）。
- DOM のテーマ反映・入力欄の高さ・チャットのスクロール・dialog のフォーカス同期・設定ページの Escape には Effect を残す（チャットのスクロールは設定ページを開いている間だけ止めて、戻ったときに最新位置へ揃える）。コピー完了待ちの要求は cleanup で無効化する。
- フォームの入力値は state updater の外でイベントから読む。updater は遅延評価されるため、その中で `event.currentTarget` を読むと null 参照でツリーごと落ちる（型では防げない）。この形がソースに戻っていないことは `client/test/eventInStateUpdater.test.ts` が固定する。
