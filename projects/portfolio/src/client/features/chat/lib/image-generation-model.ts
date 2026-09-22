import type { Settings } from '#/client/shared/storage/remote-storage-settings'

/**
 * 接続先の一覧から画像生成モデルを選ぶ優先順。
 * 接続先は `openai/gpt-image-2.5-flare` のようなプレフィックス付き ID を返すため、末尾一致で探す。
 */
export const IMAGE_GENERATION_MODEL_PRIORITY = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2']

export interface ImageGenerationConnection {
  baseURL: string
  apiKey: string
}

type ImageGenerationConnectionSettings = Pick<
  Settings,
  'baseURL' | 'apiKey' | 'imageGenerationBaseURL' | 'imageGenerationApiKey'
>

export function resolveImageGenerationConnection(
  settings: ImageGenerationConnectionSettings
): ImageGenerationConnection {
  return {
    baseURL: settings.imageGenerationBaseURL.trim() || settings.baseURL,
    apiKey: settings.imageGenerationApiKey.trim() || settings.apiKey,
  }
}

export function isImageGenerationConnectionConfigured(connection: ImageGenerationConnection): boolean {
  return Boolean(connection.baseURL.trim() && connection.apiKey.trim())
}

/**
 * 保存値 → 優先順（末尾一致）→ 一覧の先頭 の順で画像生成モデルを解決する。
 * 一覧が空の場合は未選択として `null` を返す。
 */
export function resolveImageGenerationModel({
  savedModel,
  availableModels,
}: {
  savedModel: string
  availableModels: string[]
}): string | null {
  const models = availableModels.filter((model) => model.trim())
  const saved = savedModel.trim()

  if (saved && models.includes(saved)) {
    return saved
  }

  for (const candidate of IMAGE_GENERATION_MODEL_PRIORITY) {
    const matched = models.find((model) => model === candidate || model.endsWith(`/${candidate}`))
    if (matched) {
      return matched
    }
  }

  return models[0] ?? null
}
