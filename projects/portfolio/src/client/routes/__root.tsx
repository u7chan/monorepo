import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Suspense, lazy } from 'react'
import { AppLayout } from '#/client/app/app-layout'
import { buildMenuItems } from '#/client/app/menu-items'
import { RouteLoading } from '#/client/app/route-loading'
import { useMetaProps } from '#/client/shared/hooks/use-meta-props'

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
  const { email } = useMetaProps()

  return (
    <>
      <AppLayout version={import.meta.env.VITE_APP_VERSION || ''} menuItems={buildMenuItems({ isSignedIn: !!email })}>
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </AppLayout>
      <TanStackRouterDevtoolsPanel position='top-right' />
    </>
  )
}
