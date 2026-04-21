import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { z } from 'zod'

const Chat = lazy(() => import('#/client/pages/chat').then((module) => ({ default: module.Chat })))

export const Route = createFileRoute('/chat')({
  validateSearch: z.object({
    conversationId: z.preprocess((value) => {
      if (typeof value !== 'string') {
        return undefined
      }

      return value.length > 0 ? value : undefined
    }, z.string().optional()),
  }),
  component: RouteComponent,
})

function RouteComponent() {
  return <Chat />
}
