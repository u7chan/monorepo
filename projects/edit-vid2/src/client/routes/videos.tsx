import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'

const VideosPage = lazy(() => import('#/client/features/videos/page').then((m) => ({ default: m.VideosPage })))

export const Route = createFileRoute('/videos')({
  component: VideosPage,
})
