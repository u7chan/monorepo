# Get Changed Directories Action

このアクションは、最新のコミットで変更されたディレクトリの一覧を取得します。

## 概要

- Gitの差分を使用して変更されたファイルを検出
- ファイルのリネーム（移動）を適切に処理
- 対象ディレクトリ（`projects/`、`packages/`）配下の変更のみを抽出
- 重複を除去してユニークなディレクトリリストを生成

## 入力パラメータ

このアクションは入力パラメータを必要としません。

## 出力

| 出力 | 説明 |
|------|------|
| `changed_dirs.txt` | 変更されたディレクトリのリスト（ファイル出力） |

## 使用例

### GitHub Actions ワークフロー内での使用

```yaml
- name: Get Changed Directories
  uses: ./.github/actions/get-changed-directories

- name: Use the result
  run: |
    echo "Changed directories:"
    cat changed_dirs.txt
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

1. Gitリポジトリ内で実行されること
2. 比較対象となるコミットが存在すること

## ローカルテスト

### 基本的なテスト

```bash
cd .github/actions/get-changed-directories
./test-local.sh
```

### 手動テスト

```bash
cd .github/actions/get-changed-directories

# スクリプトを直接実行
./get-changed-dirs.sh

# 結果を確認
echo "Changed directories:"
cat changed_dirs.txt

# クリーンアップ
rm changed_dirs.txt
```

### 特定のコミット範囲でのテスト

```bash
# 環境変数を設定してプルリクエストをシミュレート
export GITHUB_BASE_REF="main"
./get-changed-dirs.sh

# または、スクリプトを直接編集して異なるベースリファレンスを指定
```

## ファイル構成

```
.github/actions/get-changed-directories/
├── action.yml            # アクション定義
├── get-changed-dirs.sh   # メインスクリプト
├── test-local.sh        # ローカルテスト用スクリプト
└── README.md            # このファイル
```

## 動作仕様

### 比較対象の決定

1. **プルリクエストの場合** (`GITHUB_BASE_REF` が設定されている場合)
   - ベースブランチ（例：`main`）との比較
   - 比較対象：`refs/remotes/origin/$GITHUB_BASE_REF`

2. **プッシュイベントの場合** (`GITHUB_BASE_REF` が未設定の場合)
   - 前のコミットとの比較
   - 比較対象：`HEAD~1`

### ファイル変更の検出

1. **リネーム処理**
   - `git diff --diff-filter=R` でリネームされたファイルの移動後パスを取得
   - 通常の差分からリネームされたファイルを除外

2. **対象ディレクトリのフィルタリング**
   - `projects/` および `packages/` ディレクトリ配下のファイルのみを対象
   - ディレクトリレベル（例：`projects/portfolio`）で抽出

3. **重複除去**
   - `sort -u` で重複するディレクトリを除去

## 対象ディレクトリ

現在、以下のディレクトリ配下の変更を検出対象としています：

- `projects/` - 各種プロジェクト
- `packages/` - 共有パッケージ

### 対象ディレクトリの変更

スクリプト内の `TARGET_DIRS` 配列を編集することで対象ディレクトリを変更できます：

```bash
# get-changed-dirs.sh 内
TARGET_DIRS=("projects", "packages", "新しいディレクトリ")
```

## リネーム処理の詳細

### `diff_with_renames` 関数

この関数は、ファイルのリネーム（移動）を適切に処理します：

1. **リネームされたファイル**
   - `git diff --diff-filter=R --name-status` でリネーム情報を取得
   - 移動後のパス（新しいパス）を使用

2. **その他の変更**
   - 通常の `git diff --name-only` から、リネームされたファイルを除外
   - 追加、削除、修正されたファイルを取得

### 処理例

```
# ファイルの移動: projects/old-name → projects/new-name
# 結果: projects/new-name が変更対象として検出される

# 通常の変更: projects/portfolio/src/main.ts
# 結果: projects/portfolio が変更対象として検出される
```

## エラーハンドリング

- Gitコマンドが失敗した場合はスクリプトが終了
- 対象ディレクトリ配下に変更がない場合は空のファイルが生成される
- 無効なGitリファレンスが指定された場合はGitがエラーを出力

## 注意事項

- このアクションは他のアクション（`get-changed-projects`、`build-docker-images`）の前提条件となります
- ローカルテストでは実際のGitの差分を使用するため、作業ディレクトリの状態に依存します
- プルリクエストのテストでは、ベースブランチが最新の状態である必要があります
