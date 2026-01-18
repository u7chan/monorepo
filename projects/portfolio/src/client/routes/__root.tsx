import { AppLayout } from '#/client/components/app-layout'
import { AboutIcon } from '#/client/components/svg/about-icon'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { DashboardIcon } from '#/client/components/svg/dashboard-icon'
import { LlmIcon } from '#/client/components/svg/llm-icon'
import { createRootRoute, Outlet } from '@tanstack/react-router'
import React from 'react'

const TanStackRouterDevtoolsPanel = import.meta.env.PROD
  ? () => null // Render nothing in production
  : React.lazy(() =>
      // Lazy load in development
      import('@tanstack/react-router-devtools').then((res) => ({
        default: res.TanStackRouterDevtools,
      }))
    )

export const Route = createRootRoute({
  component: () => <Root />,
})

function Root() {
  return (
    <>
      <AppLayout
        version={import.meta.env.VITE_APP_VERSION || ''}
        menuItems={[
          { label: 'Home', icon: <DashboardIcon size={24} />, to: '/' },
          { label: 'About', icon: <AboutIcon size={18} />, to: '/about' },
          { label: 'Diff', icon: <LlmIcon size={24} />, to: '/diff' },
          { label: 'Chat', icon: <ChatbotIcon size={26} />, to: '/chat' },
        ]}
      >
        <Outlet />
      </AppLayout>
      <TanStackRouterDevtoolsPanel position='bottom-right' />
    </>
  )
}
