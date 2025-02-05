import { createLazyFileRoute } from '@tanstack/react-router'

export const Route = createLazyFileRoute('/about')({
  component: RouteComponent,
})

function RouteComponent() {
  return <h2 className='font-semibold text-xl'>About</h2>
}
