# AGENTS.md

モノレポの `projects/pi-agent-gui`。既存の `projects/aiagent` とは別物。Node.js 24 / pnpm 10.34.5。

pi SDK を BFF に埋め込んだ小さなブラウザ GUI。BFF は **Hono + TypeScript**（`server/`、入力検証は zod）、フロントエンドは Vite + React 19 + TypeScript + Tailwind CSS v4（`client/`）。client は `hono/client`（hc）で server の `AppType` を参照して型安全に API を呼ぶ。セッションとエージェント/スキル定義はメモリ内のみ（永続化しない）。作業用ツールはサンドボックス（別プロセス / 別コンテナ）へ分離済みで、BFF は子プロセスを起こさない。

## 検証

実装したら必ずこれを実行する。

```bash
pnpm check   # lint → format:check → 型チェック → テスト → クライアントビルド
```

lint は `pnpm lint`。設定は root の `.oxlintrc.json` にあり、client には Design System ルール (`shadcn/*`)、server には通常の TypeScript ルールが当たる。`categories.correctness`（`no-unused-vars` / `no-unsafe-optional-chaining` など）は error で、意図的に残す違反だけを理由コメント付きで disable する (`// oxlint-disable-next-line <rule> -- 理由`)。自動修正は `pnpm lint:fix`（`shadcn/*` の指摘は自動修正されないので手で直す）。コンポーネントは見た目（余白・文字サイズ・色・効果）を自分で持ち、呼び出し側の `className` は layout だけにする（`shadcn/no-restyle`）。見た目の切替が要るときは呼び出し側でクラスを足さず、コンポーネントに props を足す。`shadcn/no-arbitrary-values` は error で、`allow` に列挙する例外は Tailwind の scale に無い layout 値（grid テンプレート / `max-h` の vh・dvh / em 幅 / min() 幅）だけ。追加するときは値ごとに理由を PR に書く。整数 px は scale で書ける（`--spacing` = 0.25rem の倍数で、倍率に小数を使える）ので、ルールが検出しない組み立て方（メソッド呼び出しで組んだ className など）でも scale 値へ寄せる。

format は `pnpm format` で適用、`pnpm format:check` で差分の有無だけを確認する。設定は root の `.oxfmtrc.json` にあり、client / server だけが対象（root の `package.json` / `scripts/` / `docs/` は対象外）。

## コメント

why（コードから読めない理由・制約・落とし穴）だけを1〜2行で書き、what（コードを読めば分かる説明）は書かない。長い設計論は `docs/` へ移す。Issue / PR 番号はコメントに残さない（経緯は git 履歴と PR が持つ）。

## 参照

- [README.md](README.md) — 起動方法（`pnpm dev`）・環境変数・セキュリティ
- [docs/](docs) — 設計と API の詳細。入口は [docs/README.md](docs/README.md) の変更テーマ別索引
