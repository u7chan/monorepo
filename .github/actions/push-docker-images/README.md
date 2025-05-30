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

### モックモードテスト（推奨）

実際のDockerコマンドを実行せずに、すべてシミュレーションで動作確認できます。

```bash
cd .github/actions/push-docker-images
./test-local.sh
```

### 実際のDockerコマンドでのテスト

#### 方法1: 環境変数でモックを無効化

```bash
cd .github/actions/push-docker-images

# テスト用のbuild_projects.txtを作成
echo -e "projects/example1\nprojects/example2" > build_projects.txt

# モックモードを無効にして実行
MOCK_DOCKER_COMMANDS=false ./push-docker-images.sh "localhost:5000" "testuser" "testpass"

# クリーンアップ
rm build_projects.txt
```

#### 方法2: test-local.shを環境変数で制御

```bash
cd .github/actions/push-docker-images

# モックモードを無効にしてtest-local.shを実行
MOCK_DOCKER_COMMANDS=false ./test-local.sh
```

### 完全なテスト（ローカルレジストリ使用）

実際のレジストリにプッシュをテストする場合：

```bash
# 1. ローカルレジストリを起動
docker run -d -p 5000:5000 --name registry registry:2

# 2. テスト用のDockerイメージを作成
docker pull hello-world
docker tag hello-world localhost:5000/test/monorepo/portfolio:latest

# 3. モックを無効にしてテスト実行
cd .github/actions/push-docker-images
echo "projects/portfolio" > build_projects.txt
MOCK_DOCKER_COMMANDS=false ./push-docker-images.sh "localhost:5000" "testuser" "testpass"

# 4. クリーンアップ
rm build_projects.txt
docker stop registry && docker rm registry
docker rmi localhost:5000/test/monorepo/portfolio:latest
```

## ファイル構成

```
.github/actions/push-docker-images/
├── action.yml              # アクション定義
├── push-docker-images.sh   # メインスクリプト
├── test-local.sh           # ローカルテスト用スクリプト
└── README.md               # このファイル
```

## モックモード

環境変数 `MOCK_DOCKER_COMMANDS=true` を設定することで、実際のDockerコマンドを実行せずにシミュレーションモードで動作します。

### モックモードの特徴

- 実際のDockerデーモンが不要
- レジストリへの接続が不要
- すべてのDockerコマンドが `[MOCK]` プレフィックス付きで表示
- スクリプトのロジックを安全にテスト可能
- `test-local.sh` では自動的に有効化

### 使用方法

```bash
# モックモードで実行
MOCK_DOCKER_COMMANDS=true ./push-docker-images.sh "registry" "user" "pass"

# 通常モードで実行（デフォルト）
MOCK_DOCKER_COMMANDS=false ./push-docker-images.sh "registry" "user" "pass"
# または
./push-docker-images.sh "registry" "user" "pass"
```

## 動作仕様

1. 入力パラメータの検証
2. モックモードの確認
3. `build_projects.txt` ファイルの存在確認
4. レジストリへのログイン（モックモード時はシミュレーション）
5. 各プロジェクトに対して：
   - プロジェクト名の抽出
   - イメージURIの構築
   - ローカルイメージの存在確認（モックモード時は常に存在として扱う）
   - イメージのプッシュ（モックモード時はシミュレーション）

## エラーハンドリング

- 必須パラメータが不足している場合はエラーで終了
- `build_projects.txt` が存在しない場合はエラーで終了
- ローカルにイメージが存在しない場合は警告を出力してスキップ
- レジストリへのログインに失敗した場合はエラーで終了

## 注意事項

- このアクションは `get-changed-projects` と `build-docker-images` アクションの後に実行してください
- GitHub Container Registry を使用する場合は、適切な権限を持つトークンが必要です
- ローカルテストでは実際のレジストリへのプッシュは行われません（テスト用レジストリを除く）
