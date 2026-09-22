import { useQuery } from '@tanstack/react-query'
import { fetchImageGenerationModels } from '#/client/features/chat/api/models-client'
import {
  isImageGenerationConnectionConfigured,
  resolveImageGenerationConnection,
  resolveImageGenerationModel,
  type ImageGenerationConnection,
} from '#/client/features/chat/lib/image-generation-model'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'

export interface ImageGenerationModelState {
  imageModels: string[]
  isLoadingImageModels: boolean
  imageModelsError: string | null
  refetchImageModels: () => void
  imageGenerationConnection: ImageGenerationConnection
  resolvedImageGenerationModel: string | null
}

type ImageGenerationModelSettings = Pick<
  Settings,
  'baseURL' | 'apiKey' | 'imageGenerationBaseURL' | 'imageGenerationApiKey' | 'imageGenerationModel'
>

export function useImageGenerationModel(settings: ImageGenerationModelSettings): ImageGenerationModelState {
  const imageGenerationConnection = resolveImageGenerationConnection(settings)
  const isConfigured = isImageGenerationConnectionConfigured(imageGenerationConnection)

  const query = useQuery({
    queryKey: ['image-models', imageGenerationConnection.baseURL, imageGenerationConnection.apiKey],
    queryFn: async () => {
      return fetchImageGenerationModels(imageGenerationConnection.baseURL, imageGenerationConnection.apiKey)
    },
    enabled: isConfigured,
    staleTime: 5 * 60 * 1000,
  })

  const imageModels = query.data?.models ?? []

  return {
    imageModels,
    isLoadingImageModels: query.isLoading,
    imageModelsError: query.data?.error ?? null,
    refetchImageModels: query.refetch,
    imageGenerationConnection,
    resolvedImageGenerationModel: resolveImageGenerationModel({
      savedModel: settings.imageGenerationModel,
      availableModels: imageModels,
    }),
  }
}
