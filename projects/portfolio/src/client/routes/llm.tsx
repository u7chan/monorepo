import { Llm } from '#/client/pages/Llm'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/llm')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Llm />
}
