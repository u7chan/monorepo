import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const About = lazy(() => import('#/client/pages/about').then((module) => ({ default: module.About })))

export const Route = createFileRoute('/about')({
  component: RouteComponent,
})

function RouteComponent() {
  return <About />
}
