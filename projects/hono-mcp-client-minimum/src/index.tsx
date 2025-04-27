import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import OpenAI from 'openai'
import {
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/index.mjs'

export async function chat(
  model: string,
  query: string,
  mcpTools: ChatCompletionTool[],
  callbackMcpTool: (tool: ChatCompletionMessageToolCall) => Promise<void> // TODO: 一旦 void
): Promise<string> {
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
    tools: mcpTools,
  })
  const [choice] = response.choices
  if (!choice) {
    throw new Error('No choices found in the response')
  }
  if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
    for (const tool of choice.message.tool_calls) {
      await callbackMcpTool(tool)
    }
  }
  console.log('choice.finish_reason', choice.finish_reason)
  return choice.message.content || ''
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
  console.log('MCP Tools:', mcpTools.tools)
  return { mcpClient, mcpTools }
}

const { mcpClient, mcpTools } = await getMCPClient()
const app = new Hono()

app.post('/api/chat', async (c) => {
  const { model, query } = await c.req.json()
  const message = await chat(
    model,
    query,
    mcpTools.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
    async (tool) => {
      console.log('Tool call:', tool)
      const result = await mcpClient.callTool({
        name: tool.function.name,
        arguments: JSON.parse(tool.function.arguments),
      })
      console.log('Tool result:', result)
    }
  )
  console.log('Response:', message)
  return c.json({ message })
})

app.get('/', (c) => c.html(Bun.file('src/index.html').text()))

export default app
