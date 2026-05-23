import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Suspense, lazy } from 'react'
import { AppLayout } from '#/client/components/app-layout'
import { RouteLoading } from '#/client/components/route-loading'
import { AboutIcon } from '#/client/components/svg/about-icon'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { CompareIcon } from '#/client/components/svg/compare-icon'
import { DashboardIcon } from '#/client/components/svg/dashboard-icon'
import { DiffIcon } from '#/client/components/svg/diff-icon'
import { SparkleIcon } from '#/client/components/svg/sparkle-icon'

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
  const menuItems = [
    { label: 'Home', icon: <DashboardIcon size={24} />, to: '/' },
    { label: 'About', icon: <AboutIcon size={18} />, to: '/about' },
    { label: 'Diff', icon: <DiffIcon size={20} />, to: '/diff' },
    { label: 'Chat', icon: <ChatbotIcon size={26} />, to: '/chat' },
    { label: 'Compare', icon: <CompareIcon size={22} />, to: '/chat-compare' },
  ]

  if (import.meta.env.DEV) {
    menuItems.push({
      label: 'SVG Catalog',
      icon: <SparkleIcon size={20} />,
      to: '/debug/svg-catalog' as any,
    })
  }

  return (
    <>
      <AppLayout version={import.meta.env.VITE_APP_VERSION || ''} menuItems={menuItems}>
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </AppLayout>
      <TanStackRouterDevtoolsPanel position='bottom-right' />
    </>
  )
}
