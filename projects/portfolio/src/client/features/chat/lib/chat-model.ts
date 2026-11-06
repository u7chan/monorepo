/**
 * 取得済みの一覧から使用するチャットモデルを解決する。
 * 保存値が一覧にあればそれを優先し、なければ一覧の先頭を返す。一覧が空の場合は未解決として `null`。
 */
export function resolveChatModel({
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

  return models[0] ?? null
}
