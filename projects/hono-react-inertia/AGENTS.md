# リポジトリのルール

## 技術スタック

- TypeScript
- ランタイム: Bun
- パッケージマネージャー: Bun
- ビルド: Bun
- リンター: Oxlint
- フォーマッター: Oxfmt

## 表現ルール

- 日本語で簡潔かつ丁寧に記述
- 文は短く簡潔に表現
- 文末は体言止めを基本
- 長い一行は避け、適度に改行
- 箇条書きを優先し、読みやすさを重視

## プロジェクト構成とモジュール整理

- アプリケーションコードは `src/`
- `index.ts` は Hono サーバー
- `client.tsx` はブラウザー側エントリー
- `root-view.ts` は HTML シェル描画
- `pages/` はページコンポーネント置き場
- ブラウザー向け出力は `public/client.js`
- メモ類は `docs/`

## 開発コマンド

- `bun run dev`: ビルド後、`http://localhost:3000` でホットリロードサーバー起動。
- `bun run build`: `src/client.tsx` を `public/` にバンドル。
- `bun run lint` / `bun run lint:fix`: Oxlint の問題確認または修正。
- `bun run fmt` / `bun run fmt:check`: Oxfmt でフォーマットまたは確認。

## コーディングスタイルと命名規則

- strict TypeScript と Hono JSX
- インデントは 2 スペース
- 相対 import は拡張子なし
- ファイル名は `root-view.ts` のような kebab-case
- コンポーネント名は `Root` のような PascalCase

## テスト方針

- 現時点では test スクリプトなし
- テスト追加時は Bun test
- テストファイルは対象コードと同じ場所
- ファイル名は `*.test.ts` または `*.test.tsx`
- `test` スクリプトも追加
- PR 前は `bun run fmt:check` と `bun run lint`
