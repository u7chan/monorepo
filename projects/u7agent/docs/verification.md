# 検証（lint / format / docs）

実装後は `pnpm check`（lint → format:check → docs:check → 型チェック → テスト → クライアントビルド）を実行する。テストの判断基準と手動受入は [testing.md](testing.md)。

BGMの通常検証はダミーキーと合成stubだけを使う。[実API受入の保留項目](bgm-generation.md#検証と実apiの保留項目) を自動テストやGUI fixtureの成功で確認済みにしない。GUIの結果は担当者がPRへ記録する（実APIの課金確認とは別の受入）。

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

`pnpm lint`。設定は [.oxlintrc.json](../.oxlintrc.json)、検査対象は [package.json](../package.json)。自動修正は `pnpm lint:fix`。

- `categories.correctness`（`no-unused-vars` / `no-unsafe-optional-chaining` など）は error。意図的に残す違反だけを理由コメント付きで disable する（`// oxlint-disable-next-line <rule> -- 理由`）。
- client の Design System ルール（`shadcn/*`）は自動修正されないので手で直す。ルールごとの契約は [frontend.md](frontend.md)、[markdown.md](markdown.md)、[ui-layout.md](ui-layout.md) に置く。
- `shadcn/no-arbitrary-values` の `allow` に足せるのは、Tailwind の scale に無い layout 値（grid テンプレート / vh・dvh / % 幅 / min() 幅 / safe area の `env()`）と、同等の utility が無い複合 transition プロパティ（`transition-[opacity,color]`）だけ。追加するときは値ごとに理由を PR に書く。整数 px は scale で書ける（`--spacing` = 0.25rem の倍数で、倍率に小数を使える）。

## format

`pnpm format` で適用、`pnpm format:check` で差分の有無だけを確認する。設定は [.oxfmtrc.json](../.oxfmtrc.json)。client / server と履歴 benchmark が対象で、それ以外の `scripts/`、プロジェクト root の `package.json` / `docs/` は対象外。

- oxfmt は `className` / `class` の静的文字列、`cn(...)` の引数、CSS の `@apply` のクラス順も揃える。順序は `sortTailwindcss.stylesheet` に指定した `client/src/styles/index.css` から `@theme` の独自トークン込みで決まるため、この CSS を動かすときは設定のパスも直す（stylesheet を読めないと `format:check` は ENOENT で失敗する）。
- className を実行時に組み立てるときは `client/src/lib/cn.ts` の `cn(...)` に通す（引数ごとに並べ替えられ、連結後の順序は引数の順で決まるので、並べ替えたい断片は引数に分ける）。
- クラス文字列は `className` / クラス属性 / `cn(...)` / `@apply` から辿れる位置にだけ置く。素の文字列や配列の `join` で組んだ className は並べ替えの対象外で、`shadcn/*` のクラス検査（`no-arbitrary-values` / `no-restyle` など）からも見えない。

## 履歴の手動 benchmark

[scripts/bench-history-merge.ts](../scripts/bench-history-merge.ts) から server の `projectHistoryPage()` と client の reducer / merge を個別に測れる。既定条件・環境変数の正は script、実測値と CPU profile の所見は計測した PR とし、docs に複製しない。

```sh
pnpm bench:history-merge
BENCH_TARGET=server SIZES=100000 TEXT_CHARS=200 PAGES=40 pnpm bench:history-merge
BENCH_TARGET=client pnpm bench:history-merge
```

server は合成 entry を lockfile と同じ SDK の `SessionManager.inMemory()` へ渡す。fixture 構築、context の更新、assertion、JSON 化は時間に含めず、各呼び出しの `getBranch()` による親リンク走査・配列生成を含む全体時間を `projectMs` として出す。`cpuMs` は process の user + system CPU 差分で、並列 GC なども含み得る補助値とする。HTTP、永続化、agent の実行や `SessionStore` の初期化は対象外。`plain` / `mixed` の分布は固定し、mixed ではダミー秘密値を登録して tool result と長い compaction summary のマスクも通す。

更新時も同じ record と `sessionManager` の窓口を保持し、ID・時刻まで固定した entry 列から基底 SDK manager と context を計測外で組み直す。窓口は毎回 SDK の `getBranch()` へ委譲し、事前生成した branch 配列は返さない。entry が持つ message object は更新前後で共有し、metadata-only 更新では基底 manager と context も変えない。

JIT warm-up に使った record は捨て、別の計測対象 record の初回を cold、同じページの反復を warm とする。遡りは最新ページの `nextCursor` から始め、カーソルが無くなれば要求ページ数より早く終了する。server の JSON 行には実際の生成件数・長さ、要求 / 実取得ページ数、item 数、各ページと実取得ページ合計の UTF-8 serialized bytes を載せる。時間には serialization を含めないので、HTTP の応答時間と解釈しない。

`--expose-gc` は package script が付ける。heap checkpoint は fixture 構築後、cold / warm 後、各状態変更後の投影前と投影後で同じ長寿命の fixture / 検証用索引を保持して GC する。投影結果・serialized 文字列・集計配列は checkpoint 前に解放する。`heapUsedBytes` は harness を含む process 全体の絶対値、`deltaFromPreviousBytes` は隣接 checkpoint との差分であり、fixture の増分や DTO の serialized bytes と区別する。GC 後の値は揺れる観測値であり、合否判定・CI の固定閾値には使わない。

内部の支配箇所は本番コードへ hook を足さず、Node の CPU profile で調べる。

```sh
PROFILE_DIR="$(mktemp -d)"
BENCH_TARGET=server SIZES=10000 PROFILES=mixed ITERATIONS=200 \
  pnpm --filter server exec node --expose-gc --cpu-prof --cpu-prof-dir="$PROFILE_DIR" \
  --import tsx ../scripts/bench-history-merge.ts
echo "$PROFILE_DIR"
```

生成した `.cpuprofile` を Chrome DevTools などへ読み込み、`projectHistoryPage` 配下の self / inclusive CPU を確認する。process 全体には import、fixture 生成、検証、明示 GC も載るため、それらを投影の CPU と混同しない。profile 取得時の時間は通常実行の基準値と分け、同じマシン・runtime・benchmark 条件・負荷で変更前後を比較する。合成履歴の分布で支配箇所は変わり得るため、単独の絶対時間だけで改善を主張しない。
