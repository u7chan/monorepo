# Get Changed Projects Action

このアクションは、変更されたディレクトリの中からDockerfileを持つプロジェクトを特定します。

## 概要

- `changed_dirs.txt` ファイルから変更されたディレクトリを読み取り
- 各ディレクトリにDockerfileが存在するかチェック
- Dockerfileを持つプロジェクトのリストを生成
- GitHub Actions環境変数とローカルファイルの両方に出力

## 入力パラメータ

このアクションは入力パラメータを必要としません。

## 出力

| 出力 | 説明 |
|------|------|
| `BUILD_PROJECT` | Dockerfileを持つプロジェクトのカンマ区切りリスト（GitHub Actions環境変数） |
| `build_projects.txt` | Dockerfileを持つプロジェクトのリスト（ファイル出力） |

## 使用例

### GitHub Actions ワークフロー内での使用

```yaml
- name: Get Changed Projects
  uses: ./.github/actions/get-changed-projects

- name: Use the result
  run: |
    echo "Changed projects: ${{ env.BUILD_PROJECT }}"
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
```

## 前提条件

1. `changed_dirs.txt` ファイルが存在すること
   - このファイルは `get-changed-directories` アクションで生成されます
2. Gitリポジトリ内で実行されること

## ローカルテスト

### 基本的なテスト

```bash
cd .github/actions/get-changed-projects
./test-local.sh
```

このテストスクリプトは以下の処理を実行します：

1. `get-changed-directories` アクションを実行して `changed_dirs.txt` を生成
2. `get-changed-projects` アクションを実行してDockerfileを持つプロジェクトを特定

### 手動テスト

```bash
cd .github/actions/get-changed-projects

# 1. 前提条件として changed_dirs.txt を作成
echo -e "packages/chatbot-ui\nprojects/portfolio\nprojects/example-without-dockerfile" > changed_dirs.txt

# 2. スクリプトを実行
./get-changed-projects.sh

# 3. 結果を確認
echo "BUILD_PROJECT: $(cat build_projects.txt)"

# 4. クリーンアップ
rm changed_dirs.txt build_projects.txt
```

## ファイル構成

```
.github/actions/get-changed-projects/
├── action.yml                # アクション定義
├── get-changed-projects.sh   # メインスクリプト
├── test-local.sh            # ローカルテスト用スクリプト
└── README.md                # このファイル
```

## 動作仕様

1. `changed_dirs.txt` ファイルの存在確認
2. ファイルから各ディレクトリパスを読み取り
3. 各ディレクトリに `Dockerfile` が存在するかチェック
4. Dockerfileが存在するプロジェクトをカンマ区切りで結合
5. GitHub Actions環境の場合は `$GITHUB_ENV` に `BUILD_PROJECT` として設定
6. ローカルテスト用に `build_projects.txt` ファイルに出力

## 対象ディレクトリ

このアクションは `get-changed-directories` アクションで検出された以下のディレクトリ配下の変更を対象とします：

- `projects/` - 各種プロジェクト
- `packages/` - 共有パッケージ

## エラーハンドリング

- `changed_dirs.txt` が存在しない場合はエラーで終了
- Dockerfileが存在しないディレクトリは警告を出力してスキップ
- 空行は自動的にスキップ

## 注意事項

- このアクションは `get-changed-directories` アクションの後に実行してください
- 生成される `build_projects.txt` は後続の `build-docker-images` アクションで使用されます
- ローカルテストでは実際のGitの差分を使用して変更検出を行います
