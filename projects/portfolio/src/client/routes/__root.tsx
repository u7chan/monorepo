import React from 'react'
import { createRootRoute, Outlet } from '@tanstack/react-router'

import { Layout } from '@/client/components/Layout'
import { useResponsive } from '@/client//components/hooks/useResponsive'

const TanStackRouterDevtoolsPanel = import.meta.env.PROD
  ? () => null // Render nothing in production
  : React.lazy(() =>
      // Lazy load in development
      import('@tanstack/router-devtools').then((res) => ({
        default: res.TanStackRouterDevtools,
      })),
    )

export const Route = createRootRoute({
  component: () => <Root />,
})

function Root() {
  const { mobile } = useResponsive()
  return (
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
      {!mobile && <TanStackRouterDevtoolsPanel position='bottom-right' />}
    </>
  )
}
