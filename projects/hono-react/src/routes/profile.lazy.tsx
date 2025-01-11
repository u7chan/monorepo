import { createLazyFileRoute } from '@tanstack/react-router'

import { Profile } from '../components/Profile'

export const Route = createLazyFileRoute('/profile')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className='p-4'>
      <Profile />
    </div>
  )
}
