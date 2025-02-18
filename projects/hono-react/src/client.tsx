import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { ResponsiveProvider } from './components/ResponsiveProvider'

const router = createRouter({ routeTree })

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const dom = document.getElementById('root')
if (dom) {
  const root = createRoot(dom)
  root.render(
    <ResponsiveProvider>
      <RouterProvider router={router} />
    </ResponsiveProvider>,
  )
}
