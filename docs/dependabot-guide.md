# Dependabot 運用ガイド

## 概要

このリポジトリでは、Dependabot の version updates を使って一部プロジェクトの依存更新 PR を自動作成します。

設定ファイルは [`.github/dependabot.yml`](../.github/dependabot.yml) にあります。

対象プロジェクトの一覧はドキュメントに重複記載せず、常に [`.github/dependabot.yml`](../.github/dependabot.yml) を正として確認します。

## GitHub 側の前提

- 基本的には `.github/dependabot.yml` を既定ブランチに入れるだけで動作する
- `Dependency Graph` が有効であることを確認する
- private registry を使う場合だけ `registries` 設定を追加する

通常の public registry のみを使う構成であれば、追加の GitHub 設定はほぼ不要です。

## 日常運用

1. Dependabot PR が作成されたら CI の結果を確認する
1. 必要に応じて対象プロジェクトだけローカルで動作確認する
1. 問題がなければ通常の PR と同様にマージする
1. 問題がある更新は PR を閉じるか、`ignore` を追加して再発を防ぐ

## 対象プロジェクトを追加する手順

追加したいプロジェクトが Dependabot 対応のマニフェストを持っていることを確認し、`.github/dependabot.yml` の `directories` にパスを追加します。

### Bun プロジェクトを追加する場合

必要なファイル:

- `package.json`
- `bun.lock`

設定例:

```yaml
- package-ecosystem: "bun"
  directories:
    - "/projects/example-a"
    - "/projects/your-bun-project"
  schedule:
    interval: "weekly"
```

### uv プロジェクトを追加する場合

必要なファイル:

- `pyproject.toml`
- `uv.lock`

設定例:

```yaml
- package-ecosystem: "uv"
  directories:
    - "/projects/example-python-service"
    - "/projects/your-uv-project"
  schedule:
    interval: "weekly"
```

## よくある調整

### 更新頻度を変える

`schedule.interval` を変更します。

- `daily`
- `weekly`
- `monthly`

### 特定パッケージを無視する

`ignore` を追加します。

```yaml
ignore:
  - dependency-name: "example-package"
```

### PR にラベルを付ける

`labels` を追加します。

```yaml
labels:
  - "dependencies"
```

## 注意点

- `bun` と `uv` は別の `updates` ブロックに分ける
- 対象外プロジェクトは `directories` に追加しない限り更新されない
- 変更後は GitHub 上で Dependabot 設定エラーが出ていないことを確認する
