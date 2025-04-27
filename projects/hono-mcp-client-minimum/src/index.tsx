import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import OpenAI from 'openai'

export async function chat(model: string, query: string): Promise<string> {
  const openai = new OpenAI({
    apiKey: process.env.LITELLM_API_KEY || '',
    baseURL: process.env.LITELLM_API_BASE_URL || '',
  })
  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'あなたは優秀なAIエージェントです。必ず`plain/text`形式の日本語で回答してください。',
      },
      {
        role: 'user',
        content: query,
      },
    ],
  })
  return response.choices[0].message.content || ''
}

async function getMCPClient() {
  if (!process.env.MCP_SERVER_URL) {
    throw new Error('MCP_SERVER_URL is not set')
  }
  console.log('Connecting to MCP server:', process.env.MCP_SERVER_URL)
  const mcpClient = new Client({
    name: 'hono-mcp-client',
    version: '1.0.0',
  })
  const sseTransport = new SSEClientTransport(
    new URL(process.env.MCP_SERVER_URL || '')
  )
  await mcpClient.connect(sseTransport)
  const mcpTools = await mcpClient.listTools()
  console.log(
    'MCP Tools:',
    mcpTools.tools.map(({ name, description }: any) => ({ name, description }))
  )
  return mcpClient
}

const mcpClient = await getMCPClient()
const app = new Hono()

app.post('/api/chat', async (c) => {
  const { model, query } = await c.req.json()
  const message = await chat(model, query)
  return c.json({ message })
})

app.get('/', (c) => c.html(Bun.file('src/index.html').text()))

export default app
