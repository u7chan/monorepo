import { mkdirSync, writeFileSync } from 'node:fs'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { uuidv7 } from 'uuidv7'
import {
  generateThumbnail as defaultGenerateThumbnail,
  probeVideo as defaultProbeVideo,
} from '#/server/features/ffmpeg/ffmpeg-service'
import {
  createVideoAsset,
  getVideoAssetById,
  getVideoAssets,
  softDeleteVideoAsset,
  updateVideoAsset,
} from '#/server/features/videos/video-repository'
import type { HonoEnv } from '#/server/routes/shared'
import { UpdateVideoAssetSchema } from '#/shared/schemas'

type VideoRouteDeps = {
  createId: () => string
  getMaxUploadBytes: () => number
  getVideoDir: (id: string) => string
  ensureDir: (path: string) => void
  writeVideoFile: (path: string, file: File) => Promise<void>
  probeVideo: typeof defaultProbeVideo
  generateThumbnail: typeof defaultGenerateThumbnail
  scheduleVideoProcessing: (task: () => Promise<void>) => void
}

const defaultVideoRouteDeps: VideoRouteDeps = {
  createId: uuidv7,
  getMaxUploadBytes: () => Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024,
  getVideoDir: (id) => `data/videos/${id}`,
  ensureDir: (path) => mkdirSync(path, { recursive: true }),
  writeVideoFile: async (path, file) => {
    const buffer = Buffer.from(await file.arrayBuffer())
    writeFileSync(path, buffer)
  },
  probeVideo: defaultProbeVideo,
  generateThumbnail: defaultGenerateThumbnail,
  scheduleVideoProcessing: (task) => {
    task().catch(() => {})
  },
}

function createVideoRoutes(deps: Partial<VideoRouteDeps> = {}) {
  const resolvedDeps = { ...defaultVideoRouteDeps, ...deps }
  const videoRoutes = new Hono<HonoEnv>()

  videoRoutes.get('/', (c) => {
    const db = c.var.db
    const videos = getVideoAssets(db)
    return c.json(videos)
  })

  videoRoutes.get('/:videoAssetId', (c) => {
    const db = c.var.db
    const video = getVideoAssetById(db, c.req.param('videoAssetId'))
    if (!video) {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json(video)
  })

  videoRoutes.patch('/:videoAssetId', sValidator('json', UpdateVideoAssetSchema), (c) => {
    const db = c.var.db
    const id = c.req.param('videoAssetId')
    const existing = getVideoAssetById(db, id)
    if (!existing) {
      return c.json({ error: 'not found' }, 404)
    }
    const updated = updateVideoAsset(db, id, c.req.valid('json'))
    return c.json(updated)
  })

  videoRoutes.delete('/:videoAssetId', (c) => {
    const db = c.var.db
    const id = c.req.param('videoAssetId')
    const existing = getVideoAssetById(db, id)
    if (!existing) {
      return c.json({ error: 'not found' }, 404)
    }
    softDeleteVideoAsset(db, id)
    return c.body(null, 204)
  })

  videoRoutes.post('/', async (c) => {
    const db = c.var.db
    const formData = await c.req.formData()
    const file = formData.get('file')

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'file is required' }, 400)
    }

    if (file.size > resolvedDeps.getMaxUploadBytes()) {
      return c.json({ error: 'file too large' }, 413)
    }

    const extMap: Record<string, string> = {
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
      'video/x-matroska': '.mkv',
    }
    const ext = extMap[file.type]
    if (!ext) {
      return c.json({ error: `unsupported format: ${file.type}` }, 400)
    }

    const id = resolvedDeps.createId()
    const dir = resolvedDeps.getVideoDir(id)
    resolvedDeps.ensureDir(dir)

    const storagePath = `${dir}/source${ext}`
    await resolvedDeps.writeVideoFile(storagePath, file)

    const displayName = formData.get('displayName')?.toString() ?? file.name
    const record = createVideoAsset(db, {
      id,
      originalFilename: file.name,
      displayName,
      storagePath,
      status: 'processing',
    })

    resolvedDeps.scheduleVideoProcessing(async () => {
      const probeResult = await resolvedDeps.probeVideo(storagePath).catch(() => null)
      if (!probeResult) {
        updateVideoAsset(db, id, { status: 'failed' })
        return
      }
      const thumbnailPath = `${dir}/thumbnail.jpg`
      resolvedDeps.generateThumbnail(storagePath, thumbnailPath, probeResult.duration).catch(() => {})

      const status = probeResult.duration ? 'ready' : 'failed'
      updateVideoAsset(db, id, {
        ...probeResult,
        thumbnailPath: probeResult.duration ? thumbnailPath : null,
        status,
      })
    })

    return c.json(record, 201)
  })

  return videoRoutes
}

const videoRoutes = createVideoRoutes()

export { createVideoRoutes, videoRoutes }
