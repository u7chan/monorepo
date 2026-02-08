import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const Chat = lazy(() => import('#/client/pages/chat').then((module) => ({ default: module.Chat })))

export const Route = createFileRoute('/chat')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Chat />
}
