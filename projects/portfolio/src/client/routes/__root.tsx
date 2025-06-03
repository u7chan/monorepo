import { Layout } from '@/client/components/Layout'
import { useResponsive } from '@/client/components/hooks/useResponsive'
import { ChatbotIcon } from '@/client/components/svg/ChatbotIcon'
import { Outlet, createRootRoute } from '@tanstack/react-router'
import React from 'react'

const TanStackRouterDevtoolsPanel = import.meta.env.PROD
  ? () => null // Render nothing in production
  : React.lazy(() =>
      // Lazy load in development
      import('@tanstack/react-router-devtools').then((res) => ({
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
        version={import.meta.env.VITE_APP_VERSION || ''}
        menuItems={[
          { label: 'Home', icon: <ChatbotIcon size={28} />, to: '/' },
          { label: 'About', icon: <ChatbotIcon size={28} />, to: '/about' },
          { label: 'Profile', icon: <ChatbotIcon size={28} />, to: '/profile' },
          { label: 'Chat', icon: <ChatbotIcon size={28} />, to: '/chat' },
        ]}
      >
        <Outlet />
      </Layout>
      {!mobile && <TanStackRouterDevtoolsPanel position='bottom-right' />}
    </>
  )
}
