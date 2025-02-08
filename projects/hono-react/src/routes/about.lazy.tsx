import { createLazyFileRoute } from '@tanstack/react-router'
import { About } from '../components/About'

export const Route = createLazyFileRoute('/about')({
  component: RouteComponent,
})

function RouteComponent() {
  return <About />
}
