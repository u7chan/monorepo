# projects/

このディレクトリは、継続開発するプロジェクト、実験、サンプルを置く場所です。

## 分類

| Path | 用途 | 判断基準 |
| --- | --- | --- |
| `projects/<name>` | 継続保守するアプリ/ライブラリ | deploy 対象、または今後も通常の開発対象として扱うもの |
| `projects/_labs/<name>` | 実験・検証・試作 | まだ育てる可能性があるもの、再利用する可能性があるもの |
| `projects/_samples/<name>` | サンプル・教材・テンプレート | 真似るための最小構成、公式サンプル改造、CI/CD 検証用プロジェクト |

## 判断順

1. 継続保守または deploy 対象なら `projects/<name>`
2. 実験・検証・試作なら `projects/_labs/<name>`
3. 教材、テンプレート、公式サンプル改造、CI/CD 検証なら `projects/_samples/<name>`
