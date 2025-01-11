import { createLazyFileRoute } from '@tanstack/react-router'

export const Route = createLazyFileRoute('/about')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className='p-4'>
      <h2 className='mb-4 font-semibold text-xl'>About</h2>
    </div>
  )
}
