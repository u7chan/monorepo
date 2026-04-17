import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { SsrBadge } from '~/components/SsrBadge'
import type { Article } from '~/data/articles'
import { fetchArticles, getServerContext } from '~/data/articles'

export const Route = createFileRoute('/articles/')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),

  loaderDeps: ({ search }) => ({ q: search.q }),

  loader: async ({ deps }) => ({
    serverTimestamp: new Date().toISOString(),
    articles: await fetchArticles(deps.q),
    serverCtx: await getServerContext(),
  }),

  component: ArticlesPage,
})

function ArticlesPage() {
  const { serverTimestamp, articles, serverCtx } = Route.useLoaderData()
  const { q } = Route.useSearch()
  const navigate = useNavigate({ from: '/articles/' })

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-6">
        <SsrBadge renderedAt={serverTimestamp} />
      </div>

      {/* Server Context Panel — 機能5: Cookie/ヘッダー */}
      <div className="mb-6 p-4 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
        <div className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-2 uppercase tracking-wide">
          Server Context (Cookie &amp; Headers)
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs font-mono">
          <dt className="text-gray-500">Cookie: theme</dt>
          <dd className="text-gray-800 dark:text-gray-200">
            {serverCtx.theme ?? <span className="text-gray-400 italic">not set</span>}
          </dd>
          <dt className="text-gray-500">Accept-Language</dt>
          <dd className="text-gray-800 dark:text-gray-200 truncate">
            {serverCtx.acceptLanguage ?? <span className="text-gray-400 italic">not set</span>}
          </dd>
        </dl>
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
          DevTools で{' '}
          <code className="bg-amber-100 dark:bg-amber-900/50 px-1 rounded">theme=dark</code> Cookie
          を設定してリロードすると表示が変わります
        </p>
      </div>

      {/* Search — 機能2: Queryパラメーター */}
      <div className="mb-6">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
          Search (?q=)
        </label>
        <input
          type="search"
          defaultValue={q ?? ''}
          placeholder="Filter by title, summary, or tag…"
          onChange={(e) => {
            navigate({
              search: (prev) => ({ ...prev, q: e.target.value || undefined }),
              replace: true,
            })
          }}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-400 transition"
        />
      </div>

      {/* Article List */}
      <div className="flex flex-col gap-3">
        <div className="text-xs text-gray-400 font-mono">
          {articles.length} article{articles.length !== 1 ? 's' : ''}
          {q ? ` matching "${q}"` : ''}
        </div>
        {articles.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
            No articles found.
          </p>
        ) : (
          articles.map((article) => <ArticleRow key={article.id} article={article} />)
        )}
      </div>
    </div>
  )
}

function ArticleRow({ article }: { article: Article }) {
  return (
    <Link
      to="/articles/$articleId"
      params={{ articleId: article.id }}
      className="group block p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 hover:border-cyan-300 dark:hover:border-cyan-800 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-sm text-gray-900 dark:text-white group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors">
              {article.title}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-400 font-mono">
              {article.lang}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2 line-clamp-2">
            {article.summary}
          </p>
          <div className="flex flex-wrap gap-1">
            {article.tags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>
        <svg
          className="w-4 h-4 text-gray-400 group-hover:text-cyan-500 transition-colors shrink-0 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  )
}
