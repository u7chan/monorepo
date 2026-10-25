# ADR 0000: スタックとスタイル（Bun + Hono + Preact + 素の CSS）

- Status: accepted
- Date: 2026-10-25

## 背景

作るのは 1 ページの読み取り専用ダッシュボードで、主な利用端末はスマホ。表示するのは 2 つの provider の利用枠と、その推移だけ。
SSR も RSC も要らず、画面から上流を書き換える操作も無い。一方で、モノレポには Node.js + pnpm（`u7agent`）と Bun（`browser-auto`、`portal`）の
どちらの例もあるため、どちらに寄せるかを決める必要がある。

見た目は `hwc` の foundations（色・文字・余白のトークン）をそのまま使い、`pi-console` の usage 画面に合わせる。
依存を増やすほど、更新・脆弱性対応・ライセンス確認・レビューのコストが付いてくる。

## 決定

- Runtime / package manager / bundler / test は Bun。`Bun.serve` の HTML import で `index.html` から client をバンドルする。
- BFF は Hono。`AppType` を export し、client は `hc` で型を共有する。
- Client は Preact + TSX。`preact/compat` は使わない。
- 保存は `bun:sqlite`（ORM なし）。migration は `PRAGMA user_version` で管理する。
- スタイルは素の CSS と CSS 変数。接頭辞は `--up-`。`prefers-color-scheme` に追従し、手動のテーマ切替は持たない。

採用しない案:

- React + Vite: この規模で React の機能を使わない。Vite を挟むと dev / build の経路が 1 本増える。
- Tailwind / CSS Modules / UI コンポーネント集: 画面が 1 ページで、部品も 6 つ程度。ビルド時の依存とクラス名の取り決めを足す利点が無い。
- Node.js + pnpm: Bun の HTML import と `bun:sqlite` で、バンドラと DB ドライバを足さずに済む。

## 理由

- Bun だけで dev、バンドル、テスト、SQLite が揃う。`bun run dev` と `docker` の起動コマンドが同じ 1 本になる。
- Hono の `AppType` と `hc` で、BFF のレスポンス型を client と共有できる。状態管理のライブラリを持ち込まずに済む。
- Preact は JSX と hooks がそのまま使え、実行時の依存が 1 パッケージで収まる。
- 素の CSS は、`hwc` の foundations をコピーして `--up-` 接頭辞を付けるだけで移植できる。Tailwind の設定とクラス名の規約を持たなくてよい。

## 影響

- HTML のバンドルは Bun に任せる。`vite.config.ts` や `tsconfig` のバンドラ設定は持たない。`development` は `NODE_ENV` で切り替える。
- Preact 固有の差分（`class`、`preact/compat` なし）を前提に書く。React 専用の API を持ち込まない。
- CSS のトークン名と値は `src/client/styles.css` を正とする。画面を足すときも色・余白・角丸はトークンから取り、直値を増やさない。
- この PR（PR 分割の 1）で入るのは、骨格、CSS トークン、`GET /api/health`、SQLite の open と v1 の DDL、Dockerfile まで。
- 後続で入るもの: PIN とセッション（2）、Codex の資格情報とサインイン（3）、provider adapter と sampler（4）、ダッシュボードと推移（5）。
