# cicd-ci-sample

CI/CDメンテナンス用のCIサンプルプロジェクトです。

## 概要

PR時にCIワークフローが発火してビルド検証を行うためのサンプルです。
`test`ステージを持つDockerfileで、CI時に `--target=test` を指定してビルドします。

## testステージが重要な理由

このリポジトリのCI/CDパイプラインでは、`test`ステージを持つプロジェクトのみがCI検証対象となります。

| ビルドタイプ | 対象ステージ | 用途 |
|-----------|------------|------|
| **CI (Pull Request時)** | `test` | 軽量な検証（テスト実行、lint、型チェックなど） |
| **CD (main push時)** | スキップ | CI専用プロジェクトのため、CDではイメージビルド・プッシュを行わない |

### CIでtestステージが選ばれる仕組み

`.github/workflows/pullrequest-check.yml` で `--target=test` が指定されています：

```yaml
- uses: ./.github/actions/build-docker-images
  with:
    stage: test  # testステージを明示的に指定
```

testステージが存在しないDockerfileは、PR時のCIビルドでスキップされてしまいます。

## Dockerfile構成

| Stage | 用途 |
|-------|------|
| base | ベースイメージ |
| **test** | **CI検証用（PR時にビルド）** |

このプロジェクトは `final` ステージを持たない**CI専用プロジェクト**です。PR時にCI検証が行われますが、mainブランチへのマージ時にはCDでイメージビルド・プッシュは行われません。

## サンプル解説

### testステージの定義

```dockerfile
# test stage
# CIワークフローで --target=test を指定してビルド
FROM base AS test

COPY scripts/ scripts/
COPY tests/ tests/

RUN echo "=== Running tests (CI validation) ===" && \
    chmod +x scripts/test.sh && \
    ./scripts/test.sh
```

ポイント：
- `AS test` でステージを命名
- テスト実行に必要なファイルのみをコピー（軽量化）
- テストスクリプトを実行して検証

### testステージの実装パターン

#### パターン1: シェルスクリプトでテスト実行

```dockerfile
FROM base AS test
COPY scripts/test.sh .
RUN chmod +x test.sh && ./test.sh
```

#### パターン2: テストツールを直接実行

```dockerfile
FROM node:20-alpine AS test
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm test
```

#### パターン3: マルチステージで成果物を検証

```dockerfile
FROM base AS build
COPY . .
RUN ./build.sh

FROM build AS test
RUN ./test-built-artifacts.sh
```

## ローカルでのテストビルド

CIと同じ条件でローカルビルドを確認できます：

```bash
# testステージを指定してビルド（CIと同じ）
docker build -t cicd-ci-sample:test --target=test --progress plain .
```

このプロジェクトはCI専用のため、`final` ステージは存在しません。mainブランチへのマージ時にはCD対象外となります。

## CIワークフローとの連携

### PR時（CI）

1. PRを作成すると、`pullrequest-check.yml` が発火
2. `get-changed-directories` で変更ディレクトリを検出
3. `get-changed-projects` でDockerfileがあるプロジェクトを絞り込み
4. `build-docker-images`（stage=test）でビルド検証
5. ビルド成功でPRチェックがパス

### mainブランチへのマージ時（CD）

1. PRがマージされると、`docker-build.yml` が発火
2. `get-changed-directories` で変更ディレクトリを検出
3. `get-changed-projects`（`required-stage: final`）で`final`ステージを持つプロジェクトを絞り込み
4. **このプロジェクトは`final`ステージを持たないため、CD対象外となりスキップされる**
