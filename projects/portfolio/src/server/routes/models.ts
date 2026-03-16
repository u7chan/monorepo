import { Hono } from 'hono'
import { validator } from 'hono/validator'
import { z } from 'zod'
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

  return parsed.data
})

const modelsRoutes = new Hono<HonoEnv>().get('/api/fetch-models', modelsHeaderValidator, async (c) => {
  const { 'api-key': apiKey, 'base-url': baseURL } = c.req.valid('header')

  try {
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    })

    if (response.ok) {
      const data = await response.json()
      const models: string[] = data.data?.map((item: { id: string }) => item.id) || []

      return c.json(models.toSorted())
    }
  } catch (error) {
    console.error('Failed to fetch models:', error)
  }

  return c.json([])
})

export { modelsRoutes }
