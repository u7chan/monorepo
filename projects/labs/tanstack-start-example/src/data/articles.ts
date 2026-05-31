import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie, getRequestHeader } from '@tanstack/react-start/server'

export type Article = {
  id: string
  title: string
  summary: string
  body: string
  tags: string[]
  lang: 'en' | 'ja'
}

const ARTICLES: Article[] = [
  {
    id: 'getting-started',
    title: 'Getting Started with TanStack Start',
    summary: 'Learn how to build full-stack React apps with TanStack Start.',
    body: 'TanStack Start is a full-stack React framework powered by TanStack Router and Vite. It provides type-safe routing, server functions, and streaming SSR out of the box. This guide walks you through setting up your first project and understanding the core concepts.',
    tags: ['react', 'tanstack', 'ssr'],
    lang: 'en',
  },
  {
    id: 'server-functions',
    title: 'Type-Safe Server Functions',
    summary: 'Call server-side logic directly from your components with full type inference.',
    body: 'Server functions in TanStack Start allow you to write server-side logic that can be called directly from your React components. They provide end-to-end type safety and are compiled away at build time. Under the hood, they become API endpoints that are called via HTTP.',
    tags: ['react', 'server', 'typescript'],
    lang: 'en',
  },
  {
    id: 'streaming-ssr',
    title: 'Streaming SSR with React 19',
    summary: 'Stream server-rendered HTML progressively with Suspense.',
    body: "Streaming SSR allows you to send HTML to the client progressively as it becomes available. Combined with React 19's Suspense, you can defer slow data fetches and stream them in after the initial shell has been sent. This dramatically improves Time to First Byte (TTFB).",
    tags: ['ssr', 'react', 'performance'],
    lang: 'en',
  },
  {
    id: 'file-based-routing',
    title: 'File-Based Routing in TanStack Router',
    summary: 'Intuitive file-system routing with nested layouts and dynamic segments.',
    body: 'TanStack Router uses a file-based routing convention where your file structure maps directly to your URL structure. Special file naming conventions like $param for dynamic segments and __root for layouts make it easy to reason about your routing tree.',
    tags: ['routing', 'tanstack'],
    lang: 'en',
  },
  {
    id: 'query-params',
    title: 'Type-Safe Query Parameters',
    summary: 'Validate and type your URL search parameters with validateSearch.',
    body: "TanStack Router's validateSearch option lets you define the shape of your query parameters with full type safety. This means you get autocomplete, type checking, and validation for URL search params throughout your application — no more parsing strings manually.",
    tags: ['routing', 'typescript', 'tanstack'],
    lang: 'en',
  },
  {
    id: 'vite-integration',
    title: 'Vite Integration and HMR',
    summary: 'Lightning-fast development with Vite-powered Hot Module Replacement.',
    body: 'TanStack Start builds on top of Vite for fast development and optimized production builds. Hot Module Replacement works seamlessly with both client and server code, making the development experience feel instant even for complex full-stack applications.',
    tags: ['vite', 'dx', 'performance'],
    lang: 'en',
  },
  {
    id: 'tanstack-start-nyumon',
    title: 'TanStack Start 入門',
    summary: 'TanStack Start で始めるフルスタック React 開発の基礎。',
    body: 'TanStack Start は TanStack Router と Vite をベースにしたフルスタック React フレームワークです。型安全なルーティング、サーバー関数、ストリーミング SSR を標準で提供します。このガイドでは基本的なセットアップから主要コンセプトまでを解説します。',
    tags: ['react', 'tanstack', 'ssr', '入門'],
    lang: 'ja',
  },
  {
    id: 'server-rendering-to-ha',
    title: 'サーバーサイドレンダリングとは',
    summary: 'SSR の仕組みとクライアントサイドレンダリングとの違いを理解する。',
    body: 'サーバーサイドレンダリング (SSR) とは、HTML をブラウザではなくサーバー上で生成する手法です。初期表示が速くなり、SEO に有利になります。TanStack Start はデフォルトで SSR を有効にしており、Nitro サーバーエンジンを使って Node.js 上で React コンポーネントを描画します。',
    tags: ['ssr', 'react', '基礎'],
    lang: 'ja',
  },
]

const SLOW_ARTICLE: Article = {
  id: 'slow',
  title: 'Slow Loading Article (defer demo)',
  summary: 'This article has a 1.5s simulated delay to demonstrate pendingComponent and defer.',
  body: "This article simulates a slow data source to demonstrate TanStack Start's loading and streaming capabilities. The loader delays for 1.5 seconds before returning, which triggers the pendingComponent while the server waits. The related articles section uses defer() and Suspense to stream in asynchronously.",
  tags: ['demo', 'loading', 'defer'],
  lang: 'en',
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Regular async functions — called from loaders (server-side only)
export async function fetchArticles(q?: string): Promise<Article[]> {
  const query = q?.toLowerCase().trim()
  if (!query) return ARTICLES
  return ARTICLES.filter(
    (a) =>
      a.title.toLowerCase().includes(query) ||
      a.summary.toLowerCase().includes(query) ||
      a.tags.some((t) => t.toLowerCase().includes(query)),
  )
}

export async function fetchArticleById(id: string): Promise<Article> {
  if (id === 'slow') {
    await delay(1500)
    return SLOW_ARTICLE
  }
  if (id === 'error') {
    throw new Error(`Failed to load article "${id}" — simulated server error`)
  }
  const article = ARTICLES.find((a) => a.id === id)
  if (!article) throw notFound()
  return article
}

export async function fetchRelatedArticles(id: string): Promise<Article[]> {
  await delay(800)
  return ARTICLES.filter((a) => a.id !== id).slice(0, 3)
}

// createServerFn — reads HTTP request context (cookies/headers), called from client or server
export const getServerContext = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ theme: string | null; acceptLanguage: string | null }> => ({
    theme: getCookie('theme') ?? null,
    acceptLanguage: getRequestHeader('accept-language') ?? null,
  }),
)
