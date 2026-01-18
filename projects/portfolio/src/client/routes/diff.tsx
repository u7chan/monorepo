import { Diff } from '#/client/pages/diff'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/diff')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Diff />
}
