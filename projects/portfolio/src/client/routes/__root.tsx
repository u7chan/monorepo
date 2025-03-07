import React from 'react'
import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Layout } from '../components/Layout'

const TanStackRouterDevtoolsPanel = import.meta.env.PROD
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
        version={import.meta.env.VITE_APP_VERSION ? `v.${import.meta.env.VITE_APP_VERSION}` : ''}
        menuItems={[
          { label: 'Home', to: '/' },
          { label: 'About', to: '/about' },
          { label: 'Profile', to: '/profile' },
          { label: 'Chat', to: '/chat' },
        ]}
      >
        <Outlet />
      </Layout>
      <TanStackRouterDevtoolsPanel position='bottom-right' />
    </>
  ),
})
