# Design System of Cost Master

cost-master の画面（`/`）の見た目の正。値は [src/client/styles.css](src/client/styles.css) の `--cm-` 変数と
一致させ、片方を変えたらもう片方も同じ PR で直す。

## 1. Visual Theme & Atmosphere

Apple の Human Interface Guidelines にある「グループ化したリスト」を土台にした、静かな管理画面。
見る人は 1 人で、月に数回、価格の確認と「一覧に出す / 出さない」の切り替えのために開く。
装飾を足さずに、モデル名と単価を素早く拾えることを優先する。

- 背景は薄いグレー（`#f2f2f7`）、内容は白い角丸の面（`12px`）に載せ、影は付けない
- モデルは 1 枚の面にまとめ、行の間は左を `16px` 空けた 0.5px の区切り線で分ける
- 文字はシステムフォントだけを使い、大きさと太さで階層を作る（色で作らない）
- 強調色は 1 色 1 役割: 青 = 操作できるもの、緑 = 一覧に出す、オレンジ = 一覧に出さない / 失敗
- 状態は色だけで伝えない（スイッチの位置と「一覧に出す / 一覧に出さない」の文言を併記する）
- 数値は `tabular-nums` で桁を揃える
- すりガラス（blur）は固定表示のツールバーだけに使い、内容の面には使わない
- 動きは 200ms 以下で、状態の変化を追えるところにだけ付ける。`prefers-reduced-motion` では止める
- ライトとダークは別々に値を選び、どちらも文字のコントラスト 4.5:1 以上を確認する

## 2. Color Palette & Roles

コントラストは表の背景色に対する値（WCAG 2 の相対輝度で計算）。

### Surface & borders

- **Background** (`#f2f2f7` / dark `#000000`, `--cm-bg`): ページの地。
- **Surface** (`#ffffff` / dark `#1c1c1e`, `--cm-surface`): 統計タイル、モデル一覧、フォームの面。
- **Fill** (`rgba(118,118,128,0.08)` / dark `0.18`, `--cm-fill`): 面の中の価格タイル、通知の地。
- **Fill strong** (`rgba(118,118,128,0.12)` / dark `0.24`, `--cm-fill-strong`): セグメントの溝、ファイル選択ボタン。
- **Separator** (`rgba(60,60,67,0.16)` / dark `rgba(84,84,88,0.65)`, `--cm-line`): 行の区切り線。
- **Material** (`rgba(242,242,247,0.8)` / dark `rgba(0,0,0,0.72)`, `--cm-material`): 固定ツールバーの地。`saturate(180%) blur(20px)` と組み合わせる。

### Text hierarchy

- **Ink** (`#1d1d1f` / dark `#f5f5f7`, `--cm-ink`): 本文、モデル名、単価。Surface に対して 16.8:1 / 15.6:1。
- **Muted** (`#6e6e73` / dark `#98989d`, `--cm-muted`): 提供元、補足、ラベル。Surface に対して 5.1:1 / 5.9:1、Background に対して 4.5:1 / 7.3:1。

### Interactive

- **Accent** (`#0066cc` / dark `#2997ff`, `--cm-accent`): リンク色の文字、フォーカスリング、「入力」タグ。Surface に対して 5.6:1 / 5.6:1。
- **Accent fill** (`#0071e3`, `--cm-accent-fill`): 主ボタンの地。白文字で 4.7:1。ライト / ダーク共通。
- **Accent tint** (`rgba(0,113,227,0.1)` / dark `rgba(41,151,255,0.16)`, `--cm-accent-tint`): 副ボタンと「入力」タグの地。

### Status

- **Positive** (`#1e7e34` / dark `#30d158`, `--cm-positive`): 「一覧に出す」の文言、オンのスイッチ、成功の通知。Surface に対して 5.1:1 / 8.4:1。
- **Warn** (`#c93400` / dark `#ff9f0a`, `--cm-warn`): 「一覧に出さない」の文言、失敗の通知。Surface に対して 5.3:1 / 8.3:1。
- **Switch off** (`#8e8e93` / dark `#78787d`, `--cm-switch-off`): オフのスイッチの溝。Surface に対して 3.3:1 / 3.9:1（非テキストの 3:1 を満たす）。
- **Positive tint / Warn tint** (`--cm-positive-tint` / `--cm-warn-tint`): 通知の地。文字色と同じ色相の 8%（dark 12%）。

### Shadows

- **Segment thumb** (`0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)`, `--cm-shadow-thumb`)
- **Switch knob** (`0 2px 4px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.04)`, `--cm-shadow-knob`)

## 3. Typography Rules

`-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif`。
等幅は variant と `code` だけで、`ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace`（`--cm-mono`）。
日本語の改行は `word-break: auto-phrase` で文節単位にする（未対応のブラウザは通常の改行になる）。

