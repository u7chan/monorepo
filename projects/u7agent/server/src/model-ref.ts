type ModelRefParts = { provider: string; id: string };

export function formatModelRef(model: ModelRefParts): string {
  return `${model.provider}/${model.id}`;
}

export function modelLabel(model?: ModelRefParts | null): string | undefined {
  return model ? formatModelRef(model) : undefined;
}

/** 表示用のラベルは、ID に `/` を含む組の比較キーには使わない。 */
export const modelKey = ({ provider, id }: ModelRefParts): string => JSON.stringify([provider, id]);

/** ID 自体に `/` を含められるので、区切りは最初の `/` だけ。既存の参照を読む際は空白も保持する。 */
export function parseModelRef(model?: string | null): ModelRefParts | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}
