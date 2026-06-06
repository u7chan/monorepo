import { $ } from 'bun'

export async function webSearch(query: string) {
  // TODO: Replace this stale Gemini CLI experiment with a maintained web search provider.
  try {
    return await $`bunx gemini --prompt "google_web_search: ${query}"`.text()
  } catch (e) {
    if (e instanceof $.ShellError) {
      throw new Error(e.stderr.toString())
    }
    throw e
  }
}