| Role | Font | Size | Weight | Line Height | Letter Spacing | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Display | System | 28px | 700 | 1.2 | -0.01em | ページ見出し（`h1`）だけ |
| Heading | System | 17px | 600 | 1.5 | 0 | セクション見出し（モデル / マスタの更新） |
| Sub-heading | System | 15px | 600 | 1.5 | 0 | モデル名 |
| Body | System | 15px | 400 | 1.5 | 0 | 既定 |
| Stat value | System | 22px（日時は 15px） | 600 | 28px | 0 | `tabular-nums`、折り返さない |
| Price | System | 14px | 600 | 1.5 | 0 | `tabular-nums` |
| Button | System | 13px | 600 | 1.5 | 0 | 主 / 副ボタン |
| Caption | System | 13px | 400 | 1.5 | 0 | 補足、状態の文言、通知 |
| Micro | System / Mono | 11–12px | 400–600 | 1.5 | 0 | 提供元、統計のラベル、variant、「入力」タグ。11px を下限にする |

## 4. Component Stylings

### Buttons

カプセル形（`border-radius: 999px`）、`min-height: 32px`、`padding: 6px 16px`。

- **Primary**: 地 `--cm-accent-fill`、文字 `#ffffff`。1 画面に 1 つ（アップロード）。
- **Secondary**: 地 `--cm-accent-tint`、文字 `--cm-accent`。ダウンロードのように副次的な操作。
- **Ghost**: ファイル選択ボタン（`::file-selector-button`）。地 `--cm-fill-strong`、文字 `--cm-ink`。
- Hover: 地を少し暗くする（150ms `ease`）。`@media (hover: hover) and (pointer: fine)` の中だけ。
- Active: `transform: scale(0.97)`（150ms ease-out）。
- Disabled: `opacity: 0.4`、カーソルは既定。
- Focus: `outline: 2px solid var(--cm-accent)`、`outline-offset: 2px`（全要素共通の `:focus-visible`）。

### Cards / Containers

- **Group**: 地 Surface、角丸 `12px`、枠線と影なし、`overflow: hidden`。モデル一覧とフォームに使う。
- **Stat tile**: Group と同じ面。`padding: 12px 16px`、ラベルを上、値を下に置く。
- **Price tile**: 地 Fill、角丸 `8px`、`padding: 6px 10px`。`auto-fill, minmax(150px, 1fr)` で並べる。

### Inputs / Forms

- **Switch**（`input[type=checkbox][role=switch]`）: `44 × 26px`、つまみ `22px`。オンは Positive、オフは Switch off。
  左に状態の文言を置き、`label` 全体を押せるようにする。更新中は `opacity: 0.5` と `cursor: progress`。
- **Segmented control**（`role=radiogroup` + ネイティブの radio）: 溝 Fill strong（角丸 `9px`、内側 `2px`）、
  選択中は Surface のつまみ（角丸 `7px`、Segment thumb の影）と太字。並び順と、更新するマスタの種類に使う。
- **Form row**: `padding: 12px 16px`、行の間は 0.5px の区切り線。ラベルは Muted 13px。
- **Notice**: 地 Fill / Positive tint / Warn tint、角丸 `8px`、`padding: 10px 14px`。失敗は `role="alert"`、
  それ以外は `role="status"`。アラートダイアログは使わない。

### Navigation

ページ遷移は無い。モデル一覧の見出しと並び順を Toolbar にまとめ、`position: sticky; top: 0` で固定する。
地は Material、左右はページの余白まで広げる（`margin: 0 -20px; padding: 10px 20px`）。

### Model row

`grid-template-columns: minmax(0, 1fr) auto`。左に提供元（Micro、末尾に `/`）とモデル名（Sub-heading）、
右上にスイッチ、下段に価格タイルを全幅で並べる。一覧に出さないモデルは価格タイルを `opacity: 0.6` に落とす
（モデル名と状態の文言は落とさない）。

## 5. Layout Principles

- 基本単位は 4px。使う値は `2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 32 / 40 / 64`
- 最大幅 `960px`、左右の余白 `20px`、上 `40px`、下 `64px`
- セクションの間は `32–40px`、セクション見出しと面の間は `8px`、面の中の行は `14px 16px`
- 統計は 1 行 5 列（`repeat(4, minmax(0, 1fr)) minmax(max-content, 1.3fr)`）。日時のタイルだけ幅を内容に合わせる
- 角丸: Group `12px` / セグメントの溝 `9px` / つまみ `7px` / タイル・通知 `8px` / タグ `4px` / ボタン `999px`
- 余白で区切り、枠線は区切り線（0.5px）だけにする

