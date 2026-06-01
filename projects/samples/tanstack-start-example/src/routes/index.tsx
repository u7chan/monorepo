import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

const DEMOS = [
  {
    to: '/articles' as const,
    search: {},
    params: undefined,
    label: 'Articles List',
    features: ['SSR timestamp', 'Query params (?q=)', 'Cookie & Accept-Language'],
    desc: '一覧ページ。SSRバッジ・検索パラメーター・Cookie/ヘッダー読み取りを確認できます。',
  },
  {
    to: '/articles/$articleId' as const,
    search: undefined,
    params: { articleId: 'getting-started' },
    label: 'Article Detail',
    features: ['Path params ($articleId)', 'Streaming (defer + Suspense)'],
    desc: '詳細ページ。パスパラメーターと関連記事の遅延ストリーミングを確認できます。',
  },
  {
    to: '/articles/$articleId' as const,
    search: undefined,
    params: { articleId: 'slow' },
    label: 'Slow Loading',
    features: ['pendingComponent', '1.5s delay'],
    desc: 'ローダーが1.5秒遅延。pendingComponent（ローディング表示）を確認できます。',
  },
  {
    to: '/articles/$articleId' as const,
    search: undefined,
    params: { articleId: 'error' },
    label: 'SSR Error',
    features: ['errorComponent', 'Server-side throw'],
    desc: 'サーバー関数が意図的にエラーを throw。errorComponent での表示を確認できます。',
  },
  {
    to: '/articles/$articleId' as const,
    search: undefined,
    params: { articleId: 'not-a-real-id' },
    label: '404 Not Found',
    features: ['notFoundComponent', 'notFound()'],
    desc: '存在しないIDを指定。notFoundComponent での404表示を確認できます。',
  },
]

function Home() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <div className="mb-10">
        <h1 className="text-3xl font-black text-gray-900 dark:text-white mb-3 tracking-tight">
          TanStack Start SSR Demo
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm leading-relaxed">
          TanStack Start の主要SSR機能をシンプルな記事アプリでデモするサンプルです。
          各リンクをクリックして機能を確認してください。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {DEMOS.map((demo) => (
          <Link
            key={demo.label}
            to={demo.to}
            params={demo.params as never}
            search={demo.search as never}
            className="group block p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 hover:border-cyan-300 dark:hover:border-cyan-800 hover:shadow-sm transition-all"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-semibold text-sm text-gray-900 dark:text-white group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors">
                    {demo.label}
                  </span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{demo.desc}</p>
                <div className="flex flex-wrap gap-1.5">
                  {demo.features.map((f) => (
                    <span
                      key={f}
                      className="px-2 py-0.5 rounded text-xs bg-cyan-50 dark:bg-cyan-950/40 text-cyan-700 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-900 font-mono"
                    >
                      {f}
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
        ))}
      </div>
    </div>
  )
}
