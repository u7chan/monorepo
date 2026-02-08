# ESLint/Prettier から oxc (oxlint + oxfmt) への移行

## 概要

ESLint と Prettier を oxc の oxlint（リンター）と oxfmt（フォーマッター）に移行する。
oxc は Rust 製で、ESLint より 50-100 倍、Prettier より約 30 倍高速。

## 現状

- **Linter**: ESLint v9 with `eslint-config-next`
  - 設定ファイル: `eslint.config.mjs`
  - スクリプト: `"lint": "tsc && eslint"`
  - 無視パス: `node_modules/**`, `.next/**`, `out/**`, `build/**`, `next-env.d.ts`

- **Formatter**: Prettier v3
  - 設定ファイル: `.prettierrc.yml`
  - スクリプト: `"format": "prettier --write src"`
  - 設定:
    - `semi: false`
    - `printWidth: 120`
    - `singleQuote: true`
    - `jsxSingleQuote: true`
    - `plugins`: `prettier-plugin-tailwindcss`, `@ianvs/prettier-plugin-sort-imports`
    - `importOrder`: スコープ付きパッケージ → @/ → 相対パス

## タスクリスト

### 1. 調査・準備

- [x] oxfmt の alpha 版の現状確認
  - [x] Next.js プロジェクトでの既知の問題がないか確認
  - [x] Tailwind CSS class sorting の動作確認
  - [x] import sorting のカスタマイズ対応状況確認
- [x] `eslint-config-next` のルールを oxlint でカバーできるか確認
  - [x] Next.js 特有のルールの代替策検討

### 2. oxlint の導入

- [x] `oxlint` を devDependencies に追加
  ```bash
  bun add -D oxlint
  ```
- [x] ESLint 設定の移行
  - [x] `@oxlint/migrate` を使用して `eslint.config.mjs` を変換
    ```bash
    npx @oxlint/migrate
    ```
  - [x] 変換後の設定を確認・調整
    - `node_modules/**`, `.next/**`, `out/**`, `build/**`, `next-env.d.ts` の無視設定
    - `eslint-config-next` の代替ルールの検討
- [x] `.oxlintrc.json`（または `oxlint.config.js`）を作成
- [x] 並行実行テスト
  - [x] `bun run lint`（従来）と `oxlint` の結果を比較
  - [x] 差分の確認と対応

### 3. oxfmt の導入

- [x] `oxfmt` を devDependencies に追加
  ```bash
  bun add -D oxfmt
  ```
- [x] Prettier 設定の移行
  - [x] `.prettierrc.yml` の設定を oxfmt 設定に変換
    - `semi: false` → oxfmt 対応確認
    - `printWidth: 120` → oxfmt 対応確認
    - `singleQuote: true` → oxfmt 対応確認
    - `jsxSingleQuote: true` → oxfmt 対応確認
  - [x] Import sorting の設定
    - oxfmt の組み込み機能を使用（設定可能か確認）
  - [x] Tailwind CSS class sorting の設定
    - oxfmt の組み込み機能を使用
- [x] `oxfmt.config.js`（または `.oxfmtrc`）を作成
- [x] フォーマット結果の比較テスト
  - [x] `prettier --write src` と `oxfmt` の結果を比較
  - [x] 差分の確認と対応

### 4. package.json の更新

- [x] `scripts` の更新
  ```json
  {
    "lint": "tsc && oxlint",
    "lint:fix": "oxlint --fix",
    "format": "oxfmt",
    "format:check": "oxfmt --check"
  }
  ```
- [x] `devDependencies` から ESLint/Prettier 関連を削除
  - `eslint`
  - `eslint-config-next`
  - `@eslint/eslintrc`
  - `prettier`
  - `@ianvs/prettier-plugin-sort-imports`
  - `prettier-plugin-tailwindcss`

### 5. 設定ファイルの整理

- [x] 古い設定ファイルの削除
  - [x] `eslint.config.mjs`
  - [x] `.eslintrc*`（存在する場合）
  - [x] `.prettierrc.yml`
  - [x] `.prettierignore`（存在する場合）
- [x] 新しい設定ファイルの追加
  - [x] `.oxlintrc.json`（または `oxlint.config.js`）
  - [x] `oxfmt.config.js`（または `.oxfmtrc`）
  - [x] `.oxlintignore`（必要に応じて）

### 6. CI/CD の更新

- [ ] GitHub Actions のワークフロー確認・更新
  - [ ] lint ジョブの更新
  - [ ] format-check ジョブの更新

### 7. Editor 設定の更新

- [ ] VS Code の設定更新（`.vscode/settings.json`）
  - [ ] ESLint/Prettier 拡張機能の無効化または削除
  - [ ] oxc 拡張機能の有効化
- [ ] 推奨拡張機能の更新（`.vscode/extensions.json`）

### 8. 検証・テスト

- [x] 全ファイルの lint チェック
  ```bash
  bun run lint
  ```
- [x] 全ファイルのフォーマットチェック
  ```bash
  bun run format:check
  ```
- [x] ビルドテスト
  ```bash
  bun run build
  ```
- [x] 開発サーバーの起動確認
  ```bash
  bun run dev
  ```

### 9. ドキュメント更新

- [ ] `README.md` の更新
  - [ ] 使用ツールの記載変更（ESLint/Prettier → oxc）
  - [ ] スクリプトの説明更新
- [x] `AGENTS.md` の更新（必要に応じて）

## 注意事項

### oxfmt の Alpha 版について

oxfmt は現在 alpha 版であり、以下に注意が必要：

1. **Prettier 互換性**: 約 95% のテストをパス、残りはニッチなケース
2. **Next.js 対応**: 基本的な JavaScript/TypeScript/JSX/TSX はサポート
3. **Import Sorting**: oxfmt 組み込み機能でカバー可能（設定方法要確認）
4. **Tailwind CSS**: oxfmt 組み込みで class sorting サポート

### リスク軽減策

- **段階的移行**: ESLint/Prettier を完全に削除せず、並行して実行する期間を設ける
- **CI での比較**: 移行期間中は両方の結果を出力して差分を監視
- **バックアップ**: 移行前にブランチを切っておく

## 参考リンク

- [oxc 公式ドキュメント](https://oxc.rs/docs/guide/introduction.html)
- [oxlint - Migrate from ESLint](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.html)
- [oxfmt - Migrate from Prettier](https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier.html)
- [@oxlint/migrate](https://github.com/oxc-project/oxlint-migrate)
