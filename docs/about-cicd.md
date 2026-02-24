# CI/CDについて

## 概要

GitHub Actionsを使用したCI/CDパイプラインです。変更のあったプロジェクトのみを検出して効率的にビルド・デプロイを行います。

| トリガー | 実行内容 |
|---------|---------|
| **mainブランチへのpush** | Dockerイメージをビルド → GHCRにプッシュ → 古いイメージをクリーンアップ |
| **mainブランチへのpull request** | 変更プロジェクトを検出 → testステージでビルド検証 |

## ワークフロー構成

### docker-build.yml (CD - 継続的デリバリー)

mainブランチへのpush時に実行されます。

```
1. コードのチェックアウト (fetch-depth: 2)
   └─ 直前のコミットとの差分検出に必要な最小限の履歴

2. 変更ディレクトリの検出 (get-changed-directories)
   └─ projects/ および packages/ 配下の変更を検出

3. 変更プロジェクトの特定 (get-changed-projects)
   └─ Dockerfileがあるプロジェクトを絞り込み

4. Dockerイメージのビルド (build-docker-images)
   └─ finalステージを指定してビルド

5. Dockerイメージのプッシュ (push-docker-images)
   └─ GHCR (ghcr.io) へlatestタグでプッシュ

6. 古いイメージのクリーンアップ (cleanup-docker-images)
   └─ 別リポジトリのワークフローをトリガーして整理
```

### pullrequest-check.yml (CI - 継続的インテグレーション)

mainブランチへのpull request時に実行されます。

```
1. コードのチェックアウト (fetch-depth: 50)
   └─ PRのベースブランチとの差分検出に必要な履歴

2. 変更ディレクトリの検出 (get-changed-directories)

3. 変更プロジェクトの特定 (get-changed-projects)

4. Dockerイメージのビルド (build-docker-images)
   └─ testステージを指定してビルド（軽量な検証用）

5. Dockerイメージの表示
   └─ ビルド結果の確認
```

## カスタムアクション詳細

### get-changed-directories

変更のあったディレクトリを検出します。

| 項目 | 内容 |
|-----|------|
| 入力 | `HEAD` とベースリファレンス（PR時: `origin/main`、Push時: `HEAD~1`）の差分 |
| 対象 | `projects/`、`packages/` 配下のディレクトリ |
| 出力 | `changed_dirs.txt`（改行区切りのディレクトリパス） |
| 特徴 | リネーム（移動）されたファイルにも対応 |

### get-changed-projects

Dockerfileがある変更プロジェクトを絞り込みます。

| 項目 | 内容 |
|-----|------|
| 入力 | `changed_dirs.txt` |
| 処理 | 各ディレクトリに `Dockerfile` が存在するか確認 |
| 出力 | `build_projects.txt` + `BUILD_PROJECT` 環境変数（カンマ区切り） |

### build-docker-images

Dockerイメージをビルドします。

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `stage` | ○ | ビルドステージ（`test` または `final`） |

**ビルド仕様:**
- `COMMIT_HASH` をビルド引数として渡す
- 指定ステージが存在する場合: `--target` 指定でビルド
- 存在しない場合: 通常ビルド（マルチステージ全体）
- タグ: `ghcr.io/{リポジトリ名}/{プロジェクト名}:latest`

**オプション機能:**
- プロジェクト配下に `pre-docker-build.sh` があれば自動実行

### push-docker-images

GHCRへDockerイメージをプッシュします。

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `registry` | × | レジストリURL（デフォルト: `ghcr.io`） |
| `username` | ○ | レジストリのユーザー名 |
| `password` | ○ | レジストリのパスワード（トークン） |

**出力:**
- `project_names_csv`: プッシュしたプロジェクト名（カンマ区切り）

### cleanup-docker-images

古いDockerイメージのクリーンアップを別リポジトリに依頼します。

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `token` | ○ | GitHubトークン（`repo` スコープが必要） |
| `repo-name` | ○ | クリーンアップ処理があるリポジトリ名 |
| `project-names-csv` | ○ | 対象プロジェクト名（カンマ区切り） |
| `keep-count` | × | 保持するイメージ数（デフォルト: `3`） |

**動作:**
- リポジトリディスパッチイベントを発行
- 別リポジトリのワークフローをトリガー

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

### プッシュに失敗する

- `PRIVATE_REPO_TOKEN` が正しく設定されているか確認
- トークンに `write:packages` 権限があるか確認
