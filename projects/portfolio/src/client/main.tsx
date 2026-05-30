import './app/configure-zod'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { createRoot } from 'react-dom/client'
import { routeTree } from './routeTree.gen'

const debugRoute = import.meta.env.DEV ? (await import('./routes/_debug.svg-catalog')).Route : null

const augmentedRouteTree = debugRoute
  ? routeTree.addChildren([...(Array.isArray(routeTree.children) ? routeTree.children : []), debugRoute])
  : routeTree

const router = createRouter({ routeTree: augmentedRouteTree })

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const queryClient = new QueryClient()

const dom = document.getElementById('root')
if (dom) {
  const root = createRoot(dom)
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
