import { Layout } from '#/client/components/Layout'
import { AboutIcon } from '#/client/components/svg/AboutIcon'
import { ChatbotIcon } from '#/client/components/svg/ChatbotIcon'
import { DashboardIcon } from '#/client/components/svg/DashboardIcon'
import { LlmIcon } from '#/client/components/svg/LlmIcon'
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
      <Layout
        version={import.meta.env.VITE_APP_VERSION || ''}
        menuItems={[
          { label: 'Home', icon: <DashboardIcon size={24} />, to: '/' },
          { label: 'About', icon: <AboutIcon size={18} />, to: '/about' },
          { label: 'LLM', icon: <LlmIcon size={24} />, to: '/llm' },
          { label: 'Chat', icon: <ChatbotIcon size={26} />, to: '/chat' },
        ]}
      >
        <Outlet />
      </Layout>
      <TanStackRouterDevtoolsPanel position='bottom-right' />
    </>
  )
}
