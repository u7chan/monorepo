import { Await, Link, createFileRoute, defer } from '@tanstack/react-router'
import { Suspense } from 'react'
import { SsrBadge } from '~/components/SsrBadge'
import type { Article } from '~/data/articles'
import { fetchArticleById, fetchRelatedArticles } from '~/data/articles'

export const Route = createFileRoute('/articles/$articleId')({
  loader: async ({ params }) => {
    const article = await fetchArticleById(params.articleId)
    const related = defer(fetchRelatedArticles(params.articleId))
    return {
      serverTimestamp: new Date().toISOString(),
      article,
      related,
    }
  },

  pendingComponent: PendingComponent,
  errorComponent: ArticleErrorComponent,
  notFoundComponent: ArticleNotFoundComponent,

  component: ArticleDetailPage,
})

function ArticleDetailPage() {
  const { serverTimestamp, article, related } = Route.useLoaderData()
  const { articleId } = Route.useParams()

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-6 flex items-center gap-3 flex-wrap">
        <SsrBadge renderedAt={serverTimestamp} />
        <span className="text-xs font-mono text-gray-400">
          Path param:{' '}
          <span className="text-gray-600 dark:text-gray-300">articleId = "{articleId}"</span>
        </span>
      </div>

      <div className="mb-6">
        <Link
          to="/articles"
          search={{ q: undefined }}
          className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        >
          <svg
            className="w-3 h-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Articles
        </Link>
      </div>

      <article className="mb-10">
        <div className="flex flex-wrap gap-1 mb-3">
          {article.tags.map((tag: string) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono"
            >
              #{tag}
            </span>
          ))}
          <span className="px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-800 text-gray-400 font-mono">
            {article.lang}
          </span>
        </div>
        <h1 className="text-2xl font-black text-gray-900 dark:text-white tracking-tight mb-3">
          {article.title}
        </h1>
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-6 leading-relaxed">
          {article.summary}
        </p>
        <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{article.body}</p>
      </article>

      {/* Related Articles — 機能7: defer + Suspense */}
      <div className="border-t border-gray-200 dark:border-gray-800 pt-6">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
          Related Articles
          <span className="ml-2 text-gray-400 font-normal normal-case">(defer + Suspense)</span>
        </h2>
        <Suspense fallback={<RelatedSkeleton />}>
          <Await promise={related}>
            {(articles: Article[]) => (
              <div className="flex flex-col gap-2">
                {articles.map((a) => (
                  <Link
                    key={a.id}
                    to="/articles/$articleId"
                    params={{ articleId: a.id }}
                    className="group flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-800 hover:border-cyan-300 dark:hover:border-cyan-800 transition-colors"
                  >
                    <span className="text-sm text-gray-800 dark:text-gray-200 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors">
                      {a.title}
                    </span>
                    <svg
                      className="w-3.5 h-3.5 text-gray-400 group-hover:text-cyan-500 transition-colors shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                ))}
              </div>
            )}
          </Await>
        </Suspense>
      </div>
    </div>
  )
}

function RelatedSkeleton() {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-11 rounded-lg bg-gray-100 dark:bg-gray-800" />
      ))}
    </div>
  )
}

function PendingComponent() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="w-8 h-8 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading article from server…</p>
        <p className="text-xs text-gray-400 font-mono">(pendingComponent — loader has 1.5s delay)</p>
      </div>
    </div>
  )
}

function ArticleErrorComponent({ error }: { error: Error }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="p-6 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30">
        <div className="text-xs font-semibold text-red-500 uppercase tracking-wide mb-3">
          SSR Error — errorComponent
        </div>
        <h2 className="text-lg font-bold text-red-700 dark:text-red-400 mb-2">
          Data fetch failed on the server
        </h2>
        <p className="text-sm text-red-600 dark:text-red-400 font-mono mb-4">{error.message}</p>
        <Link
          to="/articles"
          search={{ q: undefined }}
          className="inline-flex px-3 py-1.5 rounded-md text-sm font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
        >
          Back to Articles
        </Link>
      </div>
    </div>
  )
}

function ArticleNotFoundComponent() {
  const { articleId } = Route.useParams()
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="p-6 rounded-xl border border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/30">
        <div className="text-xs font-semibold text-orange-500 uppercase tracking-wide mb-3">
          404 Not Found — notFoundComponent
        </div>
        <h2 className="text-lg font-bold text-orange-700 dark:text-orange-400 mb-2">
          Article not found
        </h2>
        <p className="text-sm text-orange-600 dark:text-orange-400 font-mono mb-1">
          articleId: "{articleId}"
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          このIDを持つ記事は存在しません。<code className="font-mono">notFound()</code>{' '}
          を throw することで、このコンポーネントが表示されます。
        </p>
        <Link
          to="/articles"
          search={{ q: undefined }}
          className="inline-flex px-3 py-1.5 rounded-md text-sm font-medium bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-900/60 transition-colors"
        >
          Back to Articles
        </Link>
      </div>
    </div>
  )
}
