import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSETransport } from 'hono-mcp-server-sse-transport'
import { z } from 'zod'

import { translateToEnglish } from './features/translate-to-english'
import { webSerachByOpenAI } from './features/web-serach-by-openai'

const mcpServer = new McpServer({
  name: 'hono-mcp-server',
  version: '1.0.0',
})

mcpServer.tool(
  'translate_to_english',
  '入力された文章を英語に翻訳します',
  { text: z.string() },
  async (input) => {
    return {
      content: [
        {
          type: 'text',
          text: await translateToEnglish(input.text),
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
    return {
      content: [
        {
          type: 'text',
          text: await webSerachByOpenAI(input.text),
        },
      ],
    }
  }
)

const app = new Hono()

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

export default app
