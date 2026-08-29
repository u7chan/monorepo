# maimai_dx_rating_calc

maimai でらっくす RATING 計算ツールのワークスペース。

## ドキュメント索引

| ドキュメント | 内容 |
| --- | --- |
| [README.md](README.md) | プロジェクト概要・現状・決定事項・調査履歴 |
| [docs/domain.md](docs/domain.md) | RATING 計算のドメイン仕様（公式情報源・枠・係数・楽曲マスタ JSON・スコア入力形式） |
| [docs/adr/](docs/adr/README.md) | 技術決定の記録（ADR: テンプレート・採番・ステータス・一覧） |
| [docs/conventions.md](docs/conventions.md) | 文書作成ルール（§使用禁止・出典方針・プライバシー・用語・作業フロー） |

- 作業前に [docs/conventions.md](docs/conventions.md) を読むこと
- **ユーザーの実スコア・プレイ傾向は Git 管理しない**（実データは `data/` に置き .gitignore で除外済み。詳細は conventions の『プライバシー』参照）
- 共通ルール（ブランチ命名・コミット・PR）はリポジトリルートの AGENTS.md に従う

## ADR 一覧（技術決定）

| 番号 | 題名 | ステータス |
| --- | --- | --- |
| [0001](docs/adr/0001-constant-db-format.md) | 定数 DB は JSON で開始し、ビューア実装時に RDB へ移行 | Accepted |
| [0002](docs/adr/0002-tech-stack-undecided.md) | 技術スタックはビューア設計時に決定（現時点では未決定） | Accepted |

（運用ルール・テンプレートは [docs/adr/](docs/adr/README.md) 参照。決定が変わったら一覧も更新する）