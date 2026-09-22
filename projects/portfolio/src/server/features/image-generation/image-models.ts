export interface UpstreamModel {
  id: string
  mode?: string
}

const IMAGE_GENERATION_MODEL_NAME_PATTERN = /(^|\/)gpt-image-/

/**
 * LiteLLM は `mode: 'image_generation'` を返すため、それを優先して判定する。
 * `mode` を返さないプロキシ（OpenAI 直など）ではモデル名でフォールバックする。
 */
export function isImageGenerationModel({ id, mode }: UpstreamModel): boolean {
  const normalizedMode = mode?.trim()
  if (normalizedMode) {
    return normalizedMode === 'image_generation'
  }

  return IMAGE_GENERATION_MODEL_NAME_PATTERN.test(id)
}
