# Build Docker Images Action

このアクションは、Dockerfileを持つプロジェクトのDockerイメージをビルドします。

## 概要

- `build_projects.txt` ファイルから対象プロジェクトを読み取り
- 各プロジェクトのDockerイメージをビルド
- マルチステージビルドに対応（ステージ指定可能）
- プレビルドスクリプトの自動実行
- GitHub Container Registry (GHCR) 形式のタグ付け

## 入力パラメータ

| パラメータ | 説明 | 必須 | デフォルト値 |
|-----------|------|------|-------------|
| `stage` | Dockerビルドの対象ステージ（`--target` オプション） | Yes | - |

## 使用例

### GitHub Actions ワークフロー内での使用

```yaml
- name: Build Docker Images
  uses: ./.github/actions/build-docker-images
  with:
    stage: production
```

### 開発環境用ビルド

```yaml
- name: Build Docker Images (Development)
  uses: ./.github/actions/build-docker-images
  with:
    stage: development
```

### 他のアクションとの連携

```yaml
- name: Get Changed Directories
  uses: ./.github/actions/get-changed-directories

- name: Get Changed Projects
  uses: ./.github/actions/get-changed-projects

- name: Build Docker Images
  uses: ./.github/actions/build-docker-images
  with:
    stage: production

- name: Push Docker Images
  uses: ./.github/actions/push-docker-images
  with:
    username: ${{ github.actor }}
    password: ${{ secrets.PRIVATE_REPO_TOKEN }}
```

## 前提条件

1. `build_projects.txt` ファイルが存在すること
   - このファイルは `get-changed-projects` アクションで生成されます
2. 各プロジェクトに `Dockerfile` が存在すること
3. `GITHUB_REPOSITORY` 環境変数が設定されていること（GitHub Actions環境では自動設定）

## ローカルテスト

### 基本的なテスト

```bash
cd .github/actions/build-docker-images
./test-local.sh
```

このテストスクリプトは以下の処理を実行します：

1. テスト用の `build_projects.txt` を作成（`packages/chatbot-ui` を含む）
2. `GITHUB_REPOSITORY` 環境変数をモック設定
3. `production` ステージでビルドを実行

### 手動テスト

```bash
cd .github/actions/build-docker-images

# 1. テスト用のbuild_projects.txtを作成
echo -e "packages/chatbot-ui\nprojects/portfolio" > build_projects.txt

# 2. GitHub環境変数をモック
export GITHUB_REPOSITORY="your-username/your-repo"

# 3. スクリプトを実行
./build-docker-images.sh "production"

# 4. クリーンアップ
rm build_projects.txt
```

### 異なるステージでのテスト

```bash
# 開発ステージでビルド
./build-docker-images.sh "development"

# テストステージでビルド
./build-docker-images.sh "test"

# ステージ指定なしでビルド（Dockerfileにステージが存在しない場合）
./build-docker-images.sh "nonexistent-stage"
```

## ファイル構成

```
.github/actions/build-docker-images/
├── action.yml               # アクション定義
├── build-docker-images.sh   # メインスクリプト
├── test-local.sh           # ローカルテスト用スクリプト
└── README.md               # このファイル
```

## 動作仕様

### ビルドプロセス

1. **入力検証**
   - `stage` パラメータの存在確認
   - `build_projects.txt` ファイルの存在確認

2. **プロジェクト情報の取得**
   - 現在のコミットハッシュを取得（`git rev-parse --short HEAD`）
   - `build_projects.txt` からプロジェクトリストを読み取り

3. **各プロジェクトの処理**
   - プロジェクト名の抽出（パスの最後の部分）
   - GHCR URI の構築：`ghcr.io/$GITHUB_REPOSITORY/$project_name:latest`
   - Dockerfileの存在確認

4. **プレビルドスクリプトの実行**
   - プロジェクトディレクトリに `pre-docker-build.sh` が存在する場合は実行
   - スクリプトに実行権限を付与して実行

5. **Dockerビルド**
   - 指定されたステージがDockerfile内に存在するかチェック
   - ステージが存在する場合：`--target` オプション付きでビルド
   - ステージが存在しない場合：通常のビルド

### ステージ検出

スクリプトは以下のパターンでDockerfile内のステージを検索します：

```dockerfile
# 検索パターン: "AS {stage}"
FROM node:18 AS development
FROM node:18 AS production
```

### イメージタグ形式

ビルドされるイメージは以下の形式でタグ付けされます：

```
ghcr.io/{GITHUB_REPOSITORY}/{project_name}:latest
```

例：

- リポジトリ：`username/monorepo`
- プロジェクト：`projects/portfolio`
- タグ：`ghcr.io/username/monorepo/portfolio:latest`

### ビルド引数

すべてのビルドで以下のビルド引数が自動的に設定されます：

- `COMMIT_HASH`: 現在のコミットハッシュ（短縮形）

## プレビルドスクリプト

### 概要

各プロジェクトディレクトリに `pre-docker-build.sh` スクリプトが存在する場合、Dockerビルドの前に自動実行されます。

### 使用例

```bash
#!/bin/bash
# projects/my-project/pre-docker-build.sh

# 依存関係のインストール
npm install

# ビルド成果物の生成
npm run build

# 設定ファイルの生成
echo "COMMIT_HASH=${COMMIT_HASH}" > .env.production
```

### 注意事項

- スクリプトはプロジェクトディレクトリ内で実行されます
- 実行権限は自動的に付与されます
- スクリプトが失敗した場合、ビルドプロセスは停止します

## プロジェクト形式のサポート

### カンマ区切り形式

```
projects/portfolio,packages/chatbot-ui,projects/api
```

### 改行区切り形式

```
projects/portfolio
packages/chatbot-ui
projects/api
```

両方の形式に対応しており、自動的に検出されます。

## エラーハンドリング

- `stage` パラメータが未指定の場合はエラーで終了
- `build_projects.txt` が存在しない場合はエラーで終了
- `build_projects.txt` が空の場合は正常終了（ビルド対象なし）
- Dockerfileが存在しないプロジェクトは警告を出力してスキップ
- Dockerビルドが失敗した場合はスクリプトが終了

## 注意事項

- このアクションは `get-changed-projects` アクションの後に実行してください
- ビルドされたイメージは後続の `push-docker-images` アクションで使用されます
- ローカルテストではDockerデーモンが実行されている必要があります
- マルチステージビルドを使用する場合は、Dockerfile内でステージ名を適切に定義してください
- プレビルドスクリプトは必要に応じて各プロジェクトに配置してください
