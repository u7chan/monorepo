import { readFromLocalStorage } from '#/client/storage/remote-storage-settings'
import type { AppType } from '#/server/app'
import { hc } from 'hono/client'
import { useCallback, useEffect, useState } from 'react'

const client = hc<AppType>('/')
const FETCH_TIMEOUT_MS = 10000

async function fetchModelsWithTimeout(
  baseURL: string,
  apiKey: string
): Promise<{ models: string[]; error: string | null }> {
  const fetchPromise = client.api['fetch-models'].$get({
    header: {
      'api-key': apiKey,
      'base-url': baseURL,
    },
  })

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), FETCH_TIMEOUT_MS)
  })

  try {
    const response = await Promise.race([fetchPromise, timeoutPromise])
    if (response.ok) {
      const models = await response.json()
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

interface UseModelFetchingOptions {
  autoModel: boolean
}

interface UseModelFetchingReturn {
  fetchedModels: string[]
  isLoadingModels: boolean
  fetchError: string | null
  refetchModels: () => void
}

export function useModelFetching(options: UseModelFetchingOptions): UseModelFetchingReturn {
  const { autoModel } = options

  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    if (autoModel) {
      setIsLoadingModels(true)
      setFetchError(null)
      const { baseURL, apiKey } = readFromLocalStorage()
      fetchModelsWithTimeout(baseURL, apiKey).then(({ models, error }) => {
        setFetchedModels(models)
        setFetchError(error)
        setIsLoadingModels(false)
      })
    }
  }, [autoModel])

  const refetchModels = useCallback(() => {
    if (autoModel) {
      setIsLoadingModels(true)
      setFetchError(null)
      const { baseURL, apiKey } = readFromLocalStorage()
      fetchModelsWithTimeout(baseURL, apiKey).then(({ models, error }) => {
        setFetchedModels(models)
        setFetchError(error)
        setIsLoadingModels(false)
      })
    }
  }, [autoModel])

  return { fetchedModels, isLoadingModels, fetchError, refetchModels }
}
