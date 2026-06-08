import { mkdirSync, writeFileSync } from 'node:fs'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { uuidv7 } from 'uuidv7'
import { generateThumbnail, probeVideo } from '#/server/features/ffmpeg/ffmpeg-service'
import {
  createVideoAsset,
  getVideoAssetById,
  getVideoAssets,
  softDeleteVideoAsset,
  updateVideoAsset,
} from '#/server/features/videos/video-repository'
import type { HonoEnv } from '#/server/routes/shared'
import { UpdateVideoAssetSchema } from '#/shared/schemas'

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

  const maxBytes = Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024
  if (file.size > maxBytes) {
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

  const id = uuidv7()
  const dir = `data/videos/${id}`
  mkdirSync(dir, { recursive: true })

  const storagePath = `${dir}/source${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  writeFileSync(storagePath, buffer)

  const displayName = formData.get('displayName')?.toString() ?? file.name
  const record = createVideoAsset(db, {
    id,
    originalFilename: file.name,
    displayName,
    storagePath,
    status: 'processing',
  })

  // Run ffprobe async
  probeVideo(storagePath)
    .then((probeResult) => {
      const thumbnailPath = `${dir}/thumbnail.jpg`
      generateThumbnail(storagePath, thumbnailPath, probeResult.duration).catch(() => {})

      const status = probeResult.duration ? 'ready' : 'failed'
      updateVideoAsset(db, id, {
        ...probeResult,
        thumbnailPath: probeResult.duration ? thumbnailPath : null,
        status,
      })
    })
    .catch(() => {
      updateVideoAsset(db, id, { status: 'failed' })
    })

  return c.json(record, 201)
})

export { videoRoutes }
