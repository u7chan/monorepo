# Push Docker Images Action

このアクションは、ビルドされたDockerイメージをコンテナレジストリにプッシュします。

## 概要

- `build_projects.txt` ファイルから対象プロジェクトを読み取り
- 各プロジェクトのDockerイメージをレジストリにプッシュ
- GitHub Container Registry (GHCR) をデフォルトでサポート
- ローカルテストにも対応

## 入力パラメータ

| パラメータ | 説明 | 必須 | デフォルト値 |
|-----------|------|------|-------------|
| `registry` | コンテナレジストリのURL | No | `ghcr.io` |
| `username` | レジストリのユーザー名 | Yes | - |
| `password` | レジストリのパスワード | Yes | - |

## 使用例

### GitHub Actions ワークフロー内での使用

```yaml
- name: Push Docker Images
  uses: ./.github/actions/push-docker-images
  with:
    username: ${{ github.actor }}
    password: ${{ secrets.PRIVATE_REPO_TOKEN }}
```

### カスタムレジストリを使用する場合

```yaml
- name: Push Docker Images
  uses: ./.github/actions/push-docker-images
  with:
    registry: "my-registry.com"
    username: ${{ secrets.REGISTRY_USERNAME }}
    password: ${{ secrets.REGISTRY_PASSWORD }}
```

## 前提条件

1. `build_projects.txt` ファイルが存在すること
   - このファイルは `get-changed-projects` アクションで生成されます
2. 対象プロジェクトのDockerイメージがローカルにビルド済みであること
   - `build-docker-images` アクションで事前にビルドしてください

## ローカルテスト

### 基本テスト

```bash
cd .github/actions/push-docker-images
./test-local.sh
```

### 完全なテスト（ローカルレジストリ使用）

```bash
# 1. ローカルレジストリを起動
docker run -d -p 5000:5000 --name registry registry:2

# 2. テストを実行
cd .github/actions/push-docker-images
./test-local.sh

# 3. クリーンアップ
docker stop registry && docker rm registry
```

### 手動テスト

```bash
# テスト用のbuild_projects.txtを作成
echo "projects/portfolio" > build_projects.txt

# スクリプトを直接実行
./push-docker-images.sh "localhost:5000" "testuser" "testpass"
```

## ファイル構成

```
.github/actions/push-docker-images/
├── action.yml              # アクション定義
├── push-docker-images.sh   # メインスクリプト
├── test-local.sh           # ローカルテスト用スクリプト
└── README.md               # このファイル
```

## 動作仕様

1. 入力パラメータの検証
2. `build_projects.txt` ファイルの存在確認
3. レジストリへのログイン
4. 各プロジェクトに対して：
   - プロジェクト名の抽出
   - イメージURIの構築
   - ローカルイメージの存在確認
   - イメージのプッシュ

## エラーハンドリング

- 必須パラメータが不足している場合はエラーで終了
- `build_projects.txt` が存在しない場合はエラーで終了
- ローカルにイメージが存在しない場合は警告を出力してスキップ
- レジストリへのログインに失敗した場合はエラーで終了

## 注意事項

- このアクションは `get-changed-projects` と `build-docker-images` アクションの後に実行してください
- GitHub Container Registry を使用する場合は、適切な権限を持つトークンが必要です
- ローカルテストでは実際のレジストリへのプッシュは行われません（テスト用レジストリを除く）
