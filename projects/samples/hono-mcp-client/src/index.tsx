import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import OpenAI from 'openai'
import {
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/index.mjs'
import { z } from 'zod'

type CallToolResult = z.infer<typeof CallToolResultSchema>

export async function chatCompletion(
  model: string,
  query: string,
  mcpTools: ChatCompletionTool[],
  callbackMcpTool: (
    tool: ChatCompletionMessageToolCall
  ) => Promise<CallToolResult>
): Promise<string> {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE_URL,
  })
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        'あなたは優秀なAIエージェントです。必ず`plain/text`形式の日本語で回答してください。',
    },
    {
      role: 'user',
      content: query,
    },
  ]
  const response = await openai.chat.completions.create({
    model,
    messages,
    tools: mcpTools,
  })
  let choice: OpenAI.ChatCompletion.Choice | undefined = response.choices.at(0)
  if (!choice) {
    throw new Error('No choices found in the response')
  }
  // Check if the response contains a tool call
  if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
    for (const tool of choice.message.tool_calls) {
      const toolResult = await callbackMcpTool(tool)
      if (toolResult.error) {
        console.error('Tool call error:', toolResult.error)
        throw new Error(`Tool call failed: ${tool.function.name}`)
      }
      const [content] = toolResult.content
      if (!content) {
        throw new Error('No content found in the tool result')
      }
      if (content.type !== 'text') {
        throw new Error('Tool result is not text')
      }
      messages.push({
        role: 'user',
        content: content.text,
      })
      const response = await openai.chat.completions.create({
        model,
        messages,
      })
      choice = response.choices.at(0)
      if (!choice) {
        throw new Error('No choices found in the response')
      }
      messages.push({
        role: 'assistant',
        content: choice.message.content,
      })
    }
  }
  return choice.message.content || ''
}

async function initializeMCPClient() {
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

const { mcpClient, mcpTools } = await initializeMCPClient()
const app = new Hono()

app.post('/api/chat', async (c) => {
  const { model, query } = await c.req.json()
  const message = await chatCompletion(
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
      return result as CallToolResult
    }
  )
  console.log('Response:', message)
  return c.json({ message })
})

app.get('/', async (c) => {
  const toolsText = mcpTools.tools.map((tool) => `・${tool.name}`).join('\n')
  const assistantMessage = `何かご用はありますか？😊\n利用可能なMCPツールは以下の通りです。\n${toolsText}`
  const template = await Bun.file('src/index.html').text()
  return c.html(template.replace('{{assistantMessage}}', assistantMessage))
})

export default app
