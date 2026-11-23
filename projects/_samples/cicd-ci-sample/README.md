# cicd-ci-sample

CI/CDメンテナンス用のCIサンプルプロジェクトです。

## 概要

PR時にCIワークフローが発火してビルド検証を行うためのサンプルです。
`test`ステージを持つDockerfileで、CI時に `--target=test` と `--target=final` の2回ビルドします。このプロジェクトは `final` ステージを持たないため、2回目はステージ指定なしで既定ステージ（`test`）をビルドします。

## testステージが重要な理由

このリポジトリのCI/CDパイプラインでは、変更されたプロジェクトのうち `Dockerfile` を持つものがCI検証の対象となります。ステージの有無では絞り込まないため、`test` ステージを持たないプロジェクトも既定ステージでビルドされます。

| ビルドタイプ | 対象ステージ | 用途 |
|-----------|------------|------|
| **CI (Pull Request時)** | `test` と `final`（`final` がなければ既定ステージ） | `test` は軽量な検証（テスト実行、lint、型チェックなど）、`final` は配布イメージの組み立て確認 |
| **CD (main push時)** | スキップ | CI専用プロジェクトのため、CDではイメージビルド・プッシュを行わない |

### CIでtestステージが選ばれる仕組み

`.github/workflows/pullrequest-check.yml` で `--target=test` と `--target=final` が指定されています：

```yaml
- uses: ./.github/actions/build-docker-images
  with:
    stage: test  # testステージを明示的に指定
    image_tags: ci-test

- uses: ./.github/actions/build-docker-images
  with:
    stage: final  # 配布するイメージの組み立てを確認する
    image_tags: ci-final
```

指定したステージが Dockerfile に存在しない場合は、ターゲット指定を外して既定ステージをビルドします。ステージが無いことを理由に CI ビルドがスキップされることはありません。

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
4. `build-docker-images`（stage=test）でテストを検証
5. `build-docker-images`（stage=final）でビルドする。このプロジェクトは `final` ステージを持たないため、既定ステージ（`test`）の再ビルドになる
6. ビルド成功でPRチェックがパス

### mainブランチへのマージ時（CD）

1. PRがマージされると、`docker-build.yml` が発火（`projects/<name>/docs` だけの変更では発火しない）
2. `get-changed-directories` で変更ディレクトリを検出
3. `get-changed-projects`（`required-stage: final`）で`final`ステージを持つプロジェクトを絞り込み
4. **このプロジェクトは`final`ステージを持たないため、CD対象外となりスキップされる**
