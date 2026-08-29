# maimai_dx_rating_calc（仮）

自分の maimai でらっくす RATING を計算するツール（ラボ）。

- 計算仕様: [docs/domain.md](docs/domain.md)（攻略wiki + 既存ツールの実装を整理）
- スコア入力: 最初は maimai.net（公式マイページ）から取得したスコア一覧を CSV で受け取る想定（Lv毎）
- 認証つきの自動取得は将来ステップ

## 現状

- [x] ドメイン整理（docs/domain.md）
- [ ] 計算コア（単曲レート → 枠選定 → RATING）
- [ ] CSV 入力
- [ ] 定数DB
- [ ] 出力（RATING / 内訳 / 色）

## 決定待ち

- 現行バージョン名（新曲枠判定に必要）
- フォルダ名リネーム先（`maimai_dx_best_calc_tools` → ?）