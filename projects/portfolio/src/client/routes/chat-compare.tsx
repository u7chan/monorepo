import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const ChatCompare = lazy(() =>
  import('#/client/pages/chat-compare').then((module) => ({ default: module.ChatCompare }))
)

export const Route = createFileRoute('/chat-compare')({
  component: RouteComponent,
})

function RouteComponent() {
  return <ChatCompare />
}
