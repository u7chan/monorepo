export function normalizeReorderIds(currentIds: readonly string[], requestedIds: readonly unknown[]): string[] {
  const known = new Set(currentIds);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of requestedIds) {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  // 部分的な指定で、触らなかった行まで並べ替えない。
  for (const id of currentIds) {
    if (!seen.has(id)) order.push(id);
  }
  return order;
}
