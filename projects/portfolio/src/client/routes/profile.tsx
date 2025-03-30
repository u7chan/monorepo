import { createFileRoute } from '@tanstack/react-router'

import { Profile } from '../components/pages/Profile'

export const Route = createFileRoute('/profile')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Profile />
}