## 6. Depth & Elevation

| Level | 用途 | 値 |
| --- | --- | --- |
| 0 | Background、Group、タイル | 影なし。面の色の差だけで重ねる |
| 1 | セグメントのつまみ | `0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)` |
| 1 | スイッチのつまみ | `0 2px 4px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.04)` |
| 2 | 固定ツールバー | 影なし。Material + `backdrop-filter: saturate(180%) blur(20px)`（`-webkit-` 付きも書く） |

動き（すべて `prefers-reduced-motion: reduce` で `transition: none` / `animation: none`）:

| 対象 | 時間 | イージング | 理由 |
| --- | --- | --- | --- |
| セグメントのつまみ | 200ms | `cubic-bezier(0.645, 0.045, 0.355, 1)`（ease-in-out-cubic） | 画面上で動く要素。キーボード操作中（`:focus-visible`）は動かさない |
| スイッチのつまみ / 溝の色 | 200ms | ease-in-out-cubic / `ease` | 同上 / 色の変化 |
| 通知の出現 | 200ms | `cubic-bezier(0.215, 0.61, 0.355, 1)`（ease-out-cubic） | 入ってくる要素。`translateY(-4px)` と透明度から |
| ボタンの押下 | 150ms | ease-out-cubic | 押したことの即時の手応え |
| ボタンの hover / 価格タイルの減光 | 150 / 200ms | `ease` | 色と透明度の変化 |

動かすのは `transform` と `opacity`（色は `background-color`）だけにする。

## 7. Do's and Don'ts

### Do

- 新しい色は役割を決めてから `--cm-` 変数に足し、ライトとダークの両方でコントラストを計算する
- 状態は文言と形（スイッチの位置）で伝え、色は補助にする
- 数値には `tabular-nums` を付ける
- 操作できる要素には `:focus-visible` のリングが出ることを確かめる
- 動きを足したら `prefers-reduced-motion` の指定を同じ変更で足す
- 選択肢が 2–3 個の切り替えはセグメントで出す（`select` にしない）
- 失敗は画面の中の通知で伝え、何が起きてどうすればよいかを書く

### Don't

- 内容の面に影や blur を付けない（blur は固定ツールバーだけ）
- 緑とオレンジを状態以外（装飾、見出し、カテゴリ分け）に使わない
- `scale(0)` から出したり、300ms を超える動きを付けたりしない
- 1 日に何度も触る hover に動きを付けない。タッチ端末で hover を発火させない
- 11px より小さい文字、Muted より薄い文字を使わない
- モデルごとに別のカードへ分けない（1 枚の Group にまとめる）
- `alert()` / `confirm()` で結果を伝えない

## 8. Responsive Behavior

| 幅 | 変化 |
| --- | --- |
| > 640px | 統計は 1 行 5 列 |
| ≤ 640px | 統計は 2 列、日時のタイルは 2 列ぶち抜き |
| すべて | 価格タイルは `auto-fill, minmax(150px, 1fr)` で列数が自動で決まる。ツールバーは折り返す |

- タッチ端末（`pointer: coarse`）では、スイッチの `label`・ボタン・セグメントの各項目を `min-height: 44px` にする
- マウス操作では最小 28px（スイッチの `label`）、ボタンは 32px
- 文字の大きさは幅で変えない

## 9. Agent Prompt Guide

### 主な色

| 役割 | Light | Dark |
| --- | --- | --- |
| 地 / 面 | `#f2f2f7` / `#ffffff` | `#000000` / `#1c1c1e` |
| 文字 / 補足 | `#1d1d1f` / `#6e6e73` | `#f5f5f7` / `#98989d` |
| 操作（青） | `#0066cc`（地は `#0071e3`） | `#2997ff`（地は `#0071e3`） |
| 一覧に出す（緑） | `#1e7e34` | `#30d158` |
| 一覧に出さない / 失敗（オレンジ） | `#c93400` | `#ff9f0a` |

### 指示の例

- 「マスタの更新に『差分を確認』の行を足して。Form row の形で、ボタンは Secondary、結果は Notice で出す」
- 「モデル行に最終更新日を出して。提供元と同じ Micro / Muted で、モデル名の下に置く」
- 「一覧を『一覧に出さないものだけ』に絞れるようにして。Toolbar のセグメントに項目を足し、つまみの動きは既存と同じにする」
- 「新しい状態色が要るなら、まず DESIGN.md の Color Palette に役割と両モードのコントラストを書いてから CSS に足す」

### 繰り返すとき

変更後はライト / ダーク / 幅 390px の 3 つでスクリーンショットを撮り、この文書の Do's and Don'ts と突き合わせる。
値を変えたら styles.css と DESIGN.md の両方を直す。
