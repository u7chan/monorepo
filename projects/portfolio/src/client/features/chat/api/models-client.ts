import { hc } from 'hono/client'
import type { AppType } from '#/server/app'

const client = hc<AppType>('/')
const FETCH_TIMEOUT_MS = 10000

export interface ModelsFetchResult {
  models: string[]
  error: string | null
}

async function fetchModelsWithTimeout(request: () => Promise<Response>): Promise<ModelsFetchResult> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), FETCH_TIMEOUT_MS)
  })

  try {
    const response = await Promise.race([request(), timeoutPromise])
    if (response.ok) {
      const data = await response.json()
      const models = Array.isArray(data) ? data.filter((model): model is string => typeof model === 'string') : []
      return { models, error: null }
    }
    return { models: [], error: 'Failed to fetch models' }
  } catch (error) {
    if (error instanceof Error && error.message === 'Timeout') {
      return { models: [], error: 'Request timed out' }
    }
    console.error('Failed to fetch models:', error)
    return { models: [], error: 'Failed to fetch models' }
  }
}

export function fetchChatModels(baseURL: string, apiKey: string): Promise<ModelsFetchResult> {
  return fetchModelsWithTimeout(() =>
    client.api['fetch-models'].$get({
      header: {
        'api-key': apiKey,
        'base-url': baseURL,
      },
    })
  )
}

export function fetchImageGenerationModels(baseURL: string, apiKey: string): Promise<ModelsFetchResult> {
  return fetchModelsWithTimeout(() =>
    client.api['fetch-image-models'].$get({
      header: {
        'api-key': apiKey,
        'base-url': baseURL,
      },
    })
  )
}
