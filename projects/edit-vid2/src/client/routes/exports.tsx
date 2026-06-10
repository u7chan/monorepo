import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const ExportsPage = lazy(() => import('#/client/features/exports/page').then((m) => ({ default: m.ExportsPage })))

export const Route = createFileRoute('/exports')({
  component: ExportsPage,
})
