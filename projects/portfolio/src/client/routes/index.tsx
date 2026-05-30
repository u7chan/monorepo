import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const Home = lazy(() => import('#/client/features/home/page').then((module) => ({ default: module.Home })))

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

function RouteComponent() {
  return <Home />
}
