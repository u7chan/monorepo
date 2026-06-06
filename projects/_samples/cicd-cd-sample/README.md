# cicd-cd-sample

CI/CDメンテナンス用のCDサンプルプロジェクトです。

## 概要

mainブランチへのマージ時にCDワークフローが発火してDockerイメージをビルド・プッシュするためのサンプルです。
通常のマルチステージビルド（builder → final）を行います。

## Dockerfile構成

| Stage | 用途 |
|-------|------|
| base | ベースイメージ |
| builder | ビルド処理 |
| final | 実行用イメージ（CDでビルド・プッシュ） |

## ローカルでのビルド

```bash
docker build -t cicd-cd-sample:latest .
```
