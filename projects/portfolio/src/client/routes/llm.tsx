import { createFileRoute } from '@tanstack/react-router'

import { Llm } from '#/client/pages/Llm'

export const Route = createFileRoute('/llm')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Llm />
}
