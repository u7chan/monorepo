import { createLazyFileRoute } from '@tanstack/react-router'
import { Chat } from '../components/Chat'

export const Route = createLazyFileRoute('/chat')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className='p-4'>
      <Chat />
    </div>
  )
}
