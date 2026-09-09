# pnpm-sample

pnpm の標準構成を示す教材・CI/CD 検証用のサンプルプロジェクトです。
`projects/_samples` に配置する分類ルール（教材・テンプレート・CI/CD の検証）に従っています。

ref: #1220

## 構成

| ファイル            | 役割                                              |
| ------------------- | ------------------------------------------------- |
| `package.json`      | pnpm、oxlint、Vitest、TypeScript、Prettier の設定 |
| `pnpm-lock.yaml`    | pnpm 10 で固定した依存関係                        |
| `tsconfig.json`     | NodeNext 向け TypeScript 設定                     |
| `src/greet.ts`      | Node 組み込み API に依存しない純粋関数            |
| `src/greet.test.ts` | `greet` の Vitest テスト                          |
| `src/main.ts`       | `greet` を呼び出すエントリポイント                |
| `src/index.ts`      | ライブラリの barrel                               |
| `Dockerfile`        | test、builder、final のマルチステージビルド       |
| `.dockerignore`     | Docker ビルドから除外する生成物                   |
| `.gitignore`        | ローカルの依存関係と生成物の除外                  |
| `.oxlintrc.json`    | oxlint の依存関係と生成物の除外設定               |
| `.prettierignore`   | Prettier の対象外にする生成物とロックファイル     |

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
