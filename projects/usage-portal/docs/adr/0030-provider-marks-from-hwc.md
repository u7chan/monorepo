# ADR 0030: provider のロゴを HWC のマークに揃え、ステータスのメニューにも置く

- Status: accepted
- Date: 2026-11-22
- 一部置き換え: [ADR 0027](0027-provider-order-and-icons.md) の、ロゴのパスを `@lobehub/icons-static-svg` から取り込む決定
- 一部置き換え: マークを `currentColor` のままにする決定は [ADR 0031](0031-provider-mark-colors.md) が上書きする

## 背景

ADR 0027 でカードの見出しに provider のロゴを置いたが、マークは `@lobehub/icons-static-svg` から取った。
同じ利用者が使う HWC（エージェントを束ねる別プロジェクト）は、Codex・Claude・OpenCode に公式のマークの形を
使っている。Claude は lobehub が文字の `A` 風、HWC が Claude の星形で、同じエージェントなのに画面ごとに
別のマークに見える。

また、ADR 0029 でヘッダーのメニューに置いた「ステータス」の子メニューは、項目が文字だけだった。
カードでは名前の前にロゴがあるので、同じ 3 つの provider をロゴなしで並べると対応が取りにくい。

## 決定

- ロゴの形を HWC の client のアイコン定義（`CodexIcon` / `ClaudeIcon` / `OpenCodeIcon`）と同じにする。
  `src/client/lib/provider-icon.ts` のパスと viewBox を置き換える。
- OpenCode は HWC と同じく、内側の四角を透過（`fill-opacity`）で薄く描く。形の一部なので省かない。
- 色は ADR 0027 のとおり `currentColor` のままにする。HWC は Claude に橙などのブランド色を当てているが、
  ダークモードのコントラストと状態ラベルの色との競合を避ける決定は変えない。→ [ADR 0031](0031-provider-mark-colors.md) で改めた。
- 「ステータス」の子メニューの各項目に、カードと同じ provider のマークを項目名の前に置く。
  `MenuLink` に任意の `icon` を足して描画し、メニューは provider を知らないままにする。
  名前が同じ項目に出るので、マークは装飾（`aria-hidden`）にする。
- lobehub のパスを使わなくなるので、`THIRD_PARTY_NOTICES.txt` から lobehub の帰属と MIT の全文を外し、
  商標であることと取り込み先の表示にする。

## 採用しない案

- HWC のブランド色まで揃える: 明暗でコントラストが変わり、状態ラベルと競合する。ADR 0027 の理由が残る。
  → [ADR 0031](0031-provider-mark-colors.md) で採用した。
- マークを HWC から共有パッケージとして取り込む: 3 つの SVG のために別プロジェクトへ依存すると、
  更新と配布の手間が見合わない。形が変わったときは手で合わせる。

## 影響

- カードのロゴの見た目（特に Claude の形）と、ステータスの子メニューの見た目が変わる。
- 取り込み元の HWC が出典を記録しているのは OpenCode だけで、公式のブランドページ
  （https://opencode.ai/brand）を参照している。更新や利用条件の確認はそこからたどる。Codex と Claude の
  マークは HWC 側に出典の記録がなく、このプロジェクトでも出典を確認できない。
- 通知には、出典を確認できたかどうかによらず、商標として扱う旨だけを残す。
- `src/client/lib/provider-icon.ts`、`src/client/components/ProviderIcon.tsx`、`OverflowMenu.tsx`、
  `App.tsx`、`styles.css`、`THIRD_PARTY_NOTICES.txt`、`test/license-notices.test.ts`、`Dockerfile` のコメント。
