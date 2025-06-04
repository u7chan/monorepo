import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { streamSSE } from 'hono/streaming'
import log4js, { levels } from 'log4js'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSETransport } from 'hono-mcp-server-sse-transport'
import { z } from 'zod'

import { currentTime } from './features/currentTime'
import { omikuji } from './features/omikuji'
import { reverseString } from './features/reverseString'
import { kotowaza } from './features/kotowaza'

const logger = log4js.getLogger()
logger.level = levels.INFO

const mcpServer = new McpServer({
  name: 'hono-mcp-server',
  version: '1.0.0',
})

mcpServer.tool('current_time', '現在の時刻を取得します', {}, () => {
  logger.info('» [currentTime] input:', {})
  const output = currentTime()
  logger.info('« [currentTime] output:', output)
  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  }
})

mcpServer.tool(
  'reverse_string',
  '入力文字列を反転します',
  { text: z.string() },
  (input) => {
    logger.info('» [reverseString] input:', input.text)
    const output = reverseString(input.text)
    logger.info('« [reverseString] output:', output)
    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    }
  },
)

mcpServer.tool('omikuji', 'ランダムにおみくじ結果を返します', {}, () => {
  logger.info('» [omikuji] input:', {})
  const output = omikuji()
  logger.info('« [omikuji] output:', output)
  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  }
})

mcpServer.tool('kotowaza', 'ランダムにことわざを返します', {}, () => {
  logger.info('» [kotowaza] input:', {})
  const output = kotowaza()
  logger.info('« [kotowaza] output:', output)
  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  }
})

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
