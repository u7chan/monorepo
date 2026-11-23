# provider のマーク

- Status: accepted
- Date: 2026-11-23

## 背景

カードの見出しに provider のロゴを置いている。当初は `@lobehub/icons-static-svg`（MIT）から取り込んだが、
同じ利用者が使う HWC は Codex・Claude・OpenCode に公式のマークの形を使っており、Claude は lobehub が文字の
`A` 風、HWC が星形で、同じ provider が画面ごとに別のマークに見えていた。カードは provider 名と補足だけで
並び、狭い画面では補足を隠すため、名前を読まなくても provider を思い出せる記号が要る。

## 決定

- マークの形は HWC の client のアイコン定義（`CodexIcon` / `ClaudeIcon` / `OpenCodeIcon`）と同じにし、
  `src/client/lib/provider-icon.ts` のパスと viewBox を置き換える。
- OpenCode は HWC と同じく、内側の四角を透過（`fill-opacity`）で薄く描く。形の一部なので省かない。
- マークは装飾（`aria-hidden`）とし、名前が同じ行に出るので読み上げには足さない。
- HWC から共有パッケージとしては取り込まない。3 つの SVG のために別プロジェクトへ依存すると、更新と配布の
  手間が見合わない。形が変わったときは手で合わせる。
- lobehub のパスを使わなくなるので、`THIRD_PARTY_NOTICES.txt` から lobehub の帰属と MIT の全文を外し、
  商標として扱う旨と取り込み先を残す。通知は final image にも含める。
- 通知には、出典を確認できたかどうかによらず、商標として扱う旨だけを残す。

## 採用しない案

- lobehub のパスを使い続ける: 同じ provider が画面ごとに違う形になり、Claude の形の差が大きい。
- HWC を共有パッケージとして依存する: 3 つの SVG に対して、別プロジェクトの更新と配布を追うことになる。
- マークを文字の補足だけで示す: 狭い画面では補足を隠すため、名前だけのカードが残る。

## 影響

- 取り込み元の HWC が HWC 内で出典を記録しているのは OpenCode だけで、公式のブランドページ
  （https://opencode.ai/brand）を参照している。Codex と Claude のマークは出典を確認できていない。
- 形が変わったときは `src/client/lib/provider-icon.ts` と `THIRD_PARTY_NOTICES.txt` を合わせて直す。
