# maimai_dx_rating_calc（仮）

自分の maimai でらっくす RATING を計算する自作ツール。

- 計算仕様: [docs/domain.md](docs/domain.md)（公式情報源の引用・楽曲マスタ JSON の扱いを含む）
- 実装（PoC・Python3）: [poc/README.md](poc/README.md)
- 文書作成ルール: [docs/conventions.md](docs/conventions.md)
- 引き継ぎメモ（作業履歴・残課題・NET URL 仕様）: [HANDOFF.md](HANDOFF.md)

## スコア入力

[maimai でらっくすNET](https://maimaidx.jp/) からスコアを取得し、次の 3 方式のいずれかでツールに渡す
（手順の詳細は [poc/README.md](poc/README.md)『NET からの入力データの作り方』・
[docs/domain.md](docs/domain.md)『スコア入力フォーマット』）。

1. **コピペテキスト**: ログイン →「レコード」→「楽曲スコア」→「LEVEL」で Lv 毎一覧を開き、
   Ctrl+A / Ctrl+C したテキストをそのまま渡す（譜面難易度・ST/DX は含まれない）
2. **ページ保存 HTML**: 同じ一覧画面を Ctrl+S で保存した HTML を渡す（譜面難易度・ST/DX も確定できる）
3. **ブックマークレット JSON**: [tools/bookmarklet.html](tools/bookmarklet.html) のブックマークレットで
   一覧から JSON をダウンロードして渡す（方式 2 と同じ情報 + 楽曲詳細ページ用トークン）

認証つきの自動取得（Playwright 等）は将来ステップ。

## 参考リンク

- maimai でらっくす 公式サイト: https://maimai.sega.jp/（あそびかた: https://maimai.sega.jp/play/other1/ ）
- 公式おしらせ（CiRCLE 稼働・RATING 調整）: https://info-maimai.sega.jp/7725/
- 公式おしらせ（CiRCLE PLUS 稼働・RATING 強化/色表）: https://info-maimai.sega.jp/8674/
- 楽曲マスタ JSON（公式配信・1571 曲・version は内部コード）: https://maimai.sega.jp/data/maimai_songs.json

## 決定事項

- 現行バージョン名: **CiRCLE PLUS**（2026-03-19 稼働。前バージョン: CiRCLE）→ 新曲枠判定に使用
- 定数 DB の形式: **JSON ファイルで開始済み**。実データは `data/` に置き **git 除外**
  （第三者サイト等から収集したデータで出典サイト名を記載しない規則のため git 管理しない。ADR-0001 の追記参照）。
  ビューア実装時に **SQLite / PostgreSQL へ移行**し、JSON をシードとして投入する
  （移行先はビューアの技術スタックが未定のため、その設計時に決定）
- 技術スタック: **未決定**（ADR-0002。docs/domain.md のデータモデルは TypeScript 表記の例示であり、実装言語を約束するものではない）

## 現状（2026-08-31）

- [x] ドメイン整理・公式情報源の引用・楽曲マスタの取り扱い整理（docs/domain.md）
- [x] **PoC 実装・実データ較正済み**（poc/）: 計算コア（単曲レート → 枠選定 → RATING）+ スコア入力 3 方式 + CSV 出力。
  計算値は実 RATING と完全一致、新曲枠の判定も NET のバージョン別ページ掲載と全曲一致（詳細は HANDOFF.md『実データ検証の結果』）
- [x] 定数 DB の収集: `data/maimai_constants.json`（CiRCLE PLUS 時点・6364 譜面 / 1479 曲名）。
  **収集過程に再現性はない**（下記『定数 DB の再現性について』）
- [ ] 楽曲ビューア: デザイン仕様 [docs/gui-design-spec.md](docs/gui-design-spec.md) + モック
  [docs/mockup/rating_viewer.html](docs/mockup/rating_viewer.html) まで。実装未着手・技術スタック未決定
- [ ] RATING 分析のスキル化: アイデア段階（[docs/skill-braindump.md](docs/skill-braindump.md)）

### 定数 DB の再現性について

- 譜面定数は公式マスタに含まれないため、DX 譜面 970 曲分などは**第三者サイト等を参照した手作業収集**で用意した
  （壁打ちで検証しながら収集。出典サイト名は [docs/conventions.md](docs/conventions.md)『出典』の規則により記載しない）
- 収集結果は `data/maimai_constants.json`（**git 除外**・内部利用のみ）に保存済み。
  **収集手順の再現性はなく、再取得・更新は手作業になる**
- 再現性の確保（公式マスタ取得 + 定数収集の自動化 = 取り込みツール）は構想段階。
  DB 設計（ADR-0001 の RDB 移行）時に整理する予定。詳細は HANDOFF.md『次にやること』
- 実データ（スコア・マスタ・定数）は全て `data/` 配下・git 除外（docs/conventions.md『プライバシー』参照）