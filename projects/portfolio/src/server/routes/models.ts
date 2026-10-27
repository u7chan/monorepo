import { Hono } from 'hono'
import { validator } from 'hono/validator'
import { z } from 'zod'
import { isImageGenerationModel, type UpstreamModel } from '#/server/features/image-generation/image-models'
import { logger } from '#/server/lib/logger'
import { UpstreamBaseUrlSchema } from '#/server/lib/upstream-base-url'
import { requireAuth } from '#/server/middleware/auth'
import type { HonoEnv } from './shared'

const ModelsHeaderSchema = z.object({
  'api-key': z.string().min(1),
  'base-url': z.string().min(1),
})

const modelsHeaderValidator = validator('header', (value, c) => {
  const parsed = ModelsHeaderSchema.safeParse({
    'api-key': value['api-key'],
    'base-url': value['base-url'],
  })

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const headerName = String(issue?.path[0] ?? 'unknown')

    return c.json({ message: `Validation Error: Missing required header '${headerName}'` }, 400)
  }

  const baseURL = UpstreamBaseUrlSchema.safeParse(parsed.data['base-url'])
  if (!baseURL.success) {
    return c.json({ message: "Validation Error: Invalid header 'base-url'" }, 400)
  }

  return { 'api-key': parsed.data['api-key'], 'base-url': baseURL.data }
})

function readUpstreamModels(data: unknown): UpstreamModel[] {
  const models = (data as { data?: unknown } | null)?.data
  if (!Array.isArray(models)) {
    return []
  }

  return models.flatMap((item) => {
    const { id, mode } = (item ?? {}) as { id?: unknown; mode?: unknown }
    if (typeof id !== 'string') {
      return []
    }

    return [{ id, mode: typeof mode === 'string' ? mode : undefined }]
  })
}

async function fetchUpstreamModels({
  apiKey,
  baseURL,
  requestLogger,
}: {
  apiKey: string
  baseURL: string
  requestLogger: typeof logger
}): Promise<UpstreamModel[]> {
  try {
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // 30x を追うと、検証済みの base-url から任意のホストへリクエストを転送できてしまう
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })

    if (response.ok) {
      return readUpstreamModels(await response.json())
    }
  } catch (error) {
    requestLogger.error({ err: error }, 'Failed to fetch models')
  }

  return []
}

const modelsRoutes = new Hono<HonoEnv>()
  .get('/api/fetch-models', requireAuth, modelsHeaderValidator, async (c) => {
    const { 'api-key': apiKey, 'base-url': baseURL } = c.req.valid('header')
    const models = await fetchUpstreamModels({ apiKey, baseURL, requestLogger: c.var.logger ?? logger })

    return c.json(models.map((model) => model.id).toSorted())
  })
  .get('/api/fetch-image-models', requireAuth, modelsHeaderValidator, async (c) => {
    const { 'api-key': apiKey, 'base-url': baseURL } = c.req.valid('header')
    const models = await fetchUpstreamModels({ apiKey, baseURL, requestLogger: c.var.logger ?? logger })

    return c.json(
      models
        .filter(isImageGenerationModel)
        .map((model) => model.id)
        .toSorted()
    )
  })

export { modelsRoutes }
