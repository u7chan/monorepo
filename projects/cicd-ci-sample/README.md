# cicd-ci-sample

CI/CDメンテナンス用のCIサンプルプロジェクトです。

## 概要

PR時にCIワークフローが発火してビルド検証を行うためのサンプルです。
testステージを持つDockerfileで、CI時に `--target=test` を指定してビルドします。

## Dockerfile構成

| Stage | 用途 |
|-------|------|
| base | ベースイメージ |
| test | CI検証用（PR時にビルド） |
| final | 本番用（省略可能） |

## ローカルでのテストビルド

```bash
docker build -t cicd-ci-sample:test --target=test --progress plain .
```
