/// <reference types="vite/client" />
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import * as React from 'react'
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary'
import { NotFound } from '~/components/NotFound'
import appCss from '~/styles/app.css?url'
import { seo } from '~/utils/seo'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ...seo({
        title: 'TanStack Start — Full-Stack React Framework',
        description: 'Type-safe, client-first, full-stack React framework.',
      }),
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
        <TanStackRouterDevtools position="bottom-right" />
        <Scripts />
      </body>
    </html>
  )
}

function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-950/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 group">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center text-white font-black text-sm shadow-sm group-hover:shadow-cyan-400/40 transition-shadow">
            T
          </div>
          <span className="font-semibold text-sm tracking-tight text-gray-900 dark:text-gray-100">
            TanStack Start
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          <NavLink to="/">Home</NavLink>
          <NavLink to="/articles">Articles</NavLink>
        </nav>
      </div>
    </header>
  )
}

function NavLink({
  to,
  children,
}: {
  to: string
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      activeProps={{ className: 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100' }}
      activeOptions={{ exact: true }}
      className="px-3 py-1.5 rounded-md text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
    >
      {children}
    </Link>
  )
}

function Footer() {
  return (
    <footer className="border-t border-gray-200 dark:border-gray-800 py-6">
      <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-400">
        <span>Built with TanStack Start &amp; React 19</span>
        <span>© {new Date().getFullYear()}</span>
      </div>
    </footer>
  )
}
