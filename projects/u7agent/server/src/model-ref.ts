export function modelLabel(model?: { provider: string; id: string } | null): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

export const modelKey = ({ provider, id }: { provider: string; id: string }): string => JSON.stringify([provider, id]);

export function parseModelRef(model: string | null): { provider: string; id: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}
