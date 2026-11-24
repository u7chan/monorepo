import { resolve, sep } from "node:path";
import { isInsideRoot } from "../path-strings";
import { deepestExistingReal, realpathNative } from "./fs-path";

/**
 * write / edit が書ける範囲 (ファイルツールのポリシー)。許可 root は実行 cwd (realpath)・要求 cwd の
 * lexical 形 (root / 登録ディレクトリが symlink でも system prompt に出た絶対パスを通す)・共通スキル置き場の 3 つ。
 * bash 側の強制は Landlock が担い、ここはモデルの取り違えを防ぐ。
 */
export interface WriteScope {
  cwd: string;
  lexicalCwd: string;
  skillsDir: string;
}

/**
 * 実パスで見た許可 root。`lexical` は root が未作成のときだけ入り、候補が lexical にも収まることを要求する
 * (未作成 root の最寄りの実在祖先は他の root と同じディレクトリになり得るため)。
 */
interface WriteRoot {
  real: string;
  lexical: string | undefined;
}

async function resolveWriteRoots(scope: WriteScope): Promise<WriteRoot[]> {
  const roots: WriteRoot[] = [];
  for (const lexical of [scope.cwd, scope.lexicalCwd, scope.skillsDir]) {
    const anchor = await deepestExistingReal(lexical);
    if (!anchor) continue;
    roots.push({ real: anchor.real, lexical: anchor.path === lexical ? undefined : lexical });
  }
  return roots;
}

/**
 * 許可 root の実パスと比較する。候補が実在すれば realpath(candidate) を、未作成なら最寄りの実在祖先の
 * realpath を使う。最終要素が壊れた symlink の候補は解決できないため拒否し、root 内を指す symlink は通す。
 *
 * 許可 root は呼び出しごとに解決し直す (結果をキャッシュしない)。未作成の root を最寄りの実在祖先の実パスで
 * 固定すると、root が後から symlink に置き換わったときに root 外の実パスを内側と誤認する。
 */
export async function isWritablePath(candidate: string, scope: WriteScope): Promise<boolean> {
  const target = resolve(candidate);
  const roots = await resolveWriteRoots(scope);
  // 未作成 root の `real` は最寄りの実在祖先なので、lexical の収まりも一緒に見る
  const inside = (real: string): boolean =>
    roots.some(
      (root) =>
        isInsideRoot(root.real, real, sep) && (root.lexical === undefined || isInsideRoot(root.lexical, target, sep)),
    );
  const real = await realpathNative(target).catch(() => undefined);
  if (real !== undefined) return inside(real);
  const anchor = await deepestExistingReal(target);
  if (!anchor) return false;
  return inside(anchor.real);
}

/**
 * 拒否の文言。許可場所 (実行 cwd と共通スキル) と cwd 相対の再試行例を含める。
 * code は付けない (SDK の edit が access の失敗を `Error code: …` に置き換えて文言が消えるため)。
 * 例は候補のパスから作らない: write は最初に親ディレクトリの mkdir が走るため、ファイル名が届かない。
 */
export function writeScopeError(candidate: string, cwd: string, skillsDir: string): Error {
  return new Error(
    `Cannot write or edit outside the session working directory: ${resolve(candidate)}. ` +
      `Allowed locations are ${cwd} (working directory) and ${skillsDir} (common skills). ` +
      "Retry with a path relative to the working directory (for example, `cafe.html`).",
  );
}
