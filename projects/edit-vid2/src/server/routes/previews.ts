import { existsSync, mkdirSync } from 'node:fs'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  buildPreviewCacheKey,
  clearPreviewCache as defaultClearPreviewCache,
  generateSubtitlePreview as defaultGenerateSubtitlePreview,
} from '#/server/features/preview/preview-service'
import { getProjectById } from '#/server/features/projects/project-repository'
import { getTemplateById } from '#/server/features/templates/template-repository'
import { getVideoAssetById } from '#/server/features/videos/video-repository'
import type { HonoEnv } from '#/server/routes/shared'
import { toSubtitleStyle } from '#/shared/schemas'

const previewSchema = z.object({
  sourceTime: z.number().min(0),
  text: z.string().min(1),
  templateId: z.string(),
})

const defaultStyle = {
  fontFamilyId: 'default',
  fontSize: 48,
  fontColor: '#FFFFFF',
  bold: false,
  italic: false,
  outlineColor: '#000000',
  outlineWidth: 2,
  shadow: { enabled: false, color: '#000000', offsetX: 0, offsetY: 0, blur: 0 },
  backgroundBox: { enabled: false, color: '#000000', opacity: 0.6, padding: 4 },
  position: 'bottom' as const,
  margin: { x: 0, y: 0 },
}

type PreviewRouteDeps = {
  exists: (path: string) => boolean
  ensureDir: (path: string) => void
  getCacheDir: (projectId: string) => string
  generateSubtitlePreview: typeof defaultGenerateSubtitlePreview
  clearProjectPreviews: (projectId: string) => void
}

const defaultPreviewRouteDeps: PreviewRouteDeps = {
  exists: existsSync,
  ensureDir: (path) => mkdirSync(path, { recursive: true }),
  getCacheDir: (projectId) => `data/projects/${projectId}/previews`,
  generateSubtitlePreview: defaultGenerateSubtitlePreview,
  clearProjectPreviews: defaultClearPreviewCache,
}

function createPreviewRoutes(deps: Partial<PreviewRouteDeps> = {}) {
  const resolvedDeps = { ...defaultPreviewRouteDeps, ...deps }
  const previewRoutes = new Hono<HonoEnv>()

  previewRoutes.post('/subtitle', sValidator('json', previewSchema), async (c) => {
    const db = c.var.db
    const projectId = c.req.param('projectId')
    if (!projectId) {
      return c.json({ error: 'projectId required' }, 400)
    }
    const project = getProjectById(db, projectId)
    if (!project) {
      return c.json({ error: 'project not found' }, 404)
    }

    const videoAsset = getVideoAssetById(db, project.videoAssetId)
    if (!videoAsset || !videoAsset.width || !videoAsset.height) {
      return c.json({ error: 'video asset not ready' }, 400)
    }

    if (!videoAsset.storagePath) {
      return c.json({ error: 'video storage path not set' }, 400)
    }

    const body = c.req.valid('json')
    const template = getTemplateById(db, body.templateId)
    const style = template ? toSubtitleStyle(template) : defaultStyle

    const cacheKey = buildPreviewCacheKey(projectId, videoAsset.id, body.sourceTime, style, body.text, 1)

    const cacheDir = resolvedDeps.getCacheDir(projectId)
    if (!resolvedDeps.exists(cacheDir)) {
      resolvedDeps.ensureDir(cacheDir)
    }
    const outputPath = `${cacheDir}/${cacheKey}.jpg`

    if (resolvedDeps.exists(outputPath)) {
      return c.json({ path: outputPath, cached: true })
    }

    const success = await resolvedDeps.generateSubtitlePreview({
      videoPath: videoAsset.storagePath,
      outputPath,
      sourceTime: body.sourceTime,
      text: body.text,
      videoWidth: videoAsset.width,
      videoHeight: videoAsset.height,
      defaultStyle: style,
    })

    if (!success) {
      return c.json({ error: 'preview generation failed' }, 500)
    }

    return c.json({ path: outputPath, cached: false })
  })

  previewRoutes.delete('/', (c) => {
    const db = c.var.db
    const projectId = c.req.param('projectId')
    if (!projectId) {
      return c.json({ error: 'projectId required' }, 400)
    }
    const project = getProjectById(db, projectId)
    if (!project) {
      return c.json({ error: 'project not found' }, 404)
    }

    resolvedDeps.clearProjectPreviews(projectId)
    return c.body(null, 204)
  })

  return previewRoutes
}

const previewRoutes = createPreviewRoutes()

export { createPreviewRoutes, previewRoutes }
