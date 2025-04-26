import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { logger as honoLogger } from 'hono/logger'
import log4js from 'log4js'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSETransport } from 'hono-mcp-server-sse-transport'
import { z } from 'zod'

import { translateToEnglish } from './features/translate-to-english'
import { webSerachByOpenAI } from './features/web-serach-by-openai'

const logger = log4js.getLogger()
logger.level = 'info'

const mcpServer = new McpServer({
  name: 'hono-mcp-server',
  version: '1.0.0',
})

mcpServer.tool(
  'translate_to_english',
  '入力された文章を英語に翻訳します',
  { text: z.string() },
  async (input) => {
    logger.info('» [translateToEnglish] input:', input.text)
    const output = await translateToEnglish(input.text)
    logger.info('« [translateToEnglish] output:', output)
    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    }
  }
)

mcpServer.tool(
  'web_serach',
  '入力された文章をWeb検索します',
  { text: z.string() },
  async (input) => {
    logger.info('» [webSerachByOpenAI] input:', input.text)
    const output = await webSerachByOpenAI(input.text)
    logger.info('« [webSerachByOpenAI] output:', output)
    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    }
  }
)

const app = new Hono()
const customLogger = (message: string) => {
  logger.info(message)
}
app.use(honoLogger(customLogger))

// to support multiple simultaneous connections we have a lookup object from
// sessionId to transport
const transports: { [sessionId: string]: SSETransport } = {}

app.get('/', (c) => {
  // debug用
  return c.json({ session: transports })
})

app.get('/sse', (c) => {
  return streamSSE(c, async (stream) => {
    const transport = new SSETransport('/messages', stream)

    transports[transport.sessionId] = transport

    stream.onAbort(() => {
      delete transports[transport.sessionId]
    })

    await mcpServer.connect(transport)

    while (true) {
      // This will keep the connection alive
      // You can also await for a promise that never resolves
      await stream.sleep(60_000)
    }
  })
})

app.post('/messages', async (c) => {
  const sessionId = c.req.query('sessionId') || ''
  const transport = transports[sessionId]

  if (transport == null) {
    return c.text('No transport found for sessionId', 400)
  }

  return transport.handlePostMessage(c)
})

export default {
  fetch: app.fetch,
  idleTimeout: 60,
}
