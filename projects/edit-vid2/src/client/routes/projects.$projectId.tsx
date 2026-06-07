import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const EditorPage = lazy(() => import('#/client/features/editor/page').then((m) => ({ default: m.EditorPage })))

export const Route = createFileRoute('/projects/$projectId')({
  component: EditorPage,
})
