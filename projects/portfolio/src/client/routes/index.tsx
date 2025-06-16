import { createFileRoute } from '@tanstack/react-router'

import { Home } from '#/client/components/pages/Home'

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Home />
}
