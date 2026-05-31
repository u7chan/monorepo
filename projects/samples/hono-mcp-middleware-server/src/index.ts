import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'
import z from 'zod'

const app = new Hono()

// Your MCP server implementation
const mcpServer = new McpServer({
  name: 'my-mcp-server',
  version: '1.0.0',
})

mcpServer.tool('reverse_string', '入力文字列を反転します', { text: z.string() }, ({ text }) => {
  return {
    content: [
      {
        type: 'text',
        text: text.split('').reverse().join(''),
      },
    ],
  }
})

app.all('/mcp', async (c) => {
  const transport = new StreamableHTTPTransport()
  await mcpServer.connect(transport)
  return transport.handleRequest(c)
})

export default app