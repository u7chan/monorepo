# pnpm-sample

pnpm の標準構成を示す教材・CI/CD 検証用のサンプルプロジェクトです。
`projects/_samples` に配置する分類ルール（教材・テンプレート・CI/CD の検証）に従っています。

ref: #1220

## 目的

- pnpm 10 の標準的なプロジェクト構成（`package.json` と `pnpm-lock.yaml`）を示す教材として使う
- ライセンスチェックと Docker ビルドの CI が pnpm プロジェクトを正しく扱えることを検証する

## 構成

| ファイル            | 役割                                              |
| ------------------- | ------------------------------------------------- |
| `package.json`      | pnpm、oxlint、Vitest、TypeScript、Prettier の設定 |
| `pnpm-lock.yaml`    | pnpm 10 で固定した依存関係                        |
| `tsconfig.json`     | NodeNext 向け TypeScript 設定                     |
| `vitest.config.ts`  | Vitest のテスト対象を `src` に限定する設定        |
| `src/greet.ts`      | Node 組み込み API に依存しない純粋関数            |
| `src/greet.test.ts` | `greet` の Vitest テスト                          |
| `src/main.ts`       | `greet` を呼び出すエントリポイント                |
| `src/index.ts`      | ライブラリの barrel                               |
| `Dockerfile`        | test、builder、final のマルチステージビルド       |
| `.dockerignore`     | Docker ビルドから除外する生成物                   |
| `.gitignore`        | ローカルの依存関係と生成物の除外                  |
| `.oxlintrc.json`    | oxlint の依存関係と生成物の除外設定               |
| `.prettierignore`   | Prettier の対象外にする生成物とロックファイル     |

## CI での検証ポイント

PR の CI（`.github/workflows/pullrequest-check.yml`）では、次の挙動を確認できます。

- `pnpm-lock.yaml` の変更で、このプロジェクトがライセンスチェックの対象として検出される
- 対象に `pnpm-lock.yaml` があるため、CI が `pnpm/action-setup@v4` で pnpm 10 系をセットアップする
- `pnpm install --frozen-lockfile --prod --ignore-scripts` が失敗せず、ライセンスチェックが完了する（依存を `devDependencies` のみにしているため、実スキャン対象のパッケージは 0 件で `PASS` になる）
- Docker の `test` ステージのビルドで `pnpm lint` と `pnpm test` が実行される

ライセンスチェックの pnpm 対応の詳細は、[OSS ライセンスチェック](../../../docs/license-check.md)を参照してください。

## ローカルでの実行

プロジェクトディレクトリで、次のコマンドを実行します。

```bash
npx -y pnpm@10.34.5 install
npx -y pnpm@10.34.5 lint
npx -y pnpm@10.34.5 test
npx -y pnpm@10.34.5 format:check
npx -y pnpm@10.34.5 build
```

ビルド後は、次のコマンドでエントリポイントを実行できます。

```bash
node dist/main.js
```

## Docker での実行

プロジェクトディレクトリをビルドコンテキストにして、CI 用の `test` ステージをビルドします。

```bash
docker build --target=test -t pnpm-sample-test --progress=plain .
```

実行用の `final` イメージのビルドと実行は次のとおりです。

```bash
docker build -t pnpm-sample-final .
docker run --rm pnpm-sample-final
```
