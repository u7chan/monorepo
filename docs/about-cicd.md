# CICDについて

## 概要

GitHub Actionsを使用したCI/CDパイプラインで、以下の処理を自動化します:

- mainブランチへのpush時: Dockerイメージをビルドし、GitHub Container Registry(GHCR)にプッシュ
- pull request時: 変更プロジェクトを検出し、testステージでDockerイメージをビルド

## トリガー条件

- mainブランチへのpush時
- mainブランチへのpull request時

## ワークフロー (docker-build.yml)

1. コードのチェックアウト
2. 変更ディレクトリの検出 (get-changed-directories)
3. Dockerfileがある変更プロジェクトの特定 (get-changed-projects)
4. Dockerイメージのビルド (build-docker-images)
5. GHCRへのログイン
6. Dockerイメージのプッシュ

## ワークフロー (pullrequest-check.yml)

1. コードのチェックアウト (fetch-depth: 2)
2. 変更ディレクトリの検出 (get-changed-directories)
3. Dockerfileがある変更プロジェクトの特定 (get-changed-projects)
4. Dockerイメージのビルド (build-docker-images) - testステージ指定
5. Dockerイメージの表示

## カスタムアクション詳細

### get-changed-directories

- 最新コミットと1つ前のコミットの差分を取得
- projects配下の変更ディレクトリを抽出
- 重複排除してchanged_dirs.txtに出力

### get-changed-projects

- changed_dirs.txtからディレクトリを読み込み
- 各ディレクトリにDockerfileが存在するか確認
- DockerfileがあるプロジェクトをBUILD_PROJECT環境変数に設定

### build-docker-images

- BUILD_PROJECT環境変数からビルド対象プロジェクトを取得
- 各プロジェクトのDockerfileをビルド
  - ステージ指定(--target)がある場合は使用
- イメージはGHCRにlatestタグでビルド
