import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { createRoot } from 'react-dom/client'
import { routeTree } from './routeTree.gen'

let augmentedRouteTree = routeTree

if (import.meta.env.DEV) {
  const module = (await new Function(
    "return import('./routes/_debug.svg-catalog')"
  )()) as typeof import('./routes/_debug.svg-catalog')
  augmentedRouteTree = routeTree.addChildren([module.Route]) as any
}

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
