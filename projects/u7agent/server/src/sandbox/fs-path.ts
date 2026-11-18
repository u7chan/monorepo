/**
 * サンドボックスのパス検証と、作業ディレクトリの前提。ルート境界の規則 (symlink を辿った実パスで判定する、
 * 要求パスの `..` を字句的に畳まない、書き込み許可 root を毎回引き直す) をここ 1 箇所に集める。
 * 依存は node 標準と `../errors` / `../app-paths` だけに留める (service.ts と SDK を import しない)。
 */
import { realpath as realpathCallback } from "node:fs";
import { lstat, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { COMMON_SKILLS_DIR, COMMON_SKILLS_SEGMENTS } from "../app-paths";
import { messageFor, pathError } from "../errors";

/**
 * カーネルと同じ解決順 (symlink を辿ってから `..` を適用する) で実パスを返す。
 * 解決前に `..` を path.resolve で字句的に畳んではならない (例: root/linkOutside -> outside/nested で
 * root/linkOutside/.. は outside)。非 native の fs.realpath / fs.realpathSync も同じ字句畳みをするため native を使う。
 */
export function realpathNative(target: string): Promise<string> {
  return new Promise((resolvePath, rejectPath) => {
    realpathCallback.native(target, (error, resolved) => {
      if (error) rejectPath(error);
      else resolvePath(resolved);
    });
  });
}

/** 要求パスを字句正規化せずに root へ連結する (`..` の適用は realpath に任せる)。 */
export function joinRequestPath(root: string, requested: string): string {
  if (!requested) return root;
  return isAbsolute(requested) ? requested : `${root}${sep}${requested}`;
}

export function isInsideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** root 相対の正規化パス。区切りは常に "/" (root は ".")。 */
export function relativeToRoot(root: string, target: string): string {
  const rel = relative(root, target);
  if (!rel) return ".";
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** 実在する最も深い祖先 (自身を含む)。root 配下の要求では必ず root 以前で止まる。 */ async function deepestExistingPath(
  target: string,
): Promise<string> {
  let current = target;
  for (;;) {
    const exists = await stat(current)
      .then(() => true)
      .catch(() => false);
    if (exists) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** 実在する最も深い祖先 (自身を含む) とその実パス。壊れた symlink では解決できないので undefined にする。 */
export async function deepestExistingReal(target: string): Promise<{ path: string; real: string } | undefined> {
  let current = target;
  for (;;) {
    const stats = await lstat(current).catch(() => undefined);
    if (stats) {
      const real = await realpathNative(current).catch(() => undefined);
      return real ? { path: current, real } : undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * root 相対のディレクトリを mkdir -p 相当で作る。既存ディレクトリは成功扱い。
 * 作成前に既存の最も深い祖先を realpath で検証し、root 外を指す symlink を経由した作成を防ぐ。
 */
export async function createWorkspaceDirectory(rootCwd: string, requested: string): Promise<string> {
  const root = await realpathNative(rootCwd).catch((error: unknown) => {
    throw pathError(500, `Cannot resolve the sandbox workspace: ${messageFor(error)}`);
  });

  let candidate: string;
  try {
    candidate = resolve(root, requested || ".");
  } catch {
    throw pathError(400, `Invalid path: ${requested}`);
  }
  if (!isInsideRoot(root, candidate)) throw pathError(400, `Path outside the workspace: ${candidate}`);

  const ancestor = await deepestExistingPath(candidate);
  const realAncestor = await realpathNative(ancestor).catch((error: unknown) => {
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (!isInsideRoot(root, realAncestor)) throw pathError(400, `Path outside the workspace: ${realAncestor}`);

  await mkdir(candidate, { recursive: true }).catch((error: unknown) => {
    throw pathError(400, `Cannot create directory: ${messageFor(error)}`);
  });

  // 作成後に実パスで再検証する (途中の symlink が root 外を指していた場合を取り逃さない)
  const target = await realpathNative(candidate).catch((error: unknown) => {
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (!isInsideRoot(root, target)) throw pathError(400, `Path outside the workspace: ${target}`);
  const targetStat = await stat(target).catch(() => undefined);
  if (!targetStat?.isDirectory()) throw pathError(400, `Not a directory: ${candidate}`);
  return relativeToRoot(root, target);
}

/** 要求が既に中断されているなら変更前に拒否する (開始した IO を中断では止めない) */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw pathError(400, "要求は中止されました");
}

/** 共通スキルの変更対象。lexical は要求どおりの絶対パス、real は実在したときの実パス */
export interface CommonSkillTarget {
  relativePath: string;
  lexical: string;
  real: string | undefined;
  realRoot: string;
  realSkillsDir: string | undefined;
}

/**
 * 共通スキルの SKILL.md (root 相対) を検証して解決する。workspace root 内であることに加え、root 相対の形
 * (`.agents/skills/<name>/SKILL.md`) と、最寄りの実在祖先の実パスの両方で共通スキル置き場の内側であることを
 * 要求する。置き場そのもの (`<skills>/SKILL.md`) は専用フォルダを特定できないので扱わない。
 */
export async function resolveCommonSkillTarget(input: {
  rootCwd: string;
  requested: string;
  /** 実在しない対象を 404 にする (作成のときだけ false) */
  mustExist: boolean;
}): Promise<CommonSkillTarget> {
  const { requested } = input;
  const segments = requested.split("/");
  if (!requested || requested.includes("\\") || requested.startsWith("/") || /^[A-Za-z]:/.test(requested)) {
    throw pathError(400, `Invalid skill path: ${requested}`);
  }
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw pathError(400, `Invalid skill path: ${requested}`);
  }
  if (!COMMON_SKILLS_SEGMENTS.every((segment, index) => segments[index] === segment)) {
    throw pathError(400, `Not a common skill path: ${requested}`);
  }
  // SDK は hidden のディレクトリを辿らないので、発見され得ないパスは変更対象にしない
  if (segments.slice(COMMON_SKILLS_SEGMENTS.length).some((segment) => segment.startsWith("."))) {
    throw pathError(400, `Hidden directories are not skill folders: ${requested}`);
  }
  // `<skills>/<name>/SKILL.md` より浅い配置は、専用フォルダを安全に特定できないため変更しない
  if (segments.length < COMMON_SKILLS_SEGMENTS.length + 2 || segments[segments.length - 1] !== "SKILL.md") {
    throw pathError(400, `Cannot identify the skill folder of: ${requested}`);
  }
  const lexicalRoot = resolve(input.rootCwd);
  const lexical = join(lexicalRoot, ...segments);
  if (!isInsideRoot(lexicalRoot, lexical)) throw pathError(400, `Path outside the workspace: ${lexical}`);
  const realRoot = await realpathNative(lexicalRoot).catch((error: unknown) => {
    throw pathError(500, `Cannot resolve the sandbox workspace: ${messageFor(error)}`);
  });
  const realSkillsDir = await realpathNative(join(lexicalRoot, COMMON_SKILLS_DIR)).catch(() => undefined);
  const real = await realpathNative(lexical).catch(() => undefined);
  if (realSkillsDir === undefined) {
    if (input.mustExist) throw pathError(404, `Path not found: ${lexical}`);
    // 置き場がこれから作られるときは、最寄りの実在祖先が root 内であることだけを要求する
    const anchor = await deepestExistingReal(lexical);
    if (!anchor || !isInsideRoot(realRoot, anchor.real)) {
      throw pathError(400, `Path outside the workspace: ${lexical}`);
    }
    return { relativePath: requested, lexical, real, realRoot, realSkillsDir };
  }
  if (!isInsideRoot(realRoot, realSkillsDir)) {
    throw pathError(400, `Common skills directory resolves outside the workspace: ${COMMON_SKILLS_DIR}`);
  }
  if (real !== undefined) {
    if (!isInsideRoot(realSkillsDir, real)) throw pathError(400, `Not a common skill path: ${requested}`);
  } else {
    if (input.mustExist) throw pathError(404, `Path not found: ${lexical}`);
    const anchor = await deepestExistingReal(lexical);
    if (!anchor || !isInsideRoot(realSkillsDir, anchor.real)) {
      throw pathError(400, `Not a common skill path: ${requested}`);
    }
  }
  return { relativePath: requested, lexical, real, realRoot, realSkillsDir };
}

/**
 * SDK の `loadSkillsFromDir` の結果のうち、判定に使う部分だけ。この module は SDK を import しない
 * (依存を node 標準と 2 つのアプリ module に閉じる) ので、形だけで受ける。
 */
export interface SkillScanResult {
  skills: readonly { name: string }[];
  diagnostics: readonly { message: string }[];
}

/** SDK の走査結果を、スキルとして読めない / 診断があるときの理由にする (読めれば undefined) */
export function skillScanFailure(scanned: SkillScanResult): string | undefined {
  if (scanned.skills.length !== 1 || !scanned.skills[0]) {
    const detail = scanned.diagnostics.map((item) => item.message).join(" / ");
    return `スキルとして読み込めません${detail ? `: ${detail}` : ""}`;
  }
  if (scanned.diagnostics.length > 0) return scanned.diagnostics.map((item) => item.message).join(" / ");
  return undefined;
}
