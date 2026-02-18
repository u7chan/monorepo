import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { handleChatCompletions } from './handlers/chat'
import { chatRequestSchema } from './schemas/chat'

interface HonoEnv {
  Bindings: {
    LITELLM_API_BASE_URL: string
    LITELLM_API_KEY: string
    LITELLM_API_DEFAULT_MODEL: string
  }
}

const app = new Hono<HonoEnv>()

app.post('/api/chat/completions', sValidator('json', chatRequestSchema), async (c) => {
  return handleChatCompletions(c.req.valid('json'), c)
})

export default app
