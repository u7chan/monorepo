/**
 * 設定 → エージェント（/settings/agents）の一覧をグリップで並べ替える計算。判定だけをここへ置き、
 * DOM の読み書き（行の追従・自動スクロール・pointer capture）は `hooks/useAgentDrag.ts` が持つ。
 */

/** 押しただけ（行の選択 / タップ）と区別する移動量。これ未満では掴んでいない */
export const AGENT_DRAG_THRESHOLD = 4;

/** 端と見なす帯の幅と、1 フレームあたりの最大スクロール量 (px) */
export const AGENT_DRAG_SCROLL_BAND = 48;
export const AGENT_DRAG_SCROLL_STEP = 12;

/** 行の中心線の一覧から挿入先 (0..centers.length) を求める。中心線より下の行の数が挿入先になる */
export function dropIndexFor(centers: readonly number[], pointerY: number): number {
  let index = 0;
  for (const center of centers) {
    if (pointerY > center) index += 1;
  }
  return index;
}

/**
 * 掴んでいる行 (`from`) を除いた中心線から、移動前の添字で数えた挿入先を求める。
 * 掴んだ行の rect は translate でポインタに追従しているので、判定へ自分を入れない。
 */
export function dropTargetFor(centers: readonly number[], pointerY: number, from: number): number {
  const target = dropIndexFor(centers, pointerY);
  return target < from ? target : target + 1;
}

/**
 * `ids[from]` を `to`（移動前の添字で数えた挿入先）へ動かす。範囲外の `from` は何もしない。
 * 移動後の添字は、後ろへ動かすときだけ 1 つ手前になる。
 */
export function moveAgentId(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  const insert = to > from ? to - 1 : to;
  next.splice(Math.max(0, Math.min(next.length, insert)), 0, moved);
  return next;
}

/**
 * `ids` に含まれる行だけをその順へ並べ替え、含まれない行は元の位置に残す。ビルトインは
 * ユーザー定義の id 順に含まれないため、先頭の 1 行は動かない（docs/api-catalog.md）。
 */
export function reorderRows<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const queue = ids.map((id) => byId.get(id)).filter((row): row is T => row !== undefined);
  const used = new Set(queue.map((row) => row.id));
  let next = 0;
  return rows.map((row) => (used.has(row.id) ? queue[next++] : row));
}

/** サーバーが返した順へ agents を並べ替える。ids に無い行は元の相対順で末尾に回す */
export function applyAgentOrder<T extends { id: string }>(agents: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered: T[] = [];
  for (const id of ids) {
    const agent = byId.get(id);
    if (!agent) continue;
    byId.delete(id);
    ordered.push(agent);
  }
  for (const agent of agents) {
    if (!byId.has(agent.id)) continue;
    byId.delete(agent.id);
    ordered.push(agent);
  }
  return ordered;
}

/**
 * 端に寄ったポインタの自動スクロール量（1 フレームあたり px）。上へは負。帯の外は 0 で、
 * 端に近いほど大きい。帯は容器の半分までに抑える（低い一覧で常に最大にならないようにする）。
 */
export function edgeScrollStep(
  pointerY: number,
  top: number,
  bottom: number,
  band = AGENT_DRAG_SCROLL_BAND,
  step = AGENT_DRAG_SCROLL_STEP,
): number {
  const width = Math.min(band, Math.max(1, (bottom - top) / 2));
  if (pointerY < top + width) {
    const depth = Math.min(width, top + width - pointerY);
    return -Math.ceil((depth / width) * step);
  }
  if (pointerY > bottom - width) {
    const depth = Math.min(width, pointerY - (bottom - width));
    return Math.ceil((depth / width) * step);
  }
  return 0;
}

/**
 * スクロールさせる祖先の探索に要る最小の形。HTMLElement はこの形を満たすので、
 * テストは素のオブジェクトを渡せる。
 */
export type ScrollCandidate = {
  parentElement: ScrollCandidate | null;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * 実際にスクロールしている祖先を返す。900px 以上では一覧の内部、狭いときはページ 1 本なので、
 * 固定の枠ではなく祖先を辿って決める。一覧が短く内部スクロールが起きていないときは null になり、
 * 呼び出し側はページ（document.scrollingElement）へ落ちる。
 */
export function scrollableAncestor<T extends ScrollCandidate>(start: T | null): T | null {
  // 親を辿る間だけ T を保証できない (親も同じ形だが、型では縛れない)
  let node: T | null = start;
  for (; node; node = node.parentElement as T | null) {
    if (node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}
