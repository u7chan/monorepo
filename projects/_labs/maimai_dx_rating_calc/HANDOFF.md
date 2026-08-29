# HANDOFF — maimai でらっくす RATING 計算ツール（PoC 検証中）

> 引き継ぎ用メモ。ブランチ: `feat/maimai-dx-rating-poc`（origin/main 起点、**PR 未作成**）
> 最新コミット: `5f40c915`（全コミット push 済み）
> 作成: 2026-08-30 / 更新:

## 1. プロジェクトの現状

maimai でらっくす RATING 計算ツールの **Python3 PoC を実装・実データ検証中**。
技術スタックは本実装時未定（ADR-0002）。PoC は「動く仕様」であり、本実装は別スタックで再実装する前提。

- 仕様の正: `docs/domain.md`（公式ソース引用 + 調査結果）
- 開発手順・表記規則: `docs/conventions.md`（出典は公式のみ・「§」参照禁止・PR は勝手に作らない）
- 技術決定: `docs/adr/`（ADR-0001: 定数 DB は JSON 先行 → ビューア時に RDB 移行 / ADR-0002: 技術スタック未決定）
- ルート AGENTS.md に PR マージ方針（基本 squash）追記済み

## 2. コード構成（poc/）

| ファイル | 内容 |
| --- | --- |
| `rating_core.py` | 純関数: 単曲レート（整数演算・寸止め係数込み）/ 枠選定（新曲15+ベスト35・Re:M 例外）/ version 帯判定（フロア） |
| `net_parser.py` | NET コピペパーサ: LEVEL 一覧 + **バージョン別ページ**（ヘッダ=バージョン名検出）、統計ブロックスキップ、衝突検出 |
| `run.py` | マスタ + コピペ + 定数 → RATING + CSV 2 本。`--difficulty` / `--current-version` / `--master` / `--constants` オプション |
| `constants.json` | 検証用サンプル 12 譜面（手入力の**仮値**。実データ評価では使わない） |
| `test_rating.py` | unittest **42 件**（`python3 -m unittest poc/test_rating.py` で実行） |
| `example_paste.txt` | ダミーコピペ（統計ブロックはダミーラベル） |
| `README.md` | 使い方・仮定 10 項目・既知の制限（**一部古い: バージョン別ページ対応の追記がまだ**） |

実行例:
```bash
cd projects/_labs/maimai_dx_rating_calc
python3 poc/run.py data/pastes/level_list.txt <出力先> --constants data/maimai_constants.json
python3 poc/run.py data/pastes/version_master.txt <出力先> --constants data/maimai_constants.json --difficulty MASTER   # バージョン別ページ用
```

## 3. データファイル（data/ に集約・.gitignore 除外）

| ファイル | 内容 | 扱い |
| --- | --- | --- |
| `data/maimai_constants.json` | **譜面定数 DB 6364 譜面 / 1480 曲**（非公式データ収集、CiRCLE PLUS 時点、0.1 刻み・全難易度・表示Lv はマスタと 6364/6364 一致確認済み） | 内部利用のみ・**git 除外**。出典サイト名は文書に記載しない。DB 設計時に再整理 |
| `data/maimai_songs.json` | 公式楽曲マスタ 1571 曲（run.py が自動キャッシュ） | 公式データ・git 除外 |
| `data/pastes/level_list.txt` | **ユーザーの実スコア（LEVEL 一覧ページのコピペ）** | **個人情報。git 除外（ユーザー明示）** |
| `data/pastes/version_master.txt` | **ユーザーの実スコア（バージョン別・MASTER ページ）** | 同上 |

## 4. 実データ検証の結果（2026-08-30）

- **単一 LEVEL の一覧のみ**: RATING 10001（新曲枠 718 / ベスト枠 9283 / AP 0）。プレイ済み全曲のパース・定数照合に成功
- **CiRCLE PLUS / MASTER ページ + `--difficulty MASTER`**: RATING 4433（新曲枠 15 満杯 / ベスト枠 0 / AP 14）→ このページの曲は全員新曲枠候補で正しい
- **新発見（重要）**: 魔理沙は大変なものを盗んでいきました DX MASTER 13+ は、公式マスタの version=12002（GreeN 帯）だが **NET バージョン別ページでは CiRCLE PLUS 掲載** → マスタ version は「ST 譜面セット追加バージョン」であり **DX 譜面の後からの追加は拾えない実例**（domain.md 仮定 4 を反証）。**NET バージョン別ページが譜面単位の追加バージョンの正**。コードはページ version 優先で対応済み（`to_scored_chart`）
- 衝突 3 曲（難易度不明のため除外）: 火炎地獄 / ジングルベル / System "Z"（いずれも ST/DX が同一 LEVEL の MASTER 譜面）。ジングルベルは難易度別ページで解消可、残り 2 曲は ST/DX 判別が必要

