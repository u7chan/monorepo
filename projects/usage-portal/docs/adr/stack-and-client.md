# スタックと client の取得方式

- Status: accepted
- Date: 2026-11-23

## 背景

1 ページの読み取り専用ダッシュボードで、主な端末はスマホ。SSR も RSC も要らず、画面から上流を書き換える操作も無い。
モノレポには Node.js + pnpm と Bun の例があるため、実行環境と、どこまでライブラリに寄せるかを決める必要がある。
依存を増やすほど、更新・脆弱性対応・ライセンス確認・レビューのコストが付く。

## 決定

- Runtime / package manager / bundler / test は Bun。`Bun.serve` の HTML import で `index.html` から client を
  バンドルする。保存は `bun:sqlite`（ORM なし）で、migration は `PRAGMA user_version` で管理する。
- BFF は Hono。`AppType` は server 側の型の正として export する。
- Client は Preact + TSX。`preact/compat` は使わない。API は `src/client/api.ts` の型と `fetch` で呼ぶ。
  `hc` は request body の型を validator を入れるまで共有できないため、body を持つ API には使わない。
- 状態管理・UI コンポーネント・日付整形のライブラリは足さない。画面の好み（表示の密度など）は localStorage に置き、
  サーバーへ送らない。
- スタイルは素の CSS と CSS 変数。接頭辞は `--up-`。`prefers-color-scheme` に追従し、手動のテーマ切替は持たない。
- PWA は manifest と 192 / 512px、iOS 用 180px のアイコンだけを配信する。Service Worker、オフライン対応、
  API キャッシュは持たない。manifest と画像は PIN 認証の外に置くが、利用枠や資格情報は含めない。
- manifest はアプリ名「Usage Portal」、`id` / `start_url` / `scope` を `/`、`display` を `standalone` とする。
  アイコンは元画像の縦横比とデザインを保ち、maskable としては宣言しない。manifest 内の画像 URL は、
  Bun の HTML バンドル後も参照できる固定ルートにする。manifest は `no-cache`、画像は favicon と同じく 1 日の公開キャッシュとする。

## 採用しない案

- React + Vite: この規模で React の機能を使わない。Vite を挟むと dev / build の経路が 1 本増える。
- Tailwind / CSS Modules / UI コンポーネント集: 1 ページ・部品 6 つ程度に、ビルド時の依存とクラス名の規約を
  持ち込む利点が無い。
- Node.js + pnpm: Bun の HTML import と `bun:sqlite` で、バンドラと DB ドライバを足さずに済む。
- SSE / WebSocket: 利用枠の変化は分単位で、画面からの操作も無い。再接続、snapshot の再適用、接続状態の表示を
  持ち込む理由が無い。
- client から上流を直接叩く: OAuth の token と API キーをブラウザへ渡すことになる。認証情報は BFF と
  コンテナ内のファイルだけに置く。
- メモリだけに snapshot を持つ: 再起動後に前回値と推移を出せない。
- PWA アイコンを maskable として宣言する: OS の切り抜きを前提にした余白が無く、欠ける。
- Service Worker を足す: オフラインで使う場面が無く、API のキャッシュと認証の扱いが増える。

## 取得方式

- BFF が上流をポーリングし、正規化した snapshot を SQLite に保存する。取得は single-flight とし、
  前の取得が終わる前に次を始めない。
- Client は 60 秒ごとに `GET /api/usage` を叩き、保存済みの snapshot を読む。
- `GET /api/usage` は認証済みなら常に 200 を返し、provider の失敗は payload の `state`
  （`loading` / `ok` / `stale` / `error`）と `error.code` で表す。`Cache-Control: no-store` を付ける。
- サインインの進行表示など即時性が要る画面だけ、例外として 2 秒間隔の GET を使う。SSE は使わない。

## 影響

- `development` は `NODE_ENV` で切り替える。`vite.config.ts` やバンドラ設定は持たない。
- Preact 固有の差分（`class`、`preact/compat` なし）を前提に書く。React 専用の API を持ち込まない。
- CSS のトークン名と値は `src/client/styles.css` を正とする。色・余白・角丸はトークンから取り、直値を増やさない。
- 画面を見ていない間も BFF の取得は続くため、開いた直後に前回値が出る。
