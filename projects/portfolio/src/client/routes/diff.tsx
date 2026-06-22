import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { DEFAULT_DIFF_STATE, loadDiffState } from '#/client/shared/storage/diff-state'

const Diff = lazy(() => import('#/client/features/diff/page').then((module) => ({ default: module.Diff })))

export const Route = createFileRoute('/diff')({
  component: RouteComponent,
  loader: async () => {
    try {
      return (await loadDiffState()) ?? DEFAULT_DIFF_STATE
    } catch {
      return DEFAULT_DIFF_STATE
    }
  },
})

function RouteComponent() {
  const initialState = Route.useLoaderData()

  return <Diff initialState={initialState} />
}