## 5. NET の URL 仕様（実測）

- LEVEL 一覧: `https://maimaidx.jp/maimai-mobile/record/musicLevel/search/?level=19`（level = 内部 Lv インデックス。Lv13=19, Lv15=23。式: N + max(0, N−7)、+ はさらに +1）
- **バージョン別**: `https://maimaidx.jp/maimai-mobile/record/musicVersion/search/?version=26&diff=3`
  - `version` = 0 始まり連番（0=maimai 初代 … **26=CiRCLE PLUS**。27 バージョン分）
  - `diff` = 難易度（0=BASIC, 1=ADVANCED, 2=EXPERT, 3=MASTER 実測。4=Re:MASTER と推測）
  - コピペ形式は LEVEL 一覧と同一（ヘッダ行がバージョン名になるだけ）。**難易度はテキストに落ちない → CLI で `--difficulty` 指定**

## 6. ユーザー待ち・未着手

1. **12+ / 13 / 13+ のコピペ**（ユーザーが貼る予定）。到着したら `data/pastes/` に保存し、LEVEL/バージョンページを問わず一括計算
2. **ユーザーの RATING 実値**（NET 表示。較正の基準になる。まだ未入手）
3. **データの GitHub 不保持方針（決定）+ 取り込みツール（構想）**: マスタ・定数 DB は GitHub に持たない（`data/` を .gitignore 除外、既に移設済み）。再現性のため**取り込みコマンド（公式 URL 取得・定数収集の自動化）を検討中**（構想段階）。DB 設計（ADR-0001 の RDB 移行）時に整理する
   - （domain.md §4.4 参考: NET サブスクの「RATING 対象曲」表示は要検証で未確認）
4. **docs/domain.md 更新（未実施）**: §9 にバージョン別ページの仕様（URL・diff/version パラメータ・魔理沙ケース）を追記、§7.4 の仮定見直し、§10 未確定の更新
5. **poc/README.md 更新（一部実施済み）**: `--difficulty` の使い方・仮定 3/4 の修正・CSV の「追加バージョン」列は未反映（データ置き場の説明は反映済み）
6. 曲名重複（Link 2 曲・無題曲）の照合キー強化（id 導入）は本実装時
7. PR 作成・push 判断はユーザー指示待ち（現状: ブランチへの commit + push のみ）

## 7. 次にやること（引き継ぎ先向け）

1. ユーザーから 12+/13/13+ のコピペをもらい `data/pastes/` に保存
2. `python3 poc/run.py <統合コピペ> <出力先> --constants data/maimai_constants.json` で統合 RATING を出す
   - バージョン別ページのコピペが混ざる場合はセクションごとに分けて実行し、結果を統合するか、`--difficulty` を都度指定して別々に出力して比較
3. ユーザーの RATING 実値と突き合わせ（較正の第一歩。ズレの原因候補: 単曲切捨位置・寸止め係数・枠判定・衝突除外の影響）
4. domain.md / README の更新（上記 4・5）を実施し、コミット
5. 取り込みツールの構想を具体化（マスタ取得コマンド → 定数収集の自動化 → DB 設計時に整理）

## 8. 環境メモ

- Python 3.14.4（stdlib のみ使用、依存なし）
- Herdr: ペイン wE:p1Z（親）/ wE:p31（poc 実装済み・アイドル）/ wE:p32（定数調査済み・アイドル）
- ユーザーの個人スコアデータは絶対に Git に入れない（明示指示済み）

## 9. 後日検証チェックリスト

- [ ] 12+ / 13 / 13+ のコピペでの統合 RATING 計算と、NET 表示の RATING 実値との較正（ズレの原因候補: 単曲切捨位置・枠判定・衝突除外の影響）
- [ ] NET バージョン別ページの `diff=4` が Re:MASTER かどうかの確認（現状 0=BASIC / 3=MASTER のみ実測）
- [ ] NET サブスク（月額 330 円）の「RATING 対象曲」表示の実測確認 → 枠判定の正解データとして利用可否（domain.md『参考: NET サブスクリプションの「RATING 対象曲」表示（要検証）』参照）
- [ ] 統計ブロック 21 行の並びと意味を実データで確定（example_paste.txt はダミーラベルのまま。実コピペは数字のみで検証済み）
- [ ] 魔理沙ケース（DX 後追加）が現行ウィンドウ内に他にも無いか、バージョン別ページとマスタ version の突合で調査
- [ ] 定数 DB の取り込みツール構想の具体化（マスタ取得コマンド・定数収集の自動化。DB 設計時に整理）
- [ ] 衝突 3 曲（火炎地獄 / ジングルベル / System “Z”）の解消方針（楽曲詳細ページ対応 or 手動指定 UI）
- [ ] 曲名重複（Link 2 曲・無題曲）の照合キーへの id 導入（本実装時に）