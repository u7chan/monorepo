# 検証（lint / format / docs）

実装後は `pnpm check`（lint → format:check → docs:check → 型チェック → テスト → クライアントビルド）を実行する。テストの判断基準と手動受入は [testing.md](testing.md)。

## docs

`pnpm docs:check`（`scripts/docs-check.mjs`）。次を検査する。

- `docs/` / `AGENTS.md` / `README.md` の相対リンクの参照先と `#anchor` が実在すること（リンク記法の例示はコード span とコードブロックを除いて判定する）
- 本文中の `client/src/...` などのパスが実在すること
- `client/src` / `client/test` / `server/src` / `server/test` のコメントにある `docs/xxx.md#anchor` の参照先が実在すること
- `docs/` / `AGENTS.md` / `README.md` の見出しに UI の階層（`設定 → 通知`）を書かないこと（見出しがアンカーの正のため。フェンス付きコードブロックと複数行のコード span は除いて判定し、見出しの中の単一のコード span は見出しの一部として判定する）
- フロントエンドの docs（`ui-layout.md` / `frontend.md`）が行数予算に収まっていること。予算は現在の実測値の ratchet で、上げるときは diff に出してレビューで合意する

**project root の外を指すリンク（モノレポ全体への参照）は未検査**にする。CI は project 単位のビルドコンテキストでこの script を走らせるため、`../../AGENTS.md` のような参照先が存在せず、検査すると常に失敗する。未検査の件数は結果に出す。

検査しないのは「その文が実装の写像かどうか」で、そこは review で見る（判定式は [AGENTS.md](../AGENTS.md#docs)）。

## lint

`pnpm lint`（`oxlint client server`）。設定は [.oxlintrc.json](../.oxlintrc.json)。自動修正は `pnpm lint:fix`。

- `categories.correctness`（`no-unused-vars` / `no-unsafe-optional-chaining` など）は error。意図的に残す違反だけを理由コメント付きで disable する（`// oxlint-disable-next-line <rule> -- 理由`）。
- client の Design System ルール（`shadcn/*`）は自動修正されないので手で直す。ルールごとの契約は [frontend.md](frontend.md)、[markdown.md](markdown.md)、[ui-layout.md](ui-layout.md) に置く。
- `shadcn/no-arbitrary-values` の `allow` に足せるのは、Tailwind の scale に無い layout 値（grid テンプレート / vh・dvh / % 幅 / min() 幅 / safe area の `env()`）と、同等の utility が無い複合 transition プロパティ（`transition-[opacity,color]`）だけ。追加するときは値ごとに理由を PR に書く。整数 px は scale で書ける（`--spacing` = 0.25rem の倍数で、倍率に小数を使える）。

## format

`pnpm format` で適用、`pnpm format:check` で差分の有無だけを確認する。設定は [.oxfmtrc.json](../.oxfmtrc.json)。対象は client / server だけで、プロジェクト root の `package.json` / `scripts/` / `docs/` は対象外。

- oxfmt は `className` / `class` の静的文字列、`cn(...)` の引数、CSS の `@apply` のクラス順も揃える。順序は `sortTailwindcss.stylesheet` に指定した `client/src/styles/index.css` から `@theme` の独自トークン込みで決まるため、この CSS を動かすときは設定のパスも直す（stylesheet を読めないと `format:check` は ENOENT で失敗する）。
- className を実行時に組み立てるときは `client/src/lib/cn.ts` の `cn(...)` に通す（引数ごとに並べ替えられ、連結後の順序は引数の順で決まるので、並べ替えたい断片は引数に分ける）。
- クラス文字列は `className` / クラス属性 / `cn(...)` / `@apply` から辿れる位置にだけ置く。素の文字列や配列の `join` で組んだ className は並べ替えの対象外で、`shadcn/*` のクラス検査（`no-arbitrary-values` / `no-restyle` など）からも見えない。
