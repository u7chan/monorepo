import type { ProviderId, UsageWindow } from "../api";

/**
 * 推移の初期表示。Codex と OpenCode Go で窓の id が違うため、正規化済みのラベルで選ぶ。
 * 週次が無いプランでは先頭の窓を出す。
 */
export function pickTrendWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.find((window) => window.label.startsWith("週次")) ?? windows[0] ?? null;
}

/** ローリングは 5 時間以内に終わり、リセットの日付は残り時間から分かる。meter は日付を省く。 */
export function isRolling(window: UsageWindow): boolean {
  return window.label.startsWith("ローリング");
}

/**
 * 窓は短い方が長い方に含まれる（月次 ⊃ 週次 ⊃ ローリング）。外側が尽きたら内側は残っていても使えない。
 * 種類はラベルが持っているため、窓の並び順ではなくラベルから外側を決める。
 */
const WINDOW_DEPTHS: readonly (readonly [prefix: string, depth: number])[] = [
  ["ローリング", 1],
  ["週次", 2],
  ["月次", 3],
];

export type WindowBlock = {
  /** 内側の窓を使えなくしている外側の窓のラベル。 */
  byLabel: string;
};

/**
 * 外側の窓が上限に達している内側の窓を返す。
 * 複数の外側が尽きているときは最も外側を選ぶ。いつ使えるように戻るかを決めるのはそれだから。
 */
export function findBlockedWindows(windows: readonly UsageWindow[]): Map<string, WindowBlock> {
  const depths = windows.map((window) => depthOf(window));
  const blocked = new Map<string, WindowBlock>();

  for (const [index, window] of windows.entries()) {
    const depth = depths[index] ?? null;
    let blocker: UsageWindow | null = null;
    let blockerDepth = 0;

    for (const [outerIndex, outer] of windows.entries()) {
      const outerDepth = depths[outerIndex] ?? null;

      if (
        depth !== null &&
        outerDepth !== null &&
        outerDepth > depth &&
        outer.usedPercent >= 100 &&
        outerDepth > blockerDepth
      ) {
        blocker = outer;
        blockerDepth = outerDepth;
      }
    }

    if (blocker) {
      blocked.set(window.id, { byLabel: blocker.label });
    }
  }

  return blocked;
}

/** 期間の長さが分からないラベルは比較に参加させない。順序を推測して誤った窓を止めるより出さない。 */
function depthOf(window: UsageWindow): number | null {
  return WINDOW_DEPTHS.find(([prefix]) => window.label.startsWith(prefix))?.[1] ?? null;
}

/**
 * カードに並べる枠。provider ごとに順を決め、API が返さない枠は
 * 行の位置を揃えるための空きスロットにする（値は持たせない）。
 */
export type WindowSlot = { window: UsageWindow } | { label: string; absentNote: string };

const WINDOW_SLOTS: Partial<Record<ProviderId, readonly { label: string; absentNote: string }[]>> = {
  // Codex の 5 時間枠はプランによって返らない。週次だけのカードでも行を揃えたいので、
  // 返らない種類は場所だけ確保する。値の無い枠に「0%」は出さない。
  codex: [
    { label: "ローリング", absentNote: "5 時間枠は提供されていません" },
    { label: "週次", absentNote: "週次の枠は提供されていません" },
  ],
};

export function arrangeWindowSlots(provider: ProviderId, windows: readonly UsageWindow[]): WindowSlot[] {
  const definitions = WINDOW_SLOTS[provider];

  if (!definitions || windows.length === 0) {
    return windows.map((window) => ({ window }));
  }

  const placed = new Set<UsageWindow>();
  const slots: WindowSlot[] = definitions.map((definition) => {
    const window = windows.find((candidate) => !placed.has(candidate) && candidate.label.startsWith(definition.label));

    if (!window) {
      return definition;
    }

    placed.add(window);

    return { window };
  });

  // 定義に無い窓は落とさない。上流が窓を増やしても、そのまま末尾に出す。
  for (const window of windows) {
    if (!placed.has(window)) {
      slots.push({ window });
    }
  }

  return slots;
}
