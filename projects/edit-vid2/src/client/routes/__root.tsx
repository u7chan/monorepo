import { Outlet, createRootRoute } from '@tanstack/react-router'
import { Clapperboard, Download, Film } from 'lucide-react'
import { Suspense, lazy } from 'react'
import { AppLayout } from '#/client/app/app-layout'
import { RouteLoading } from '#/client/app/route-loading'

const TanStackRouterDevtoolsPanel = import.meta.env.PROD
  ? () => null
  : lazy(() =>
      import('@tanstack/react-router-devtools').then((res) => ({
        default: res.TanStackRouterDevtools,
      }))
    )

export const Route = createRootRoute({
  component: () => <Root />,
})

function Root() {
  const menuItems = [
    { label: '動画', icon: <Film size={20} />, to: '/videos' },
    { label: 'プロジェクト', icon: <Clapperboard size={20} />, to: '/projects' },
    { label: '書き出し', icon: <Download size={20} />, to: '/exports' },
  ]

  return (
    <>
      <AppLayout menuItems={menuItems}>
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </AppLayout>
      <TanStackRouterDevtoolsPanel position='bottom-right' />
    </>
  )
}
