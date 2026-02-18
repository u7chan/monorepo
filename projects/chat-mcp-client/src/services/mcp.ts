import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { experimental_createMCPClient as createMCPClient, type Tool } from 'ai'

async function fetchMcpTools(baseUrl: string) {
  const mcpClient = await createMCPClient({
    transport: new SSEClientTransport(new URL(baseUrl)),
  })
  return await mcpClient.tools()
}

export async function fetchMcpToolsFromServers(
  serverUrls: string[],
  filters?: string[],
): Promise<{ [k: string]: Tool }> {
  const filteredTools: { [k: string]: Tool } = {}
  for (const baseUrl of serverUrls) {
    const tools = await fetchMcpTools(baseUrl)
    const availableTools = Object.keys(tools).filter((key) =>
      filters ? filters.includes(key) : true,
    )
    for (const key of availableTools) {
      console.log(`Available Tools: ${key}, ${tools[key].description}`)
      filteredTools[key] = tools[key]
    }
  }
  return filteredTools
}
