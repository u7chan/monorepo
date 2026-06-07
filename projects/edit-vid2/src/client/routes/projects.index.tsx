import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const ProjectsPage = lazy(() => import('#/client/features/projects/page').then((m) => ({ default: m.ProjectsPage })))

export const Route = createFileRoute('/projects/')({
  component: ProjectsPage,
})
