import { $ } from 'bun'

export async function webSearch(query: string) {
  return await $`bunx gemini --prompt "google_web_search: ${query}"`.text()
}
