import { useQuery } from '@tanstack/react-query'
import { fetchChatModels } from '#/client/features/chat/api/models-client'
import type { CompareSettings } from './use-compare-settings'

export function useCompareModelsQuery(settings: CompareSettings) {
  const canFetchModels = settings.baseURL.length > 0 && settings.apiKey.length > 0

  const query = useQuery({
    queryKey: ['compare-models', settings.baseURL, settings.apiKey],
    queryFn: () => fetchChatModels(settings.baseURL, settings.apiKey),
    enabled: canFetchModels,
    staleTime: 5 * 60 * 1000,
  })

  return {
    canFetchModels,
    models: query.data?.models ?? [],
    modelsError: query.data?.error ?? null,
    modelsQuery: query,
  }
}
