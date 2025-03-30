import { createFileRoute } from '@tanstack/react-router'

import { About } from '@/client/components/pages/About'

export const Route = createFileRoute('/about')({
  component: RouteComponent,
})

function RouteComponent() {
  return <About />
}
