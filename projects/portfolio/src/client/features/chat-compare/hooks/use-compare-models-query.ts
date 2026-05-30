import { useQuery } from '@tanstack/react-query'
import { hc } from 'hono/client'
import type { AppType } from '#/server/app.d'
import type { CompareSettings } from './use-compare-settings'

const client = hc<AppType>('/')

export function useCompareModelsQuery(settings: CompareSettings) {
  const canFetchModels = settings.baseURL.length > 0 && settings.apiKey.length > 0

  const query = useQuery({
    queryKey: ['compare-models', settings.baseURL, settings.apiKey],
    queryFn: async () => {
      const res = await client.api['fetch-models'].$get({
        header: {
          'api-key': settings.apiKey,
          'base-url': settings.baseURL,
        },
      } as never)
      return (await res.json()) as string[]
    },
    enabled: canFetchModels,
    staleTime: 5 * 60 * 1000,
  })

  return {
    canFetchModels,
    models: query.data ?? [],
    modelsQuery: query,
  }
}
