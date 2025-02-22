import React from 'react'
import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { Layout } from '../components/Layout'

const TanStackRouterDevtoolsPanel =
  process.env.NODE_ENV === 'production'
    ? () => null // Render nothing in production
    : React.lazy(() =>
        // Lazy load in development
        import('@tanstack/router-devtools').then((res) => ({
          default: res.TanStackRouterDevtools,
        })),
      )

export const Route = createRootRoute({
  component: () => (
    <>
      <Layout
        title='Portfolio'
        menuItems={[
          { label: 'Home', to: '/' },
          { label: 'About', to: '/about' },
          { label: 'Profile', to: '/profile' },
          { label: 'Chat', to: '/chat' },
        ]}
      >
        <Outlet />
      </Layout>
      <TanStackRouterDevtoolsPanel />
    </>
  ),
})
