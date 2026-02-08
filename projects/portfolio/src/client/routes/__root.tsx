import { AppLayout } from '#/client/components/app-layout'
import { RouteLoading } from '#/client/components/route-loading'
import { AboutIcon } from '#/client/components/svg/about-icon'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { DashboardIcon } from '#/client/components/svg/dashboard-icon'
import { DiffIcon } from '#/client/components/svg/diff-icon'
import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Suspense, lazy } from 'react'

const TanStackRouterDevtoolsPanel = import.meta.env.PROD
  ? () => null // Render nothing in production
  : lazy(() =>
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
          { label: 'Diff', icon: <DiffIcon size={20} />, to: '/diff' },
          { label: 'Chat', icon: <ChatbotIcon size={26} />, to: '/chat' },
        ]}
      >
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </AppLayout>
      <TanStackRouterDevtoolsPanel position='bottom-right' />
    </>
  )
}
