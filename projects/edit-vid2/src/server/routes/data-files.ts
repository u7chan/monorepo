import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { parseByteRange } from '#/server/features/http/byte-range'
import type { HonoEnv } from '#/server/routes/shared'

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

type FileSystemLike = {
  exists: (path: string) => boolean
  stat: (path: string) => { isFile: () => boolean; size: number }
  createReadStream: (path: string, options?: { start?: number; end?: number }) => Readable
}

export type DataFileRouteDeps = {
  videoRoot: string
  projectRoot: string
  fs: FileSystemLike
}

const defaultDataFileRouteDeps: DataFileRouteDeps = {
  videoRoot: 'data/videos',
  projectRoot: 'data/projects',
  fs: {
    exists: existsSync,
    stat: statSync,
    createReadStream,
  },
}

const PUBLIC_DATA_PREFIX = /^\/data\/(?:videos|projects)\//

function isWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root)
  const prefix = `${resolvedRoot}/`
  return target === resolvedRoot || target.startsWith(prefix)
}

function resolveRelativePath(c: Context): string {
  return decodeURIComponent(c.req.path.replace(PUBLIC_DATA_PREFIX, ''))
}

function serveFile(c: Context, root: string, fs: FileSystemLike) {
  const relativePath = resolveRelativePath(c)
  const filePath = resolve(root, relativePath)

  if (!isWithinRoot(root, filePath)) {
    return c.notFound()
  }

  if (!fs.exists(filePath)) {
    return c.notFound()
  }

  const stats = fs.stat(filePath)
  if (!stats.isFile()) {
    return c.notFound()
  }

  const { size } = stats
  const ext = extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  const rangeHeader = c.req.header('range')

  if (!rangeHeader) {
    const stream = fs.createReadStream(filePath)
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 200, {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
    })
  }

  const range = parseByteRange(rangeHeader, size)
  if (!range.ok) {
    return c.body('range not satisfiable', 416, {
      'Content-Range': `bytes */${size}`,
    })
  }

  const { start, end, length } = range
  const stream = fs.createReadStream(filePath, { start, end })
  return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 206, {
    'Content-Type': contentType,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
  })
}

export function createDataFileRoutes(deps: Partial<DataFileRouteDeps> = {}) {
  const resolvedDeps = { ...defaultDataFileRouteDeps, ...deps }
  const routes = new Hono<HonoEnv>()

  routes.get('/data/videos/:path{.*}', (c) => serveFile(c, resolvedDeps.videoRoot, resolvedDeps.fs))
  routes.get('/data/projects/:projectId/previews/:path{.*}', (c) =>
    serveFile(c, resolvedDeps.projectRoot, resolvedDeps.fs)
  )

  return routes
}

export { MIME_TYPES }
