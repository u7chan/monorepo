# AGENTS.md

モノレポの `projects/u7agent`。既存の `projects/aiagent` とは別物。Node.js 24 / pnpm 10.34.5。

pi SDK を BFF に埋め込んだ小さなブラウザ GUI。BFF は **Hono + TypeScript**（`server/`、入力検証は zod）、フロントエンドは Vite + React 19 + TypeScript + Tailwind CSS v4（`client/`）。client は `hono/client`（hc）で server の `AppType` を参照して型安全に API を呼ぶ。セッションと会話履歴は BFF 専用の会話ストア（`PI_SESSION_STORE`）に保存され再起動後も復元される。エージェント / スキル定義とプロジェクトはアプリデータの SQLite（`<PI_SESSION_STORE>/u7agent.db`）へ保存され、再起動後も残る。作業用ツールはサンドボックス（別プロセス / 別コンテナ）へ分離済みで、BFF は子プロセスを起こさない。

## 検証

実装したら必ずこれを実行する。

```bash
pnpm check   # lint → format:check → 型チェック → テスト → クライアントビルド
```

lint は `pnpm lint`。設定は root の `.oxlintrc.json` にあり、client には Design System ルール (`shadcn/*`)、server には通常の TypeScript ルールが当たる。`categories.correctness`（`no-unused-vars` / `no-unsafe-optional-chaining` など）は error で、意図的に残す違反だけを理由コメント付きで disable する (`// oxlint-disable-next-line <rule> -- 理由`)。自動修正は `pnpm lint:fix`（`shadcn/*` の指摘は自動修正されないので手で直す）。コンポーネントは見た目（余白・文字サイズ・色・効果）を自分で持ち、呼び出し側の `className` は layout だけにする（`shadcn/no-restyle`）。見た目の切替が要るときは呼び出し側でクラスを足さず、コンポーネントに props を足す。`shadcn/no-arbitrary-values` は error で、`allow` に列挙する例外は Tailwind の scale に無い layout 値（grid テンプレート / vh・dvh / % 幅 / min() 幅 / safe area の `env()`）と、同等の utility が無い複合 transition プロパティ（`transition-[opacity,color]`）だけ。追加するときは値ごとに理由を PR に書く。整数 px は scale で書ける（`--spacing` = 0.25rem の倍数で、倍率に小数を使える）。

format は `pnpm format` で適用、`pnpm format:check` で差分の有無だけを確認する。設定は root の `.oxfmtrc.json` にあり、client / server だけが対象（root の `package.json` / `scripts/` / `docs/` は対象外）。oxfmt は `className` / `class` の静的文字列、`cn(...)` の引数、CSS の `@apply` のクラス順も揃える。順序は `sortTailwindcss.stylesheet` に指定した `client/src/styles/index.css` から `@theme` の独自トークン込みで決まるため、この CSS を動かすときは設定のパスも直す（stylesheet を読めないと `format:check` は ENOENT で失敗する）。className を実行時に組み立てるときは `client/src/lib/cn.ts` の `cn(...)` に通す（引数ごとに並べ替えられ、連結後の順序は引数の順で決まるので、並べ替えたい断片は引数に分ける）。クラス文字列は `className` / クラス属性 / `cn(...)` / `@apply` から辿れる位置にだけ置く。素の文字列や配列の `join` で組んだ className は並べ替えの対象外で、`shadcn/*` のクラス検査（`no-arbitrary-values` / `no-restyle` など）からも見えない。

## テスト方針

実装方法を変えてもユーザーから見た仕様が同じなら、テストはそのまま通る設計を優先する。

- pure logic、state transition、API、永続化、security boundary、retry / timeout / queue と重要な操作・アクセシビリティ契約は自動テストする。
- TSX / CSS を `readFileSync` して class 名・関数名・コード断片の存在を検査するテストは原則追加しない。例外は型で保証できない安全性・複数形式間の契約に限定し、理由と検査範囲を明記する。
- lint / typecheck が保証する内容を unit test で重複して固定しない。
- CSS animation、spacing、色、translate、duration 等の視覚調整は原則として自動テストしない。CSS 値を入力にする parser / fallback ロジックは別で、自動テストする。
- 過去バグも修正方法ではなく観測できる不具合を検証する。DOM が必要なら source scan で代用せず、ブラウザで確認する。
- GUI の短時間で確認できる見た目は手動受入でよい。最小チェックと既存テストの分類は [docs/testing.md](docs/testing.md) を参照する。

## コメント

why（コードから読めない理由・制約・落とし穴）だけを1〜2行で書き、what（コードを読めば分かる説明）は書かない。長い設計論は `docs/` へ移す。同じ理由をコードと `docs/` に二重に書かない（正は `docs/` に置く）。Issue / PR 番号はコメントに残さない（経緯は git 履歴と PR が持つ）。

## 参照

- [README.md](README.md) — 起動方法（`pnpm dev`）・環境変数・セキュリティ
- [docs/](docs) — 設計と API の詳細。入口は [docs/README.md](docs/README.md) の変更テーマ別索引
