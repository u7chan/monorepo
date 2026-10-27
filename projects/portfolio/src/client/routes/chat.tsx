import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { z } from 'zod'
import { requireSignedIn } from '#/client/app/require-signed-in'

const Chat = lazy(() => import('#/client/features/chat/page').then((module) => ({ default: module.Chat })))

export const Route = createFileRoute('/chat')({
  validateSearch: z.object({
    conversationId: z.preprocess((value) => {
      if (typeof value !== 'string') {
        return undefined
      }

      return value.length > 0 ? value : undefined
    }, z.string().optional()),
  }),
  beforeLoad: requireSignedIn,
  component: RouteComponent,
})

function RouteComponent() {
  return <Chat />
}
