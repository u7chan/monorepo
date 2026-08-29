# maimai_dx_rating_calc（仮）

自分の maimai でらっくす RATING を計算する自作ツール。

- 計算仕様: [docs/domain.md](docs/domain.md)（[公式情報源](https://maimai.sega.jp/) の引用・楽曲マスタ JSON の扱いを含む）
- 文書作成ルール: [docs/conventions.md](docs/conventions.md)（§使用禁止・出典方針・用語）
- スコア入力: [maimai でらっくすNET](https://maimaidx.jp/) にログイン →「レコード」>「楽曲スコア」>「LEVEL」の Lv 毎一覧を Ctrl+A / Ctrl+C でコピーしたテキストを受け取る想定（手順は docs/domain.md の『スコア入力フォーマット』参照）
- 認証つきの自動取得は将来ステップ

## 参考リンク

- maimai でらっくす 公式サイト: https://maimai.sega.jp/（あそびかた: https://maimai.sega.jp/play/other1/ ）
- 公式おしらせ（CiRCLE 稼働・RATING 調整）: https://info-maimai.sega.jp/7725/
- 公式おしらせ（CiRCLE PLUS 稼働・RATING 強化/色表）: https://info-maimai.sega.jp/8674/
- 楽曲マスタ JSON（公式配信・1571 曲・version は内部コード）: https://maimai.sega.jp/data/maimai_songs.json

## 決定事項

- 現行バージョン名: **CiRCLE PLUS**（2026-03-19 稼働。前バージョン: CiRCLE）→ 新曲枠判定に使用
- 定数 DB の形式: 最初は **JSON ファイル**（git 管理）で用意し、ビューア実装時に **SQLite / PostgreSQL へ移行**（ビューアの技術スタックが未定のため、移行先はその設計時に決定。JSON をシードとして投入）

## 現状

- [x] ドメイン整理（docs/domain.md）
- [x] 公式情報源の引用・楽曲マスタの取り扱い整理（docs/domain.md の『公式情報源（一次ソース）』『公式 楽曲マスタ JSON』の節）
- [ ] 計算コア（単曲レート → 枠選定 → RATING）
- [ ] スコア入力（NET の Lv 毎リストをコピペ → パース）
- [ ] 定数 DB（JSON で用意。公式マスタに定数は無い。DX 定数 970 曲分は別途収集が必要。docs/domain.md の『注意・データギャップ』参照）
- [ ] 出力（RATING / 内訳 / 色）
- [ ] 楽曲ビューア（ジャケット画像の事前ダウンロード。仕様メモ: docs/domain.md の『楽曲画像（image_url）の取得』）

## 調査完了（別ペイン委譲 2026-08-29）

- 公式マスタ JSON の `version` フィールドの意味を確定: 「ST 譜面セット（BASIC〜MASTER）の追加バージョン。ST を持たない曲は DX セットの追加バージョン」。Re:MASTER 追加・旧曲への DX 追加・レベル改訂では変化しない（9 事例の照合で確定）
- 新曲枠判定に必要な譜面単位の追加バージョンは、現行ウィンドウ（CiRCLE PLUS / CiRCLE）では追加調査ほぼ不要と判明（詳細は docs/domain.md の『version フィールドの意味（確定）』『注意・データギャップ』の節）
- 残るデータギャップは **DX 譜面の定数（970 曲分、公式マスタ外の収集が必要）**