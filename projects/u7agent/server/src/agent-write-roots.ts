/**
 * エージェントの bash が書ける場所。BFF と dev が信頼して実行するものを、この配下に置かないための判定が共有する。
 * scripts/dev.mjs が node で直接読むので、相対 import を持たない。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** 無ければ作ってよい root。エージェントの bash と BFF 内部実行が共有する基準集合の 1 件 */
export interface LandlockWriteRoot {
  path: string;
  create?: boolean;
}

/**
 * `/tmp` とホーム配下のキャッシュ、デバイスファイル。ワークスペースに依らず全実行で許可する。
 * `2>/dev/null` と `mktemp` / パッケージマネージャーのキャッシュを塞がないためで、`$HOME` 全体は許可しない。
 */
export function fixedLandlockWriteRoots(home = homedir()): LandlockWriteRoot[] {
  return [
    { path: "/tmp" },
    { path: join(home, ".cache"), create: true },
    { path: join(home, ".npm"), create: true },
    { path: join(home, ".local", "share", "pnpm"), create: true },
    { path: "/dev/null" },
    { path: "/dev/shm" },
  ];
}

/** 共通スキルの root (ワークスペース相対)。app-paths.ts の `COMMON_SKILLS_DIR` と同じ値で、テストが揃いを見る */
export const COMMON_SKILLS_RELATIVE = ".agents/skills";

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** 字句の形と、実在すれば実体の形 */
export function pathForms(path: string): string[] {
  const lexical = resolve(path);
  try {
    const real = realpathSync(lexical);
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

/**
 * 字句だけでも実体だけでも比べない。書き込み先が symlink のときと未作成のときで、どちらかが外れる。
 * 共通スキルの root もサンドボックスの書き込み先で、実体が作業領域の外にあり得る。
 */
export function agentWritableRoots(input: { rootCwd?: string; home?: string; fixed?: readonly string[] }): string[] {
  const fixed = input.fixed ?? fixedLandlockWriteRoots(input.home).map((root) => root.path);
  const workspace = input.rootCwd ? [input.rootCwd, join(input.rootCwd, COMMON_SKILLS_RELATIVE)] : [];
  return [...new Set([...fixed, ...workspace].flatMap(pathForms))];
}

export function isInsideAny(roots: readonly string[], target: string): boolean {
  return roots.some((root) => isInside(root, target));
}

/** 字句と、まだ無い場所なら実在する祖先から組み立てた実体の両方で見る。片方だけでは symlink を見逃す */
export function isAgentWritablePath(roots: readonly string[], path: string): boolean {
  return [...new Set([...pathForms(path), plannedRealPath(path)])].some((form) => isInsideAny(roots, form));
}

/** まだ無い場所の実体を、実在する最も近い祖先の実体から組み立てる (配置先がエージェントの書ける場所かの判定用) */
export function plannedRealPath(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}
