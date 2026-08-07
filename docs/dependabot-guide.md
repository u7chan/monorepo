# Dependabot 運用ガイド

このリポジトリでは、Dependabot のバージョン更新を使い、一部プロジェクトの依存パッケージ更新 PR を自動作成します。
対象プロジェクトと更新条件の正本は [`.github/dependabot.yml`](../.github/dependabot.yml) です。対象一覧を確認するときは、ドキュメントではなく設定ファイルを参照してください。

## 現在の運用方針

各プロジェクトの設定は、次の方針にそろえています。

| 項目 | 方針 |
| --- | --- |
| 対応するパッケージ管理 | Bun、uv |
| 更新頻度 | 週次 |
| 同時に開く PR | プロジェクトごとに `1` 件 |
| minor / patch 更新 | プロジェクト単位で一つの PR にまとめる |
| major 更新 | 依存パッケージごとに個別 PR を作る |
| 自動 rebase | 無効 |

公開レジストリだけを使うプロジェクトには、レジストリの追加設定は不要です。非公開レジストリから取得する場合は、`registries` の設定と認証情報を別途追加します。

## Dependabot PR を確認する

Dependabot PR が作成されたら、次の順に確認します。

1. CI が成功しているか確認する
2. グループ化された PR では、変更が一つのプロジェクトに収まっているか確認する
3. major 更新では、依存パッケージごとの個別 PR になっているか確認する
4. 必要な場合は、対象プロジェクトだけをローカルで検証する
5. 問題がなければ、通常の PR と同じ手順でマージする

更新を取り込めない場合は、PR を閉じます。同じ更新を継続して除外する必要がある場合は、理由を確認したうえで `ignore` を設定します。

`rebase-strategy: "disabled"` を設定しているため、他の PR が先にマージされても Dependabot は自動で rebase しません。競合が発生した PR は手動で確認します。

## 対象プロジェクトを追加する

### 1. 対応ファイルを確認する

プロジェクトルートに、対象のパッケージ管理ツールに対応するファイルが必要です。

| パッケージ管理 | 必要なファイル |
| --- | --- |
| Bun | `package.json`、`bun.lock` |
| uv | `pyproject.toml`、`uv.lock` |

### 2. `updates` を追加する

`.github/dependabot.yml` の `updates` に、プロジェクト専用のブロックを追加します。`directory` は単一の文字列で指定し、リポジトリルートから始まる絶対パス形式にします。

#### Bun

```yaml
- package-ecosystem: "bun"
  directory: "/projects/your-bun-project"
  schedule:
    interval: "weekly"
  open-pull-requests-limit: 1
  rebase-strategy: "disabled"
  groups:
    your-bun-project-minor-and-patch:
      applies-to: version-updates
      patterns:
        - "*"
      update-types:
        - "minor"
        - "patch"
```

#### uv

```yaml
- package-ecosystem: "uv"
  directory: "/projects/your-uv-project"
  schedule:
    interval: "weekly"
  open-pull-requests-limit: 1
  rebase-strategy: "disabled"
  groups:
    your-uv-project-minor-and-patch:
      applies-to: version-updates
      patterns:
        - "*"
      update-types:
        - "minor"
        - "patch"
```

### 3. 設定を確認する

- `package-ecosystem` が実際のパッケージ管理ツールと一致している
- `directory` がマニフェストとロックファイルのあるディレクトリを指している
- グループ名が `{project}-minor-and-patch` 形式になっている
- `update-types` に `major` を含めていない
- 既存プロジェクトの `updates` と重複していない
- マージ後、GitHub 上に Dependabot の設定エラーが表示されていない

## 設定を調整する

### 更新頻度を変える

`schedule.interval` には、次のいずれかを指定します。

- `daily`
- `weekly`
- `monthly`

```yaml
schedule:
  interval: "weekly"
```

### 同時に開く PR を制限する

`open-pull-requests-limit` は、一つの `updates` ブロックが同時に開くバージョン更新 PR の上限です。現在はプロジェクトごとに `1` を指定しています。

```yaml
open-pull-requests-limit: 1
```

### minor / patch 更新をまとめる

同じプロジェクトのロックファイルを複数の PR が同時に変更しないよう、`groups` で minor / patch 更新をまとめます。major 更新はグループに含めません。

```yaml
groups:
  your-project-minor-and-patch:
    applies-to: version-updates
    patterns:
      - "*"
    update-types:
      - "minor"
      - "patch"
```

### 自動 rebase を無効にする

```yaml
rebase-strategy: "disabled"
```

自動 rebase を無効にすると、依存更新による CI の再実行を抑えられる一方、古くなった PR の競合は手動で解消する必要があります。

### 特定の依存パッケージを除外する

```yaml
ignore:
  - dependency-name: "example-package"
```

### PR にラベルを付ける

```yaml
labels:
  - "dependencies"
```

## PR が作成されないとき

1. 対象プロジェクトが `.github/dependabot.yml` に登録されているか確認する
2. `directory` とマニフェストの配置が一致しているか確認する
3. 対応するロックファイルが存在するか確認する
4. GitHub 上に Dependabot の設定エラーがないか確認する
5. リポジトリの Dependency Graph が有効か確認する
6. 非公開レジストリを使っている場合は、`registries` と認証情報を確認する
