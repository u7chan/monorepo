# Remove Old Docker Images Action

このアクションは、古いDockerイメージを削除し、プロジェクトごとに最新のN個のイメージのみを保持します。

## 概要

- `build_projects.txt` ファイルから対象プロジェクトを読み取り
- 各プロジェクトの古いDockerイメージを削除
- 指定した数だけ最新のイメージを保持（デフォルト: 3個）
- モックモードでのテスト実行をサポート
- GitHub Container Registry (GHCR) に対応

## 入力パラメータ

| パラメータ | 説明 | 必須 | デフォルト値 |
|-----------|------|------|-------------|
| `keep_count` | プロジェクトごとに保持する最新イメージ数 | No | `3` |

## 使用例

### GitHub Actions ワークフロー内での使用

```yaml
- name: Remove Old Docker Images
  uses: ./.github/actions/remove-old-docker-images
  with:
    keep_count: 3
```

### より多くのイメージを保持する場合

```yaml
- name: Remove Old Docker Images
  uses: ./.github/actions/remove-old-docker-images
  with:
    keep_count: 5
```

## 前提条件

- カレントディレクトリに `build_projects.txt` ファイルが存在すること
- Dockerがインストールされ、利用可能であること
- イメージにタグが付けられていること（`<none>` 以外）

## 動作仕様

1. `build_projects.txt` からプロジェクト名を読み込み
2. 各プロジェクトについて、プロジェクト名を含むDockerイメージを一覧取得
3. 作成日時でソート（新しい順）
4. 保持数を超えるイメージを削除
5. `MOCK_DOCKER_COMMANDS=true` 環境変数でモックモードをサポート

## 使用例（具体的なケース）

`my-app` というプロジェクトに以下のイメージがある場合：

- `my-app:v1.0.0` (最古)
- `my-app:v2.0.0`
- `my-app:v3.0.0`
- `my-app:latest` (最新)

`keep_count: 3` の設定では、`my-app:v1.0.0` のみが削除されます。

## モックモード

実際にイメージを削除せず、削除対象をシミュレーションする場合：

```bash
export MOCK_DOCKER_COMMANDS=true
./remove-old-docker-images.sh 3
```

## ローカルテスト

```bash
cd .github/actions/remove-old-docker-images
./test-local.sh
```
