import { createFileRoute } from '@tanstack/react-router'
import { About } from '#/client/pages/About'

export const Route = createFileRoute('/about')({
  component: RouteComponent,
})

function RouteComponent() {
  return <About />
}
