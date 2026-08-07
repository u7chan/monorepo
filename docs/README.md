# ドキュメント

このディレクトリには、モノレポ全体に関わる開発・運用ガイドと、LLM API の動作確認用サンプルをまとめています。目的に合う文書を次の表から選んでください。

## 目的から探す

| 目的 | 文書 |
| --- | --- |
| `main` 向け PR の検証と、`main` へのマージ後の配布処理を理解する | [CI/CD の仕組みと運用](./about-cicd.md) |
| Dependabot の PR を確認する、対象プロジェクトを追加する | [Dependabot 運用ガイド](./dependabot-guide.md) |
| OSS ライセンスチェックをローカルで実行する、CI の失敗を調べる | [OSS ライセンスチェック](./license-check.md) |
| `projects/` 配下の配置先を判断する | [`projects/` の分類ルール](./projects-classification.md) |
| 自宅サーバーのパッケージを更新する | [自宅サーバーの保守手順](./server-maintenance-guide.md) |
| LLM API のリクエストを手元で試す | [LLM API の HTTP サンプル](./llm/README.md) |

## 文書を更新するときの参照先

設定や実装を変更した場合は、対応する文書も同じ PR で更新します。挙動を確認するときは、次のファイルを参照してください。

| 文書 | 挙動・設定の参照先 |
| --- | --- |
| CI/CD | `.github/workflows/`、`.github/actions/` |
| Dependabot | `.github/dependabot.yml` |
| OSS ライセンスチェック | `scripts/check_licenses.py`、`scripts/license-policy.json`、`.github/actions/get-license-check-targets/` |
| プロジェクト分類 | `projects/` のディレクトリ構成 |
| LLM API サンプル | `docs/llm/*.http` |
