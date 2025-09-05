import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Hono } from 'hono'
import { z } from 'zod'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

const mcpServer = new McpServer({
  name: 'long-running-mcp-server',
  version: '1.0.0',
})

mcpServer.tool(
  'run_long_task',
  'Runs a long task that takes a while to complete',
  async () => {
    const sessionId = crypto.randomUUID()
    // TODO: run the long task asynchronously
    return {
      content: [
        {
          type: 'text',
          text: `Started long task with session ID: ${sessionId}`,
        },
      ],
    }
  },
)

mcpServer.tool(
  'get_task_status',
  'Gets the status of a long task',
  { sessionId: z.string() },
  async ({ sessionId }) => {
    // TODO: fetch status
    const status = 'in_progress'
    return {
      content: [
        {
          type: 'text',
          text: `Status of task ${sessionId}: ${status}`,
        },
      ],
    }
  },
)

mcpServer.tool(
  'approve_task',
  'Approves a long task',
  { sessionId: z.string() },
  async ({ sessionId }) => {
    // TODO: approve task
    return {
      content: [
        {
          type: 'text',
          text: `Approved task ${sessionId}`,
        },
      ],
    }
  },
)

mcpServer.tool(
  'register_task',
  'Registers a long task',
  { sessionId: z.string() },
  async ({ sessionId }) => {
    // TODO: register task
    return {
      content: [
        {
          type: 'text',
          text: `Registered task ${sessionId}`,
        },
      ],
    }
  },
)

app.all('/mcp', async (c) => {
  const transport = new StreamableHTTPTransport()
  await mcpServer.connect(transport)
  return transport.handleRequest(c)
})

export default app
