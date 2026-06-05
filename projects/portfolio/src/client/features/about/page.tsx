import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

const source = `
# Portfolio について

Portfolio は、**React SPA** と **Hono API** を組み合わせた Web アプリケーションです。

フロントエンド、バックエンド、データベース、開発支援ツールを TypeScript 中心でそろえ、
小さく検証しながら機能を追加しやすい構成を目指しています。

> このページ自体も、Markdown の表現を確認するための軽いサンプルとして使えます。

## この Web アプリについて

このアプリでは、次のような機能を実際に触りながら確認できます。

- **ポートフォリオ説明**: アプリの構成や採用技術を Markdown で分かりやすく紹介します。
- **チャット**: \`Markdown Preview\` やモデル設定を含むチャット UI を試せます。
- **チャット比較**: 複数の応答を見比べながら、*出力の違い*を確認できます。
- **差分確認**: テキストやコードの差分を視覚的に確認できます。
- **Markdown 表示**: **表**、[リンク](https://www.markdownguide.org/)、\`inline code\` などの表示例を確認できます。

UI は \`Vite\` と \`React\` で構築し、ルーティングには **TanStack Router** を利用しています。
サーバー側は **Hono** を採用し、\`PostgreSQL\` と \`Drizzle ORM\` によってデータを扱います。

## Tech Stack

| 項目 | 技術 | ADR |
| --- | --- | --- |
| 言語 | TypeScript | 静的型付けにより意図を明確にでき、現在の Web 開発で広く使われるモダンな言語であるため。 |
| 実行環境 | Node | 現時点では Node ベースのコンテナを採用しているため。 |
| パッケージ管理 | Bun | 依存関係の管理とスクリプト実行を高速に扱えるため。 |
| リンター/フォーマッター | Oxlint / Oxfmt | Rust 製で高速に動作し、Biome 以外の Rust 製ツールも実運用で試してみたいため。 |
| スタイル | Tailwind CSS | AI 支援との相性がよく、HTML やコンポーネント内にスタイルの意図を完結させやすいため。 |
| 開発・ビルド | Vite | 開発用サーバー、ビルド、型生成までを一つの流れで扱いやすいため。 |
| テスト | Vitest | Vite / TypeScript と相性がよく、フロントエンドに近い開発体験でテストを書けるため。 |
| バックエンド | Hono | 超軽量かつ依存ゼロで、複数ランタイムで動作する次世代 Web フレームワークであり、日本発でメンテナンスも活発なため。 |
| フロントエンド | React (SPA) | Vite と相性がよく、SPA として対話的な UI を構築しやすいため。 |
| ルーティング | TanStack Router | SPA 向けのルーティングを型安全に扱えるため。 |
| データ取得 | TanStack Query | Fetch まわりの状態管理を整理しやすく、TanStack Router と同じエコシステムで扱えるため。 |
| データベース | PostgreSQL | ライセンス面で扱いやすく、実用的なリレーショナルデータ管理を安定して行えるため。 |
| ORM | Drizzle ORM | TypeScript ベースでスキーマを定義でき、軽量かつ高速にデータアクセスできるため。 |
| 開発環境 | Dev Containers (VSCode) | ホスト側に直接環境を入れずに開発できるようにするため。ただし Docker 互換のサービスは必要です。 |

## 開発方針

TypeScript の \`strict mode\` を前提に、型で意図を明確にしながら実装しています。
テストは **Vitest** を使い、*仕様として読みやすいテストケース*になることを重視しています。

今後も、実装の見通しや保守性を損なわない範囲で、機能と表現を少しずつ改善していきます。

---

*最終更新日: ${new Date().toLocaleDateString()}*
`

export function About() {
  return (
    <div className='min-h-full bg-white px-4 py-6 dark:bg-gray-900 md:px-8 md:py-8'>
      <div className='mx-auto max-w-3xl'>
        <div className='prose prose-sm max-w-none text-gray-700 prose-headings:text-gray-900 prose-strong:text-gray-900 prose-a:text-blue-700 prose-code:text-gray-800 prose-pre:bg-gray-950 md:prose-base dark:prose-invert dark:text-gray-200 dark:prose-headings:text-white dark:prose-strong:text-white dark:prose-a:text-blue-300 dark:prose-code:text-gray-100'>
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {source}
          </Markdown>
        </div>
      </div>
    </div>
  )
}
