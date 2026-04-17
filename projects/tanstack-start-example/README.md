# TanStack Start SSR Demo

TanStack Start の主要SSR機能をシンプルな記事アプリで確認できるサンプルプロジェクトです。

## デモ機能

| 機能 | URL | 実装場所 |
|------|-----|---------|
| SSR確認（サーバー描画時刻バッジ） | `/articles` | `routes/articles/index.tsx` |
| Queryパラメーター（`?q=` 検索フィルター） | `/articles?q=react` | `validateSearch` + `loaderDeps` |
| パスパラメーター（詳細ページ） | `/articles/:id` | `routes/articles/$articleId.tsx` |
| データ取得失敗時のSSRエラー表示 | `/articles/error` | `errorComponent` |
| Cookie / リクエストヘッダー読み取り | `/articles` | `createServerFn` + `getCookie` / `getRequestHeader` |
| 404 Not Found | `/articles/not-a-real-id` | `notFoundComponent` + `notFound()` |
| ローディング / Streaming（defer + Suspense） | `/articles/slow` | `defer` + `<Await>` |

## セットアップ

```bash
bun install
bun run dev
```

## スクリプト

| コマンド | 説明 |
|---------|------|
| `bun run dev` | 開発サーバー起動（Vite HMR） |
| `bun run build` | プロダクションビルド + 型チェック |
| `bun run preview` | ビルド結果のプレビュー |
| `bun start` | Nitro SSRサーバーで起動（要ビルド） |

## 主要ファイル

```
src/
  data/articles.ts              # モックデータ・サーバー関数（createServerFn）
  components/SsrBadge.tsx       # SSR描画時刻バッジ
  routes/
    index.tsx                   # デモハブページ
    articles/index.tsx          # 一覧ページ（SSR・検索・Cookie/ヘッダー）
    articles/$articleId.tsx     # 詳細ページ（パスパラメーター・エラー・defer）
```

## 技術スタック

- [TanStack Start](https://tanstack.com/start) — フルスタックReactフレームワーク
- [TanStack Router](https://tanstack.com/router) — 型安全なファイルベースルーティング
- [Nitro](https://nitro.build/) — SSRサーバーエンジン
- [Vite](https://vite.dev/) — ビルドツール
- [Tailwind CSS v4](https://tailwindcss.com/) — スタイリング
- [React 19](https://react.dev/) — UIライブラリ
