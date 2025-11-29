import { tool } from 'ai'
import z from 'zod'

export const availableTools = {
  weather: tool({
    description: '天気情報を取得します。',
    inputSchema: z.object({ location: z.string().describe('天気を取得する都市') }),
    execute: async ({ location }: { location: string }) => {
      // Mock weather data for demonstration purposes
      return {
        text: `${location}の天気は晴れで、気温は25°Cです。`,
        condition: '晴れ',
        temperature: 25,
      }
    },
  }),
  discord: tool({
    description: 'Discordチャンネルにメッセージを送信します。',
    inputSchema: z.object({
      channelId: z.string().describe('DiscordチャンネルのID'),
      message: z.string().describe('送信するメッセージ内容'),
    }),
    execute: async ({ channelId, message }: { channelId: string; message: string }) => {
      // Mock Discord message sending for demonstration purposes
      console.log(`Message sent to channel ${channelId}: ${message}`)
      return { success: true }
    },
  }),
}

type AllowedToolSpec = Array<{ name: string } | string>

/**
 * Pick tools from the available set according to a list of allowed names.
 * If allowed is falsy or empty, returns all available tools.
 */
export function pickTools(allowed?: AllowedToolSpec): Record<string, any> {
  // NOTE: returning an empty object when `allowed` is unset/empty ensures agents
  // which don't declare tools in their definition cannot use any tools.
  if (!allowed || (Array.isArray(allowed) && allowed.length === 0)) return {}

  const names = allowed.map((x) => (typeof x === 'string' ? x : x.name))
  const picked: Record<string, any> = {}

  for (const name of names) {
    if (name in availableTools) picked[name] = (availableTools as any)[name]
  }

  return picked
}
