import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const Diff = lazy(() => import('#/client/pages/diff').then((module) => ({ default: module.Diff })))

export const Route = createFileRoute('/diff')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Diff />
}
