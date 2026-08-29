# maimai_dx_rating_calc（仮）

自分の maimai でらっくす RATING を計算するツール（ラボ）。

- 計算仕様: [docs/domain.md](docs/domain.md)（[公式情報源](https://maimai.sega.jp/) の引用・楽曲マスタ JSON の扱いを含む）
- スコア入力: 最初は [maimai でらっくすNET](https://maimaidx.jp/)（公式マイページ）の Lv 毎スコア一覧からコピペしたテキストを受け取る想定（実測フォーマットは docs/domain.md の『スコア入力フォーマット』参照）
- 認証つきの自動取得は将来ステップ

## 参考リンク

- maimai でらっくす 公式サイト: https://maimai.sega.jp/（あそびかた: https://maimai.sega.jp/play/other1/ ）
- 公式おしらせ（CiRCLE 稼働・RATING 調整）: https://info-maimai.sega.jp/7725/
- 公式おしらせ（CiRCLE PLUS 稼働・RATING 強化/色表）: https://info-maimai.sega.jp/8674/
- 楽曲マスタ JSON（公式配信・1571曲・version は内部コード）: https://maimai.sega.jp/data/maimai_songs.json

## 決定事項

- 現行バージョン名: **CiRCLE PLUS**（2026-03-19 稼働。前バージョン: CiRCLE）→ 新曲枠判定に使用

## 現状

- [x] ドメイン整理（docs/domain.md）
- [x] 公式情報源の引用・楽曲マスタの取り扱い整理（docs/domain.md の『公式情報源（一次ソース）』『公式 楽曲マスタ JSON』の節）
- [ ] 計算コア（単曲レート → 枠選定 → RATING）
- [ ] CSV 入力
- [ ] 定数DB（公式マスタに定数は無い。DX 定数 970 曲分は別途収集が必要。docs/domain.md の『注意・データギャップ』参照）
- [ ] 出力（RATING / 内訳 / 色）

## 調査完了（別ペイン委譲 2026-08-29）

- 公式マスタ JSON の `version` フィールドの意味を確定: 「ST 譜面セット（BASIC〜MASTER）の追加バージョン。ST を持たない曲は DX セットの追加バージョン」。Re:MASTER 追加・旧曲への DX 追加・レベル改訂では変化しない（9 事例の照合で確定）
- 新曲枠判定に必要な譜面単位の追加バージョンは、現行ウィンドウ（CiRCLE PLUS / CiRCLE）では追加調査ほぼ不要と判明（詳細は docs/domain.md の『version フィールドの意味（確定）』『注意・データギャップ』の節）
- 残るデータギャップは **DX 譜面の定数（970 曲分、公式マスタ外の収集が必要）**