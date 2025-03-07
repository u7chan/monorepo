import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div>
      <h2 className='p-4 font-semibold text-xl'>Home</h2>
    </div>
  )
}
