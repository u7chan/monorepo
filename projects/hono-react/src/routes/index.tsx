import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

function RouteComponent() {
  return <h2 className='p-4 font-semibold text-xl'>Home</h2>
}
