import { createFileRoute } from '@tanstack/react-router'

import { Chat } from '#/client/components/pages/Chat'

export const Route = createFileRoute('/chat')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Chat />
}
