# CI/CDについて

## 概要

GitHub Actionsを使用したCI/CDパイプラインです。変更のあったプロジェクトのみを検出して効率的にビルド・デプロイを行います。

## CIとCDの違い

| 項目 | CI（継続的インテグレーション） | CD（継続的デリバリー） |
|-----|---------------------------|---------------------|
| **トリガー** | `main` ブランチへのPR作成・更新時 | `main` ブランチへのpush時（PRマージなど） |
| **目的** | 変更の検証 | 本番デプロイ |
| **ビルドステージ** | `test` ステージ | `final` ステージ |
| **成果物** | ビルド結果の確認のみ | GHCRへイメージをプッシュ |
| **ワークフロー** | `pullrequest-check.yml` | `docker-build.yml` |

## CI発火条件

CIは以下の条件で発火します。

### トリガー

| イベント | 発火条件 |
|---------|---------|
| **Pull Request** | `main` ブランチへのPR作成・更新時 |

### 対象ディレクトリ

- `projects/`
- `packages/`

### プロジェクト選定基準

変更ディレクトリのうち、**ルートに `Dockerfile` が存在し、`test` ステージを持つもの**が対象です。

```
projects/
├── my-app/
│   ├── Dockerfile  ← CI対象（testステージあり）
│   └── src/
└── lib/
    └── src/        ← CI対象外（Dockerfileなし）
```

### testステージの必要性

CIは `--target=test` を指定してビルドします。`test` ステージがないプロジェクトはスキップされます。

```dockerfile
# testステージが必須
FROM base AS test
RUN ./run-tests.sh
```

サンプルプロジェクト: [`projects/cicd-ci-sample/`](../projects/cicd-ci-sample/)

### CI専用プロジェクト

`test` ステージのみを持ち `final` ステージがないプロジェクトは「CI専用プロジェクト」となります。

| 特性 | 説明 |
|-----|------|
| **CI動作** | PR時に `test` ステージでビルド検証が実行される |
| **CD動作** | `final` ステージがないため、CD対象外となりスキップされる |
| **用途** | ライブラリ検証、テスト専用ツール、ビルド検証のみが必要なプロジェクト |

CI専用プロジェクトでは、本番デプロイ用の成果物（Dockerイメージ）は作成されません。

## CD発火条件

CDは以下の条件で発火します。

### トリガー

| イベント | 発火条件 |
|---------|---------|
| **Push** | `main` ブランチへのpush時（PRマージ、直接pushなど） |

### 対象ディレクトリ

- `projects/`
- `packages/`

### プロジェクト選定基準

変更ディレクトリのうち、**ルートに `Dockerfile` が存在するもの**が対象です。

```
projects/
├── my-app/
│   ├── Dockerfile  ← CD対象
│   └── src/
└── lib/
    └── src/        ← CD対象外（Dockerfileなし）
```

### finalステージ

CDは `--target=final` を指定してビルドします。**`final` ステージがないプロジェクトはCD対象外となり、イメージビルドとプッシュがスキップされます。**

```dockerfile
# finalステージ（CD対象にする場合は必須）
FROM base AS final
COPY . .
CMD ["./start.sh"]
```

### 実行される処理

1. **Dockerイメージのビルド** - `final` ステージでビルド
2. **GHCRへのプッシュ** - `ghcr.io/{リポジトリ}/{プロジェクト}:latest` としてプッシュ
3. **古いイメージのクリーンアップ** - 別リポジトリのワークフローをトリガー

## ワークフロー構成

### pullrequest-check.yml (CI)

```
1. コードのチェックアウト (fetch-depth: 50)
2. 変更ディレクトリの検出
3. 変更プロジェクトの特定（Dockerfile + testステージ必須）
4. Dockerイメージのビルド (--target=test)
5. ビルド結果の表示
```

### docker-build.yml (CD)

```
1. コードのチェックアウト (fetch-depth: 2)
2. 変更ディレクトリの検出
3. 変更プロジェクトの特定（Dockerfile + finalステージ必須）
4. Dockerイメージのビルド (--target=final)
5. Dockerイメージのプッシュ (GHCR)
6. 古いイメージのクリーンアップ
```

---

## カスタムアクション詳細

### get-changed-directories

変更のあったディレクトリを検出します。

| 項目 | 内容 |
|-----|------|
| 入力 | `HEAD` とベースリファレンスの差分 |
| 対象 | `projects/`、`packages/` 配下 |
| 出力 | `changed_dirs.txt` |

### get-changed-projects

Dockerfileがある変更プロジェクトを絞り込みます。

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `required-stage` | × | 指定した場合、そのステージを持つプロジェクトのみを対象にする |

| 項目 | 内容 |
|-----|------|
| 入力 | `changed_dirs.txt` |
| 処理 | 各ディレクトリに `Dockerfile` が存在し、`required-stage` が指定されていればそのステージも持つか確認 |
| 出力 | `build_projects.txt` + `BUILD_PROJECT` 環境変数 |

### build-docker-images

Dockerイメージをビルドします。

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `stage` | ○ | `test` または `final` |

**ビルド仕様:**
- `COMMIT_HASH` をビルド引数として渡す
- タグ: `ghcr.io/{リポジトリ名}/{プロジェクト名}:latest`
- `pre-docker-build.sh` があれば自動実行

### push-docker-images

GHCRへDockerイメージをプッシュします。

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `username` | ○ | レジストリのユーザー名 |
| `password` | ○ | レジストリのパスワード（トークン） |

### cleanup-docker-images

古いDockerイメージのクリーンアップを別リポジトリに依頼します。

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `token` | ○ | GitHubトークン（`repo` スコープ） |
| `repo-name` | ○ | クリーンアップ処理があるリポジトリ名 |
| `project-names-csv` | ○ | 対象プロジェクト名（カンマ区切り） |
| `keep-count` | × | 保持するイメージ数（デフォルト: `3`） |

## ファイル間のデータ連携

```
┌─────────────────────────┐
│ get-changed-directories │
│    changed_dirs.txt     │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  get-changed-projects   │
│   build_projects.txt    │
│    BUILD_PROJECT env    │
└───────────┬─────────────┘
            │
    ┌───────┴───────┐
    ▼               ▼
┌─────────┐   ┌─────────┐
│  build  │   │  push   │
│docker-  │   │docker-  │
│ images  │   │ images  │
└─────────┘   └────┬────┘
                   │
                   ▼
          ┌─────────────┐
          │   cleanup   │
          │docker-images│
          └─────────────┘
```

## トラブルシューティング

### 変更が検出されない

- `fetch-depth` が十分か確認（PR時は50、Push時は2）
- 対象ディレクトリ（`projects/`、`packages/`）配下の変更か確認

### ビルドがスキップされる

- `BUILD_PROJECT` 環境変数が設定されているか確認
- Dockerfileがプロジェクトルートに存在するか確認
- **CIの場合**: `test` ステージが定義されているか確認

### プッシュに失敗する

- `PRIVATE_REPO_TOKEN` が正しく設定されているか確認
- トークンに `write:packages` 権限があるか確認
