import { createFileRoute } from '@tanstack/react-router'

import { Profile } from '../components/Profile'

export const Route = createFileRoute('/profile')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Profile />
}
