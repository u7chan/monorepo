import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { requireSignedIn } from '#/client/app/require-signed-in'

const ChatCompare = lazy(() =>
  import('#/client/features/chat-compare/page').then((module) => ({ default: module.ChatCompare }))
)

export const Route = createFileRoute('/chat-compare')({
  beforeLoad: requireSignedIn,
  component: RouteComponent,
})

function RouteComponent() {
  return <ChatCompare />
}
