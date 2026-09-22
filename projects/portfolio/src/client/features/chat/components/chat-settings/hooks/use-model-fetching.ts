import { useQuery } from '@tanstack/react-query'
import { fetchChatModels } from '#/client/features/chat/api/models-client'
import { readFromLocalStorage } from '#/client/shared/storage/remote-storage-settings'

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

  const { baseURL, apiKey } = readFromLocalStorage()

  const query = useQuery({
    queryKey: ['chat-models', baseURL, apiKey],
    queryFn: async () => {
      return fetchChatModels(baseURL, apiKey)
    },
    enabled: autoModel,
    staleTime: 5 * 60 * 1000,
  })

  return {
    fetchedModels: query.data?.models ?? [],
    isLoadingModels: query.isLoading,
    fetchError: query.data?.error ?? null,
    refetchModels: query.refetch,
  }
}
