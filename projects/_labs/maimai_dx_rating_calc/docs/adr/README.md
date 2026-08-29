# ADR（技術決定の記録）

技術スタック・アーキテクチャに関する決定を記録する。将来の AI 駆動開発・設計時に「なぜこの決定になったか」を追跡できるようにするためのシリーズ。

## 運用ルール

- 技術スタック・アーキテクチャに関わる決定は、このディレクトリに **ADR（Architecture Decision Record）** として記録する
- ファイル名: `NNNN-題名.md`（連番 0001 から。題名は kebab-case の英語）
- 本文は日本語。テンプレート: [template.md](template.md)
- ステータス遷移:
  - `Proposed`（提案中）→ `Accepted`（採用）→ `Superseded`（破棄・置換）
  - 決定が覆った場合は、元の ADR を `Superseded` にして**新しい ADR を立てる**（元の ADR は書き換えない）
- 1 つの ADR に 1 つの決定。仕様の事実（RATING の計算式等）は ADR に書かず、docs/domain.md に書く

## ADR 一覧

| 番号 | 題名 | ステータス | 日付 |
| --- | --- | --- | --- |
| [0001](0001-constant-db-format.md) | 定数 DB は JSON で開始し、ビューア実装時に RDB へ移行 | Accepted | 2026-08-29 |
| [0002](0002-tech-stack-undecided.md) | 技術スタックはビューア設計時に決定（現時点では未決定） | Accepted | 2026-08-29 |