import React from 'react'
import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

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
      <div className='flex gap-2 p-2'>
        <Link to='/' className='[&.active]:font-bold'>
          Home
        </Link>{' '}
        <Link to='/about' className='[&.active]:font-bold'>
          About
        </Link>{' '}
        <Link to='/profile' className='[&.active]:font-bold'>
          Profile
        </Link>
      </div>
      <hr />
      <Outlet />
      <TanStackRouterDevtoolsPanel />
    </>
  ),
})
