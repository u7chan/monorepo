/**
 * エージェント定義の許可リストの判定と操作。`undefined` = 未指定、`null` = 解除、配列 = 明示リスト
 * (`[]` はすべて OFF) の 3 状態を画面とテストで同じ規則から扱う (docs/api-catalog.md#エージェント定義のスキル許可リスト)。
 */
export type Allowlist = string[] | null | undefined;

/** 明示リストだけが「選んだ名前」。未指定と解除はどちらも全可視 */
export function isExplicitAllowlist(names: Allowlist): names is string[] {
  return Array.isArray(names);
}

/**
 * いま有効な名前。未指定 / 解除は visible 全件、明示リストはその配列をそのまま使う
 * (一覧に無い保存名も残す)。
 */
export function allowedNames(names: Allowlist, visibleNames: readonly string[]): string[] {
  return isExplicitAllowlist(names) ? [...names] : [...visibleNames];
}

/** 行 1 本の ON / OFF。未指定 / 解除は visible の行が ON、明示リストは配列に含まれる名前だけ ON */
export function isNameAllowed(names: Allowlist, visibleNames: readonly string[], name: string): boolean {
  return isExplicitAllowlist(names) ? names.includes(name) : visibleNames.includes(name);
}

/** visible 行のうち使用中の件数。検索で絞る前の一覧を渡す */
export function usedCount(names: Allowlist, visibleNames: readonly string[]): number {
  const allowed = new Set(allowedNames(names, visibleNames));
  return visibleNames.filter((name) => allowed.has(name)).length;
}

/**
 * 個別の切替。未指定 / 解除から外すときは「いま見えている一覧 − 対象」を明示リストへ固定する
 * (あとから増えたスキルを勝手に許可しない)。一覧に無い保存名は落とさない。
 */
export function toggleAllowed(
  current: Allowlist,
  name: string,
  checked: boolean,
  visibleNames: readonly string[],
): string[] {
  const names = allowedNames(current, visibleNames);
  if (checked) return names.includes(name) ? names : [...names, name];
  return names.filter((saved) => saved !== name);
}

/**
 * グループ単位の「すべて外す」。開始集合は未指定 / 解除ならそのスコープの visible 全件、明示リスト
 * ならその配列で、対象グループの visible 名だけを除く (一覧に無い保存名と他のグループは残る)。
 */
export function disableGroup(
  current: Allowlist,
  groupVisibleNames: readonly string[],
  scopeVisibleNames: readonly string[],
): string[] {
  const group = new Set(groupVisibleNames);
  return allowedNames(current, scopeVisibleNames).filter((name) => !group.has(name));
}

/** 保存名のうち一覧に無いもの。落とさず残していることを注記で知らせる */
export function missingNames(names: Allowlist, visibleNames: readonly string[]): string[] {
  if (!isExplicitAllowlist(names)) return [];
  const visible = new Set(visibleNames);
  return names.filter((name) => !visible.has(name));
}

/** タブとグループ見出しに出す件数。検索中も未絞込の visible 行を数える */
export type AllowlistCount = { used: number; total: number };

export function allowlistCount(names: Allowlist, visibleNames: readonly string[]): AllowlistCount {
  return { used: usedCount(names, visibleNames), total: visibleNames.length };
}

/** 「使用 n / 全 m」の表示。0 件のグループでも件数を出す */
export function allowlistCountLabel(count: AllowlistCount): string {
  return `使用 ${count.used} / 全 ${count.total}`;
}
