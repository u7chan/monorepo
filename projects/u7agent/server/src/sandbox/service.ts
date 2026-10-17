/**
 * サンドボックス ツール実行サービス (HTTP)。SDK の作業用ツールをこのプロセスのローカル実装で実行し、結果を NDJSON で返す。
 * LLM 認証情報をこのプロセスの環境へ入れないことはデプロイ側の前提 (サービス自身が剥がすのは共有トークンだけ)。
 * /v1/* は未認証を 401 で拒否し、/healthz だけは Compose healthcheck 用に無認証で開ける。
 */
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { realpath as realpathCallback, type Dirent, type Stats } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getShellConfig,
  loadSkillsFromDir,
  withFileMutationQueue,
  type BashSpawnContext,
  type LoadSkillsResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { COMMON_SKILLS_DIR } from "../app-paths";
import { DEFAULT_ARCHIVE_EXCLUDE_NAMES } from "../archive-rules";
import { isInjectableEnvName } from "../env-names";
import { SECRET_MASTER_KEY_ENV, SECRET_MASTER_KEY_FILE_ENV } from "../secret-crypto";
import {
  archiveContentDisposition,
  archiveDownloadName,
  archiveExcludedDirectoryError,
  archiveTooLargeError,
  DEFAULT_ARCHIVE_LIMITS,
  SKILLS_ARCHIVE_EXCLUDE_NAMES,
  SKILLS_EXPORT_NAME,
  walkArchive,
  type ArchiveLimits,
  type ArchivePlan,
} from "./archive";
import { GIT_INFO_TIMEOUT_MS, readWorkspaceGitInfo } from "./git-info";
import {
  fixedLandlockWriteRoots,
  landlockRulesEnv,
  landlockUnavailableMessage,
  LANDLOCK_MIN_ABI,
  probeLandlockStatus,
  resolveLandlockWrapper,
  type LandlockWriteRoot,
} from "./landlock";
import { SKILLS_SCAN_TIMEOUT_MS, scanSkillsWithDeadline } from "./skills-scan";
import {
  createSkillText,
  editSkillText,
  inspectSkillText,
  skillFileVersion,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from "./skill-edit";
import { probeSandboxRuntime } from "./runtime-info";
import { scanListenerRange, scanListeners } from "./process-scan";
import {
  SANDBOX_MAX_BODY_BYTES,
  SANDBOX_MAX_FILE_ENTRIES,
  SANDBOX_MAX_HANDOFF_BYTES,
  SANDBOX_MAX_LISTENER_RANGE_PORTS,
  SANDBOX_MAX_PREVIEW_BYTES,
  SANDBOX_MAX_SKILL_SAVE_BYTES,
  SANDBOX_MAX_UPLOAD_BYTES,
  DRY_RUN_QUERY_ERROR,
  encodeSandboxEvent,
  isValidEntryName,
  parseArchiveExcludeQuery,
  parseRecursiveQuery,
  parseTrueOnlyQuery,
  rawContentType,
  RECURSIVE_QUERY_ERROR,
  type SandboxCreateDirRequestBody,
  type SandboxDownloadCheck,
  type SandboxExecuteRequestBody,
  type SandboxEvent,
  type SandboxFileEntry,
  type SandboxFileListing,
  type SandboxFileUpload,
  type SandboxHandoffRollback,
  type SandboxHandoffWrite,
  type SandboxLandlockStatus,
  type SandboxMoveRequestBody,
  type SandboxMoveResult,
  type SandboxRenameRequestBody,
  type SandboxRenameResult,
  type SandboxSkillCreateBody,
  type SandboxSkillCreateResult,
  type SandboxSkillDeletePreview,
  type SandboxSkillFileDetail,
  type SandboxSkillImportApplied,
  type SandboxSkillImportPlanEntry,
  type SandboxSkillImportSkipped,
  type SandboxSkillImportStatus,
  type SandboxSkillSaveBody,
  type SandboxSkillSaveResult,
  type SandboxSkillEntry,
  type SandboxSkillsImportApply,
  type SandboxSkillsImportPlan,
  type SandboxSkillsImportResult,
  type SandboxSkillsResponse,
  type SandboxWriteScopeEntry,
} from "./protocol";
import type { SandboxRuntimeProbeResult } from "./runtime-info";
import { extractZipEntry, readZipArchive, type ZipReadArchive, type ZipReadEntry } from "./zip-read";
import { createZipStream } from "./zip";

/** サンドボックスが提供する作業用ツール名 (bash のみローカル出力をストリームする) */
export const SANDBOX_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"] as const;

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ExecuteUpdateCallback = NonNullable<Parameters<AnyToolDefinition["execute"]>[3]>;

export interface SandboxServiceOptions {
  /** 空や短すぎる値はここで弾く */
  token: string;
  rootCwd?: string;
  /** テストで小さくできるアップロード / 生配信の上限 (既定 100 MiB) */
  maxUploadBytes?: number;
  /** テストで小さくできるダウンロード (ZIP) の合計サイズ上限 (既定 100 MiB) */
  maxArchiveBytes?: number;
  /** テストで小さくできるダウンロードのエントリ数上限 (既定 10,000) */
  maxArchiveEntries?: number;
  /** テストで小さくできるスキル走査の期限 (既定 2s) */
  skillsScanTimeoutMs?: number;
  /** テストで小さくできる git 情報の期限 (既定 2s) */
  gitInfoTimeoutMs?: number;
  /** テストで差し替える git の実行パス (既定は信頼ディレクトリから解決した git) */
  gitPath?: string;
  /** テストで差し替える実行環境の診断 (既定は実プロセスでコマンドを検出する) */
  probeRuntimeInfo?: (rootCwd: string) => Promise<SandboxRuntimeProbeResult>;
  /** テストで差し替えるラッパーの解決 (既定は固定パスの実体を確認して解決する) */
  resolveLandlockExec?: () => string | undefined;
  /** テストで差し替える Landlock の診断 (既定はラッパーの `--abi` を実行する) */
  probeLandlock?: () => Promise<SandboxLandlockStatus>;
}

export interface SandboxService {
  app: Hono;
  executions: Map<string, AbortController>;
  close: () => void;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 長さを漏らさないための定数時間比較 (sha256 で同じ長さに揃える)。 */
function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function normalizeToolCallId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

/**
 * カーネルと同じ解決順 (symlink を辿ってから `..` を適用する) で実パスを返す。
 * 解決前に `..` を path.resolve で字句的に畳んではならない (例: root/linkOutside -> outside/nested で
 * root/linkOutside/.. は outside)。非 native の fs.realpath / fs.realpathSync も同じ字句畳みをするため native を使う。
 */
function realpathNative(target: string): Promise<string> {
  return new Promise((resolvePath, rejectPath) => {
    realpathCallback.native(target, (error, resolved) => {
      if (error) rejectPath(error);
      else resolvePath(resolved);
    });
  });
}

/** 要求パスを字句正規化せずに root へ連結する (`..` の適用は realpath に任せる)。 */
function joinRequestPath(root: string, requested: string): string {
  if (!requested) return root;
  return isAbsolute(requested) ? requested : `${root}${sep}${requested}`;
}

/** 上限を超えたボディは 413。 */
async function readJsonBody(request: Request): Promise<unknown> {
  const body = request.body;
  if (!body) return {};
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SANDBOX_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  return parsed;
}

/**
 * root 相対の要求パスを解決し、実在するディレクトリで root 配下であることを検証する。
 * ツール実行の cwd と一覧の共通の入口で、`..` の適用順はカーネル (symlink → `..`) に合わせる。
 */
async function resolveWorkspaceDirectory(
  rootCwd: string,
  requested: string,
  directory = true,
): Promise<{ root: string; target: string }> {
  // root 自体も realpath で解決し、両辺を実パスで比較する (root の symlink 経由でも判定が崩れないように)
  const root = await realpathNative(rootCwd).catch((error: unknown) => {
    throw pathError(500, `Cannot resolve the sandbox workspace: ${messageFor(error)}`);
  });

  // メッセージ表示と、実在しない要求の lexical 判定に使う字句正規化済みのパス
  let candidate: string;
  try {
    candidate = resolve(root, requested || ".");
  } catch {
    throw pathError(400, `Invalid path: ${requested}`);
  }

  // 字句的に畳んでから realpath へ渡すと `..` が symlink より先に適用され、カーネルの解決順とずれる。
  // 生の要求パスを native realpath (realpath(3)) に渡し、symlink を辿ってから `..` を解決させる。
  const target = await realpathNative(joinRequestPath(root, requested)).catch((error: unknown) => {
    // 解決できない = 実在しない (か解決不能) なので、lexical な位置で判定する。
    // root 外の未作成パスを 404 にすると「root 外は 400」の入力検証が抜ける。
    if (!isInsideRoot(root, candidate)) throw pathError(400, `Path outside the workspace: ${candidate}`);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${candidate}`);
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (!isInsideRoot(root, target)) throw pathError(400, `Path outside the workspace: ${target}`);

  const targetStat = await stat(target).catch(() => undefined);
  if (!targetStat) throw pathError(404, `Path not found: ${candidate}`);
  if (directory && !targetStat.isDirectory()) throw pathError(400, `Not a directory: ${candidate}`);
  if (!directory && !targetStat.isFile()) throw pathError(400, `Not a regular file: ${candidate}`);
  return { root, target };
}

/**
 * 引き継ぎメモの実パスを求める。親ディレクトリを realpath で検証し、最終要素は lstat で見て
 * symlink と通常ファイル以外を拒む (realpath で実体に解決すると root 外を読めてしまう)。
 * `existing` は最終要素が実在するか (読取りの 404 と書込みの新規作成の判定に使う)。
 * 不存在として扱うのは ENOENT だけで、権限エラーなどの lstat 失敗は呼び出し側へ伝播させ、
 * 下準備で「読み取れない」として拒否させる (読み取り不能を空の本文や新規作成として扱わない)。
 */
async function resolveHandoffPath(rootCwd: string, requested: string): Promise<{ target: string; existing: boolean }> {
  const name = basename(requested);
  if (!requested || requested.endsWith("/") || name === "." || name === "..") {
    throw pathError(400, `Not a regular file: ${requested}`);
  }
  const parent = await resolveWorkspaceDirectory(rootCwd, dirname(requested));
  const target = join(parent.target, name);
  const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw pathError(400, `Cannot inspect the handoff memo (${requested}): ${messageFor(error)}`);
  });
  if (stats?.isSymbolicLink()) throw pathError(400, `Symbolic links cannot be read or written: ${requested}`);
  if (stats && !stats.isFile()) throw pathError(400, `Not a regular file: ${requested}`);
  return { target, existing: stats !== undefined };
}

/**
 * 引き継ぎメモ (HANDOFF.md) の読み取り。上限・UTF-8・バイナリの判定を引き継ぎ専用に持ち、
 * プレビューの上限 (SANDBOX_MAX_PREVIEW_BYTES) の変更に追随させない。
 */
async function readHandoffText(target: string): Promise<string> {
  const handle = await open(target, "r");
  try {
    if (!(await handle.stat()).isFile()) throw pathError(400, "Not a regular file");
    const limit = SANDBOX_MAX_HANDOFF_BYTES;
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw pathError(400, "HANDOFF.md は 2 MiB 以下にしてください");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } catch {
      throw pathError(400, "HANDOFF.md は UTF-8 のテキストファイルにしてください");
    }
    // oxlint-disable-next-line no-control-regex -- バイナリ判定のため制御文字を検出する。
    if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw pathError(400, "バイナリの HANDOFF.md は扱えません");
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * 同一の実パスへの書き込みを直列化する。読んでから書くまでの間に他の追記が入っても、
 * その上へ重ねられる (作業フォルダを共有する別の会話の引き継ぎも残す)。
 */
function withPathLock<T>(locks: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const operation = previous.then(run, run);
  const settled = operation.then(
    () => {},
    () => {},
  );
  locks.set(key, settled);
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return operation;
}

/**
 * 引き継ぎメモを先頭へ追記する。既存の本文は解釈せず、先頭行に dedupeKey があるときだけ追記を省く
 * (同じ材料からの再試行で二重にしない)。書込みは一時ファイル + rename で原子的にする。
 */
async function writeHandoffText(
  rootCwd: string,
  requested: string,
  section: string,
  dedupeKey: string,
  locks: Map<string, Promise<unknown>>,
): Promise<SandboxHandoffWrite> {
  const { target } = await resolveHandoffPath(rootCwd, requested);
  return withPathLock(locks, target, async () => {
    // 排他の先頭で読み直す (背後で進んだ他の追記の上へ重ね、上限も全文で判定する)
    const { existing } = await resolveHandoffPath(rootCwd, requested);
    const current = existing ? await readHandoffText(target) : undefined;
    const firstLine = current === undefined ? "" : (current.split("\n", 1)[0] ?? "");
    if (dedupeKey !== "" && firstLine.includes(dedupeKey)) {
      return { path: requested, written: false, created: false };
    }
    // 事前判定の後に他の追記が入っていても、追記後の全文を上限に収める (両方が 200 で超過するのを防ぐ)
    const total = Buffer.byteLength(current ?? "", "utf8") + Buffer.byteLength(section, "utf8");
    if (total > SANDBOX_MAX_HANDOFF_BYTES) {
      throw pathError(400, "HANDOFF.md は 2 MiB 以下にしてください");
    }
    const temp = join(dirname(target), `.pi-handoff-${randomUUID()}.part`);
    try {
      await writeFile(temp, `${section}${current ?? ""}`, { mode: 0o600 });
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw pathError(400, `Cannot write the handoff memo: ${messageFor(error)}`);
    }
    return { path: requested, written: true, created: !existing };
  });
}

/**
 * 新規作成した引き継ぎメモの取り消し。内容が `expected` と一致するときだけ削除する。照合から削除までを
 * 追記と同じ実パス排他の中で行い、背後で進んだ他の追記や編集を巻き戻さない。
 */
async function rollbackHandoffText(
  rootCwd: string,
  requested: string,
  expected: string,
  locks: Map<string, Promise<unknown>>,
): Promise<SandboxHandoffRollback> {
  const { target } = await resolveHandoffPath(rootCwd, requested);
  return withPathLock(locks, target, async () => {
    const { existing } = await resolveHandoffPath(rootCwd, requested);
    if (!existing) return { deleted: false };
    // 照合できない (上限・形式・読取り失敗) ときは消さない。他の追記を巻き戻す側に倒さない
    const current = await readHandoffText(target).catch(() => undefined);
    if (current !== expected) return { deleted: false };
    await unlink(target);
    return { deleted: true };
  });
}

/**
 * root 相対のディレクトリを mkdir -p 相当で作る。既存ディレクトリは成功扱い。
 * 作成前に既存の最も深い祖先を realpath で検証し、root 外を指す symlink を経由した作成を防ぐ。
 */
async function createWorkspaceDirectory(rootCwd: string, requested: string): Promise<string> {
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

/**
 * root 相対の通常ファイルを消す。symlink は拒否する (realpath で実体に解決してから消すと、root 内のリンクが
 * 指す root 外のファイルを消せてしまう)。要求パスの最終要素だけを lstat で見て、親は一覧と同じ解決を通す。
 * 親は要求パスの字句の dirname を native realpath へ渡し、`..` を symlink の後に適用させる (一覧と同じ)。
 */
async function removeWorkspaceFile(rootCwd: string, requested: string): Promise<void> {
  // 最終要素が消す対象の名前。`.` / `..` / 空 (root 自身) と末尾の区切りは通常ファイルではない
  const name = basename(requested);
  if (!requested || requested.endsWith("/") || name === "." || name === "..") {
    throw pathError(400, `Not a regular file: ${requested}`);
  }

  // 字句解決済みの candidate から親を作ると `..` が symlink より先に適用され、一覧と別のファイルを指す
  const parent = await resolveWorkspaceDirectory(rootCwd, dirname(requested));
  const target = join(parent.target, name);

  const targetStat = await lstat(target).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (targetStat.isSymbolicLink()) throw pathError(400, `Symbolic links cannot be deleted: ${target}`);
  if (!targetStat.isFile()) throw pathError(400, `Not a regular file: ${target}`);

  await unlink(target).catch((error: unknown) => {
    // lstat の直後に bash などが消した場合は目的を達しているため成功にする
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw pathError(400, `Cannot delete the file: ${messageFor(error)}`);
  });
}

/**
 * root 相対のディレクトリを消す。recursive のときだけ配下ごとで、省略時は空ディレクトリのみ (rmdir)。
 * symlink は削除対象そのものとして拒否する (realpath で実体へ解決してから消すと、root 内のリンクが指す
 * root 外を消せてしまう)。配下の symlink は fs.rm が辿らず、リンクだけを unlink してリンク先は残す (rm -rf と同じ)。
 */
async function removeWorkspaceDirectory(rootCwd: string, requested: string, recursive: boolean): Promise<void> {
  // 最終要素が消す対象の名前。`.` / `..` / 空 (root 自身) と末尾の区切りはディレクトリを表さない
  const name = basename(requested);
  if (!requested || requested.endsWith("/") || name === "." || name === "..") {
    throw pathError(400, `Not a directory: ${requested}`);
  }

  // 親の解決は一覧 / ファイル削除と同じ (要求パスの字句 dirname を native realpath に渡し、`..` を symlink の後に適用する)
  const parent = await resolveWorkspaceDirectory(rootCwd, dirname(requested));
  const target = join(parent.target, name);

  const targetStat = await lstat(target).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (targetStat.isSymbolicLink()) throw pathError(400, `Symbolic links cannot be deleted: ${target}`);
  if (!targetStat.isDirectory()) throw pathError(400, `Not a directory: ${target}`);

  if (recursive) {
    await rm(target, { recursive: true }).catch((error: unknown) => {
      // lstat の直後に bash などが消した場合は目的を達しているため成功にする
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw pathError(400, `Cannot delete the directory: ${messageFor(error)}`);
    });
    return;
  }

  await rmdir(target).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // 非空ディレクトリは recursive の明示が無い限り消さない (部分削除も起こさない)
    if (code === "ENOTEMPTY" || code === "EEXIST") throw pathError(400, `Directory is not empty: ${target}`);
    throw pathError(400, `Cannot delete the directory: ${messageFor(error)}`);
  });
}

/**
 * root 相対のエントリ (通常ファイル / ディレクトリ) の名前を変える。symlink は拒否する (realpath で実体へ解決してから
 * rename すると、root 内のリンクが指す root 外を動かせてしまう)。要求パスの最終要素だけを lstat で見て、
 * 親は一覧と同じ解決を通す。改名先が既存でも、lstat と realpath が同じ実体を指すなら通す (大文字小文字だけの変更)。
 */
async function renameWorkspaceEntry(rootCwd: string, requested: string, name: string): Promise<SandboxRenameResult> {
  // 最終要素が動かす対象の名前。`.` / `..` / 空 (root 自身) と末尾の区切りはエントリを表さない
  const currentName = basename(requested);
  if (!requested || requested.endsWith("/") || currentName === "." || currentName === "..") {
    throw pathError(400, `Not a file or directory: ${requested}`);
  }

  // 親の解決は一覧 / 削除と同じ (要求パスの字句 dirname を native realpath へ渡し、`..` を symlink の後に適用する)
  const parent = await resolveWorkspaceDirectory(rootCwd, dirname(requested));
  const target = join(parent.target, currentName);

  const targetStat = await lstat(target).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (targetStat.isSymbolicLink()) throw pathError(400, `Symbolic links cannot be renamed: ${target}`);
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw pathError(400, `Not a file or directory: ${target}`);
  }

  // 名前は 1 セグメントだけなので、親の実パスへ連結すれば root 内に収まる
  const nextPath = join(parent.target, name);
  // 既存があっても実体が同じなら通す。symlink は実体が同じでも別のエントリなので上書きしない
  const existing = await lstat(nextPath).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || (await realpathNative(nextPath).catch(() => undefined)) !== target)) {
    throw pathError(409, `Already exists: ${nextPath}`);
  }

  await rename(target, nextPath).catch((error: unknown) => {
    // lstat の直後に他の実行が消した場合は動かす対象が無い
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot rename: ${messageFor(error)}`);
  });
  return { path: relativeToRoot(parent.root, nextPath), name };
}

/**
 * root 相対のエントリ (通常ファイル / ディレクトリ) を別の親へ移す。symlink は拒否する (realpath で実体へ解決してから
 * rename すると、root 内のリンクが指す root 外を動かせてしまう)。移動元と移動先の親は一覧と同じ解決に通し、
 * 移動先の最終要素だけを 1 セグメント名として検証する。既存の移動先へは上書きしない (rename と同じ扱い)。
 */
async function moveWorkspaceEntry(rootCwd: string, from: string, to: string): Promise<SandboxMoveResult> {
  // 最終要素が動かす対象の名前。`.` / `..` / 空 (root 自身) と末尾の区切りはエントリを表さない
  const currentName = basename(from);
  if (!from || from.endsWith("/") || currentName === "." || currentName === "..") {
    throw pathError(400, `Not a file or directory: ${from}`);
  }

  // 移動先の最終要素はリネーム先と同じ 1 セグメント名 (空・`.` / `..`・区切り・制御文字は 400)
  const nextName = basename(to);
  if (!to || to.endsWith("/") || !isValidEntryName(nextName)) {
    throw pathError(400, `Invalid name: ${to}`);
  }

  // 親の解決は一覧 / 削除 / リネームと同じ (要求パスの字句 dirname を native realpath へ渡し、`..` を symlink の後に適用する)
  const parent = await resolveWorkspaceDirectory(rootCwd, dirname(from));
  const target = join(parent.target, currentName);

  const targetStat = await lstat(target).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (targetStat.isSymbolicLink()) throw pathError(400, `Symbolic links cannot be moved: ${target}`);
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw pathError(400, `Not a file or directory: ${target}`);
  }

  // 移動先の親は root 内の実在ディレクトリ。無ければ呼び出し側が POST /v1/dirs で作ってから呼ぶ
  const nextParent = await resolveWorkspaceDirectory(rootCwd, dirname(to));
  const nextPath = join(nextParent.target, nextName);

  // 既存があっても実体が同じなら通す (リネームと同じ規則)。symlink は実体が同じでも上書きしない
  const existing = await lstat(nextPath).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || (await realpathNative(nextPath).catch(() => undefined)) !== target)) {
    throw pathError(409, `Already exists: ${nextPath}`);
  }

  await rename(target, nextPath).catch((error: unknown) => {
    // lstat の直後に他の実行が消した場合は動かす対象が無い
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot move: ${messageFor(error)}`);
  });
  return { path: relativeToRoot(nextParent.root, nextPath) };
}

/** 解決だけをしたダウンロード対象。archive の `size` は使わない（`planDownload` が `walk` を付ける） */
interface DownloadTarget {
  kind: "file" | "archive";
  /** 保存名の元。ファイルはその名前、ZIP はフォルダ名（`.zip` は応答で付ける） */
  name: string;
  /** 実パス */
  target: string;
  /** file のサイズ */
  size: number;
}

/** ダウンロードの計画。file は生配信、archive は走査済みの ZIP。 */
type DownloadPlan = ({ kind: "file" } & DownloadTarget) | ({ kind: "archive"; walk: ArchivePlan } & DownloadTarget);

/**
 * root 相対のダウンロード対象を解決する。最終要素は削除 / リネームと同じ lstat で見て、symlink は辿らず拒否する
 * （リンク先の内容を配ると root 内に閉じる検証を迂回する）。root 自身（`""` / `"."` / 末尾区切りのみ）は
 * ディレクトリとして扱い、フォルダ名には解決後の実ディレクトリ名を使う。
 */
async function resolveDownloadTarget(rootCwd: string, requestedRaw: string): Promise<DownloadTarget> {
  // 末尾の区切りは同じ対象を指すため落とす (`..` の適用順を変える字句正規化はしない)
  const requested = requestedRaw.replace(/\/+$/, "");
  if (!requested || requested === ".") {
    const { root, target } = await resolveWorkspaceDirectory(rootCwd, "", true);
    return { kind: "archive", name: basename(root) || "workspace", target, size: 0 };
  }

  const name = basename(requested);
  // 最終要素が親参照なら root の外を指し得る。削除 / リネームと同じく受け付けない (root 自身は上の分岐で扱う)
  if (name === "." || name === "..") throw pathError(400, `Not a file or directory: ${requested}`);
  // 親の解決は一覧 / 削除 / リネームと同じ (要求パスの字句 dirname を native realpath へ渡す)
  const parent = await resolveWorkspaceDirectory(rootCwd, dirname(requested));
  const target = join(parent.target, name);
  const targetStat = await lstat(target).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target}`);
    throw pathError(400, `Cannot resolve path: ${messageFor(error)}`);
  });
  if (targetStat.isSymbolicLink()) throw pathError(400, `Symbolic links cannot be downloaded: ${target}`);
  if (targetStat.isFile()) return { kind: "file", name, target, size: targetStat.size };
  if (targetStat.isDirectory()) return { kind: "archive", name, target, size: 0 };
  throw pathError(400, `Not a file or directory: ${target}`);
}

/**
 * 事前チェックと本文送出が共有する計画。walk はヘッダを送る前に終わらせ、除外名のディレクトリ・
 * サイズ超過・件数超過を 4xx で返す（途中で切れた zip を配らない）。
 */
async function planDownload(input: {
  rootCwd: string;
  requested: string;
  excludeNames: readonly string[];
  limits: ArchiveLimits;
}): Promise<DownloadPlan> {
  const target = await resolveDownloadTarget(input.rootCwd, input.requested);
  if (target.kind === "file") {
    if (target.size > input.limits.maxBytes) throw archiveTooLargeError(input.limits.maxBytes);
    return { ...target, kind: "file" };
  }
  // 除外名のディレクトリそのものを指定されたら断る (UI は行に導線を出さないが、直叩きも防ぐ)
  if (input.excludeNames.includes(target.name)) throw archiveExcludedDirectoryError(target.name);
  const walk = await walkArchive({ dir: target.target, excludeNames: input.excludeNames, limits: input.limits });
  return { ...target, kind: "archive", walk };
}

/** 事前チェックの応答。見積りは download と同じ計画から導く（エラーの出どころを 1 つにする）。 */
function downloadCheckFor(plan: DownloadPlan): SandboxDownloadCheck {
  if (plan.kind === "file") return { kind: "file", name: plan.name, bytes: plan.size, entries: 0, skipped: [] };
  return {
    kind: "archive",
    name: archiveDownloadName(plan.name),
    bytes: plan.walk.bytes,
    entries: plan.walk.entryCount,
    skipped: plan.walk.skipped,
  };
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

/** 同名を上書きしない保存名の候補。`name-1.ext` と連番で進め、上限に達したらランダム suffix にする。 */
const MAX_RENAME_ATTEMPTS = 100;

function* uploadCandidateNames(name: string): Generator<string> {
  yield name;
  const parsed = parse(name);
  for (let index = 1; index <= MAX_RENAME_ATTEMPTS; index += 1) {
    yield `${parsed.name}-${index}${parsed.ext}`;
  }
  for (;;) {
    yield `${parsed.name}-${randomUUID().slice(0, 8)}${parsed.ext}`;
  }
}

/**
 * dir 配下へ body をストリームで書き、排他作成した最終名を返す。途中で切れた upload は temp を残さない。
 */
async function saveUploadedFile(input: {
  rootCwd: string;
  dir: string;
  name: string;
  body: ReadableStream<Uint8Array> | null;
  maxBytes: number;
}): Promise<SandboxFileUpload> {
  const dirRel = await createWorkspaceDirectory(input.rootCwd, input.dir);
  const root = await realpathNative(input.rootCwd);
  const dirAbs = dirRel === "." ? root : join(root, dirRel);
  const tempPath = join(dirAbs, `.pi-upload-${randomUUID()}.part`);
  const handle = await open(tempPath, "wx", 0o666);
  let size = 0;
  try {
    if (input.body) {
      const reader = input.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > input.maxBytes) {
            await reader.cancel().catch(() => {});
            throw pathError(413, `File is too large (max ${input.maxBytes} bytes)`);
          }
          await handle.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    await handle.close();
    const saved = await linkUniqueName(tempPath, dirAbs, input.name);
    return {
      path: relativeToRoot(root, saved.path),
      name: saved.name,
      renamed: saved.name !== input.name,
      size,
    };
  } finally {
    // 成功・失敗のどちらでも temp は残さない (成功時は link 済みの最終名が残る)
    await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
  }
}

/** link(2) で排他作成する。既存があれば候補を進めるため、並行アップロードでも上書きしない。 */
async function linkUniqueName(tempPath: string, dirAbs: string, name: string): Promise<{ path: string; name: string }> {
  for (const candidate of uploadCandidateNames(name)) {
    const target = join(dirAbs, candidate);
    try {
      await link(tempPath, target);
      return { path: target, name: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw pathError(400, `Cannot save the uploaded file: ${messageFor(error)}`);
    }
  }
  throw pathError(500, "Cannot save the uploaded file");
}

function pathError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * root 相対の要求パスを解決して一覧を返す。root 内外は「`..` の有無」ではなく realpath で解決した実パスで判定するため、
 * root 外にある symlink (`../link-in` など) から root 内へ解決する要求も 200 になる。
 * エラー文言は SDK の ls ツールに寄せる (BFF はサンドボックスの文言をそのままクライアントへ返す)。
 */
async function listWorkspaceDirectory(rootCwd: string, requested: string): Promise<SandboxFileListing> {
  const { root, target } = await resolveWorkspaceDirectory(rootCwd, requested);

  const dirents = await readdir(target, { withFileTypes: true }).catch((error: unknown) => {
    throw pathError(400, `Cannot read directory: ${messageFor(error)}`);
  });
  // 並び替え (ディレクトリ先 → ファイル) には実体の種別が要るため、先に symlink だけ辿る。
  // その stat は size / mtime に再利用し、下の走査で取る stat は打ち切り分だけに抑える。
  const candidates = await Promise.all(dirents.map((dirent) => classifyEntry(target, dirent)));
  candidates.sort(compareEntries);
  const truncated = candidates.length > SANDBOX_MAX_FILE_ENTRIES;

  const entries: SandboxFileEntry[] = [];
  for (const candidateEntry of candidates.slice(0, SANDBOX_MAX_FILE_ENTRIES)) {
    const entry: SandboxFileEntry = { name: candidateEntry.name, type: candidateEntry.type };
    if (candidateEntry.symlink) entry.symlink = true;
    // symlink は辿った先、それ以外は lstat。壊れた symlink は stat が無いので size / mtime を付けない
    const stats = candidateEntry.symlink
      ? candidateEntry.target
      : await lstat(join(target, candidateEntry.name)).catch(() => undefined);
    if (stats) {
      // size はファイルだけ。ディレクトリの size はファイルの内容量を表さない
      if (candidateEntry.type === "file") entry.size = stats.size;
      entry.mtime = Math.round(stats.mtimeMs);
    }
    entries.push(entry);
  }

  return {
    // 解決後の実ディレクトリを root 相対で返す (root 外の別名から解決した場合も root 内のパスになる)
    path: relativeToRoot(root, target),
    entries,
    truncated,
  };
}

/**
 * root 相対のディレクトリ配下のスキルを発見する。走査規則 (hidden・node_modules のスキップ、ignore ファイル、
 * 再帰、frontmatter 検証) は SDK の loadSkillsFromDir に委譲し、返すのは SKILL.md だけにする
 * (SDK は直下の非 SKILL.md も読むが、`.agents/skills` の規約とずれるため落とす)。
 * SDK は子ディレクトリと SKILL.md の symlink を辿るため、realpath が root 外になるものは除外する。
 * 応答の path は realpath に揃え、同じ実体へ解決する重複 (symlink 経由・循環リンク) は 1 件に畳む。
 * 走査は別スレッドで実行し、循環 symlink による指数的増殖では期限で打ち切る (skills-scan.ts)。
 */
async function listWorkspaceSkills(
  rootCwd: string,
  requestedDir: string,
  scanTimeoutMs: number,
): Promise<SandboxSkillsResponse> {
  const { root, target } = await resolveWorkspaceDirectory(rootCwd, requestedDir);

  const skills: SandboxSkillEntry[] = [];
  const seen = new Set<string>();
  for (const skill of (await scanSkillsWithDeadline(target, scanTimeoutMs)).skills) {
    if (basename(skill.filePath) !== "SKILL.md") continue;
    const real = await realpathNative(skill.filePath).catch(() => undefined);
    if (!real || !isInsideRoot(root, real) || seen.has(real)) continue;
    seen.add(real);
    skills.push({
      name: skill.name,
      description: skill.description,
      path: real,
      disableModelInvocation: skill.disableModelInvocation,
    });
  }
  return { skills };
}

function isInsideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * write / edit が書ける範囲 (ファイルツールのポリシー)。許可 root は実行 cwd (realpath)・要求 cwd の
 * lexical 形 (root / 登録ディレクトリが symlink でも system prompt に出た絶対パスを通す)・共通スキル置き場の 3 つ。
 * bash 側の強制は Landlock (このファイルの writeScope 導出) が担い、ここはモデルの取り違えを防ぐ。
 */
interface WriteScope {
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

/** 実在する最も深い祖先 (自身を含む) とその実パス。壊れた symlink では解決できないので undefined にする。 */
async function deepestExistingReal(target: string): Promise<{ path: string; real: string } | undefined> {
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
async function isWritablePath(candidate: string, scope: WriteScope): Promise<boolean> {
  const target = resolve(candidate);
  const roots = await resolveWriteRoots(scope);
  // 未作成 root の `real` は最寄りの実在祖先なので、lexical の収まりも一緒に見る
  const inside = (real: string): boolean =>
    roots.some(
      (root) => isInsideRoot(root.real, real) && (root.lexical === undefined || isInsideRoot(root.lexical, target)),
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
function writeScopeError(candidate: string, cwd: string, skillsDir: string): Error {
  return new Error(
    `Cannot write or edit outside the session working directory: ${resolve(candidate)}. ` +
      `Allowed locations are ${cwd} (working directory) and ${skillsDir} (common skills). ` +
      "Retry with a path relative to the working directory (for example, `cafe.html`).",
  );
}

/**
 * symlink は辿った先の種別に寄せる (壊れた symlink は file として出す)。
 * 辿った stat は一覧の mtime に再利用するため捨てずに返す (壊れた symlink は undefined)。
 */
async function classifyEntry(
  dirPath: string,
  dirent: Dirent,
): Promise<{ name: string; type: "file" | "dir"; symlink: boolean; target: Stats | undefined }> {
  const name = dirent.name;
  if (!dirent.isSymbolicLink()) {
    return { name, type: dirent.isDirectory() ? "dir" : "file", symlink: false, target: undefined };
  }
  const followed = await stat(join(dirPath, name)).catch(() => undefined);
  return { name, type: followed?.isDirectory() ? "dir" : "file", symlink: true, target: followed };
}

/** ディレクトリ先 → ファイル、各グループ内は大文字小文字を無視した昇順 (同順はコード順で安定させる)。 */
function compareEntries(a: { name: string; type: "file" | "dir" }, b: { name: string; type: "file" | "dir" }): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  const ignoringCase = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (ignoringCase !== 0) return ignoringCase;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** root 相対の正規化パス。区切りは常に "/" (root は ".")。 */
function relativeToRoot(root: string, target: string): string {
  const rel = relative(root, target);
  if (!rel) return ".";
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/**
 * 共通スキル (`.agents/skills`) の GUI CRUD の面倒な依存。service のオプションから組み立てる。
 * 走査の期限と削除の走査上限は既存の値をそのまま使う (GUI 用の別上限を作らない)。
 */
interface SkillCrudContext {
  rootCwd: string;
  scanTimeoutMs: number;
  archiveLimits: ArchiveLimits;
  /** 取り込みの受信 ZIP の上限 (アップロードと同じ値) */
  maxUploadBytes: number;
  /** 共通スキル置き場の外側 gate。SDK のファイル隊列より先に取る (順序を固定する) */
  gate: <T>(run: () => Promise<T>) => Promise<T>;
}

/** 共通スキル置き場の root 相対セグメント */
const COMMON_SKILLS_SEGMENTS = COMMON_SKILLS_DIR.split("/");

/** 共通スキルの変更対象。lexical は要求どおりの絶対パス、real は実在したときの実パス */
interface CommonSkillTarget {
  relativePath: string;
  lexical: string;
  real: string | undefined;
  realRoot: string;
  realSkillsDir: string | undefined;
}

/**
 * 順番待ちの非同期 gate。専用の待機 timeout を持たず (SDK のファイル隊列と同じ)、開始済みの IO が
 * 終わる前に解放しない。共通スキル置き場の中だけを直列化するために使う。
 */
function createAsyncGate(): <T>(run: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

/** 要求が既に中断されているなら変更前に拒否する (開始した IO を中断では止めない) */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw pathError(400, "要求は中止されました");
}

/** JSON body から必要な文字列フィールドだけを読む。型違いと欠落は 400 にする (余分なキーは無視する) */
function skillTextFieldsOf(
  body: unknown,
  keys: readonly string[],
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const value: Record<string, string> = {};
  for (const key of keys) {
    const raw = (body as Record<string, unknown>)[key];
    if (typeof raw !== "string") return { ok: false, message: `${key} must be a string` };
    value[key] = raw;
  }
  return { ok: true, value };
}

/**
 * 共通スキルの SKILL.md (root 相対) を検証して解決する。workspace root 内であることに加え、root 相対の形
 * (`.agents/skills/<name>/SKILL.md`) と、最寄りの実在祖先の実パスの両方で共通スキル置き場の内側であることを
 * 要求する。置き場そのもの (`<skills>/SKILL.md`) は専用フォルダを特定できないので扱わない。
 */
async function resolveCommonSkillTarget(input: {
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
 * 既存のファイル変更 API が共通スキル置き場へ影響し得るか。`inside` は置き場とその配下だけ、
 * `any` は置き場の祖先 (改名 / 移動 / 削除で置き場ごと動く) も含める。判定できないときは安全側へ倒す。
 */
async function touchesCommonSkills(input: {
  rootCwd: string;
  requested: string;
  mode: "inside" | "any";
}): Promise<boolean> {
  const lexicalRoot = resolve(input.rootCwd);
  const lexical = resolve(lexicalRoot, input.requested || ".");
  if (!isInsideRoot(lexicalRoot, lexical)) return true;
  const skillsLexical = join(lexicalRoot, COMMON_SKILLS_DIR);
  const realSkills = await realpathNative(skillsLexical).catch(() => undefined);
  if (realSkills === undefined) {
    if (isInsideRoot(skillsLexical, lexical)) return true;
    return input.mode === "any" && isInsideRoot(lexical, skillsLexical);
  }
  const anchor = await deepestExistingReal(lexical);
  const target = anchor?.real ?? lexical;
  if (isInsideRoot(realSkills, target)) return true;
  return input.mode === "any" && isInsideRoot(target, realSkills);
}

/** 共通スキルの SKILL.md の内容と版。読みと検証は常にこの組で扱う */
interface CommonSkillFileContent {
  text: string;
  version: string;
}

async function readCommonSkillContent(
  target: CommonSkillTarget,
  signal?: AbortSignal,
): Promise<CommonSkillFileContent> {
  throwIfAborted(signal);
  const bytes = await readFile(target.lexical).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target.lexical}`);
    throw pathError(400, `Cannot read the skill file: ${messageFor(error)}`);
  });
  return { text: decodeUtf8(bytes), version: skillFileVersion(bytes) };
}

/** UTF-8 のテキストだけを受け付ける (GUI はテキストを編集する) */
function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw pathError(400, "UTF-8 のテキストではないため編集できません");
  }
}

/** 発見した一覧から実パスが一致する 1 件を取る (GUI の要求は一覧の relativePath に揃う) */
async function discoverCommonSkill(
  context: SkillCrudContext,
  realFile: string,
): Promise<SandboxSkillEntry | undefined> {
  const discovery = await listWorkspaceSkills(context.rootCwd, COMMON_SKILLS_DIR, context.scanTimeoutMs);
  return discovery.skills.find((skill) => skill.path === realFile);
}

/** 編集内容の取得。name / description は SDK の発見結果、body は trim していない原文 */
async function readCommonSkillDetail(
  context: SkillCrudContext,
  requested: string,
  signal?: AbortSignal,
): Promise<SandboxSkillFileDetail> {
  const target = await resolveCommonSkillTarget({ rootCwd: context.rootCwd, requested, mustExist: true });
  const content = await readCommonSkillContent(target, signal);
  const info = inspectSkillText(content.text);
  const entry = target.real ? await discoverCommonSkill(context, target.real) : undefined;
  const folderName = basename(dirname(target.lexical));
  const relativePath = target.real ? relativeToRoot(target.realRoot, target.real) : target.relativePath;
  // 保存の要求は BFF の bodyGuard を通るため、上限を超えるファイルは閲覧だけにする
  const tooLarge = Buffer.byteLength(content.text, "utf8") > SANDBOX_MAX_SKILL_SAVE_BYTES;
  const editable = info.reason === undefined && entry !== undefined && !tooLarge;
  const reason =
    info.reason ??
    (entry === undefined
      ? "現在の内容をスキルとして読み込めません"
      : tooLarge
        ? `保存の要求の上限 (${Math.floor(SANDBOX_MAX_SKILL_SAVE_BYTES / 1024)} KiB) を超えるため保存できません`
        : undefined);
  return {
    name: entry?.name ?? info.name ?? folderName,
    description: entry?.description ?? info.description ?? "",
    body: info.body,
    relativePath,
    fileVersion: content.version,
    editable,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** SDK の走査結果を、スキルとして読めない / 診断があるときの理由にする (読めれば undefined) */
function skillScanFailure(scanned: LoadSkillsResult): string | undefined {
  if (scanned.skills.length !== 1 || !scanned.skills[0]) {
    const detail = scanned.diagnostics.map((item) => item.message).join(" / ");
    return `スキルとして読み込めません${detail ? `: ${detail}` : ""}`;
  }
  if (scanned.diagnostics.length > 0) return scanned.diagnostics.map((item) => item.message).join(" / ");
  return undefined;
}

/**
 * フォルダ 1 つを SDK にスキルとして読ませる。新しいスキルの作成と同じ判定で、
 * 1 件だけ読めて診断が 1 件も無いことを要求する (取り込みの staging で使う)。
 */
async function diagnoseSkillFolder(
  folder: string,
): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const scanned = await loadSkillsFromDir({ dir: folder, source: "u7agent" });
  const failure = skillScanFailure(scanned);
  if (failure !== undefined) return { ok: false, message: failure };
  const skill = scanned.skills[0];
  if (!skill) return { ok: false, message: "スキルとして読み込めません" };
  return { ok: true, name: skill.name };
}

/** 一時ディレクトリで SDK に候補を読ませる。公開前の検証を SDK の規則だけで行う */
async function diagnoseSkillCandidate(input: {
  text: string;
  /** 変更前の内容。既存の name / 説明由来の warning は許し、新しい warning だけを拒否する */
  baseline?: { text: string };
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-skill-check-"));
  try {
    const write = async (name: string, text: string): Promise<string> => {
      const folder = join(dir, name);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "SKILL.md"), text, "utf8");
      return folder;
    };
    if (!input.baseline) {
      const staged = await diagnoseSkillFolder(await write("candidate", input.text));
      return staged.ok ? { ok: true } : { ok: false, message: staged.message };
    }
    const candidate = await loadSkillsFromDir({ dir: await write("candidate", input.text), source: "u7agent" });
    if (candidate.skills.length !== 1 || !candidate.skills[0]) {
      return { ok: false, message: skillScanFailure(candidate) ?? "スキルとして読み込めません" };
    }
    const existing = await loadSkillsFromDir({ dir: await write("baseline", input.baseline.text), source: "u7agent" });
    const known = new Set(existing.diagnostics.map((item) => `${item.type}:${item.message}`));
    const added = candidate.diagnostics.filter((item) => !known.has(`${item.type}:${item.message}`));
    if (added.length > 0) return { ok: false, message: added.map((item) => item.message).join(" / ") };
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 同じディレクトリの一時ファイルから atomic に公開する (途中の内容を読み手に見せない) */
async function writeFileAtomic(target: string, text: string): Promise<void> {
  const temp = `${target}.u7agent-tmp-${randomUUID()}`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** フォルダ全体の走査結果。削除確認と削除直前の照合で同じ計算を使う */
interface SkillFolderScan {
  bytes: number;
  entries: number;
  files: string[];
  digest: string;
}

/**
 * フォルダ全体の決定的なダイジェスト。相対パスをソートし、エントリ種別・通常ファイルの内容ハッシュ・
 * symlink のリンク文字列を含める (隠しファイルも付随ファイルも除外しない)。参照先は辿らない。
 * 上限を超える / 読めないエントリがあるときは、変更前に拒否する。
 */
async function scanSkillFolder(folder: string, limits: ArchiveLimits): Promise<SkillFolderScan> {
  const lines: string[] = [];
  const files: string[] = [];
  let bytes = 0;
  let entries = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${dir}`);
      throw pathError(400, `Cannot read the skill folder: ${messageFor(error)}`);
    });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const name = prefix ? `${prefix}/${child.name}` : child.name;
      entries += 1;
      if (entries > limits.maxEntries) {
        throw pathError(413, `Too many entries in the skill folder (max ${limits.maxEntries})`);
      }
      const absolute = join(dir, child.name);
      if (child.isSymbolicLink()) {
        const link = await readlink(absolute).catch((error: unknown) => {
          throw pathError(400, `Cannot read the symbolic link: ${messageFor(error)}`);
        });
        lines.push(`l:${name}:${link}`);
        files.push(name);
        continue;
      }
      if (child.isDirectory()) {
        lines.push(`d:${name}`);
        files.push(`${name}/`);
        await walk(absolute, name);
        continue;
      }
      if (child.isFile()) {
        const content = await readFile(absolute).catch((error: unknown) => {
          throw pathError(400, `Cannot read the skill file: ${messageFor(error)}`);
        });
        bytes += content.byteLength;
        if (bytes > limits.maxBytes) {
          throw pathError(413, `Too large skill folder (max ${limits.maxBytes} bytes)`);
        }
        lines.push(`f:${name}:${skillFileVersion(content)}`);
        files.push(name);
        continue;
      }
      lines.push(`o:${name}`);
      files.push(name);
    }
  };
  await walk(folder, "");
  return { bytes, entries, files, digest: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

/** 削除する専用フォルダ (実パス) と、発見した名前・root 相対の表示パス */
interface CommonSkillFolder {
  relativePath: string;
  name: string;
  folder: string;
  skillFile: string;
}

/**
 * 削除対象のフォルダを特定する。SKILL.md が symlink の場合は専用フォルダを特定できないため拒否し、
 * フォルダ自身が symlink のときは実体の方を対象にする (要求の lexical パスへ rm してリンクだけ消す事故を防ぐ)。
 */
async function resolveCommonSkillFolder(
  context: SkillCrudContext,
  requested: string,
  signal?: AbortSignal,
): Promise<{ target: CommonSkillTarget; folder: CommonSkillFolder }> {
  const target = await resolveCommonSkillTarget({ rootCwd: context.rootCwd, requested, mustExist: true });
  throwIfAborted(signal);
  const stats = await lstat(target.lexical).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target.lexical}`);
    throw pathError(400, `Cannot resolve the skill file: ${messageFor(error)}`);
  });
  if (stats.isSymbolicLink()) throw pathError(400, "SKILL.md がシンボリックリンクのため削除できません");
  if (!stats.isFile()) throw pathError(400, `Not a regular file: ${target.lexical}`);
  if (target.real === undefined || target.realSkillsDir === undefined) {
    throw pathError(400, `Not a common skill path: ${requested}`);
  }
  const folder = dirname(target.real);
  if (folder === target.realSkillsDir) {
    // 置き場直下の SKILL.md は専用フォルダが置き場自身になるため削除しない
    throw pathError(400, "共通スキル置き場そのものは削除できません");
  }
  const found = await discoverCommonSkill(context, target.real);
  if (!found) throw pathError(404, "そのスキルは現在の一覧に発見できません");
  return {
    target,
    folder: {
      relativePath: relativeToRoot(target.realRoot, target.real),
      name: found.name,
      folder,
      skillFile: target.real,
    },
  };
}

/** 削除確認。取消は副作用なしで、ここでは何も変更しない */
async function previewCommonSkillDelete(
  context: SkillCrudContext,
  requested: string,
  signal?: AbortSignal,
): Promise<SandboxSkillDeletePreview> {
  const { target, folder } = await resolveCommonSkillFolder(context, requested, signal);
  const scan = await scanSkillFolder(folder.folder, context.archiveLimits);
  if (!scan.files.includes("SKILL.md")) throw pathError(400, "SKILL.md を見つけられません");
  return {
    relativePath: folder.relativePath,
    name: folder.name,
    dir: relativeToRoot(target.realRoot, folder.folder),
    treeVersion: scan.digest,
    entries: scan.entries,
    bytes: scan.bytes,
    files: scan.files,
  };
}

/** 公開後の実際の発見一覧で、対象パスと内容が読めることを確認する */
async function verifyPublishedSkill(
  context: SkillCrudContext,
  realFile: string,
  expect: { description: string; name?: string },
): Promise<string | undefined> {
  const found = await discoverCommonSkill(context, realFile);
  if (!found) return "公開したスキルを発見できません";
  if (found.description !== expect.description) return "公開したスキルの説明が一致しません";
  if (expect.name !== undefined && found.name !== expect.name) return "公開したスキルの名前が一致しません";
  return undefined;
}

/**
 * 共通スキルの新規作成。排他内で同名の確認・公開前の SDK 検証・atomic な公開を行い、公開後にも
 * 実際の発見一覧で確認する。組み込みとの同名は既存の優先順位に委ねる (ここでは共通内だけを見る)。
 */
async function createCommonSkill(
  context: SkillCrudContext,
  body: SandboxSkillCreateBody,
  signal?: AbortSignal,
): Promise<SandboxSkillCreateResult> {
  if (!isValidEntryName(body.name) || body.name.startsWith(".")) {
    throw pathError(400, `Invalid skill name: ${body.name}`);
  }
  if (body.description.trim() === "") throw pathError(400, "説明を入力してください");
  if (body.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    throw pathError(400, `説明は ${SKILL_DESCRIPTION_MAX_LENGTH} 文字以内にしてください`);
  }
  const text = createSkillText({ name: body.name, description: body.description, body: body.body });
  return context.gate(async () => {
    throwIfAborted(signal);
    const relativePath = [...COMMON_SKILLS_SEGMENTS, body.name, "SKILL.md"].join("/");
    const target = await resolveCommonSkillTarget({
      rootCwd: context.rootCwd,
      requested: relativePath,
      mustExist: false,
    });
    // 既存のディレクトリ (SKILL.md が無くても) も同名の共通スキルも上書きしない
    const existing = await lstat(dirname(target.lexical)).catch(() => undefined);
    if (existing) throw pathError(409, `既に存在します: ${relativePath}`);
    if (target.realSkillsDir !== undefined) {
      const discovery = await listWorkspaceSkills(context.rootCwd, COMMON_SKILLS_DIR, context.scanTimeoutMs);
      if (discovery.skills.some((skill) => skill.name === body.name)) {
        throw pathError(409, `同名の共通スキルが既にあります: ${body.name}`);
      }
    }
    const staged = await diagnoseSkillCandidate({ text });
    if (!staged.ok) throw pathError(400, `新しいスキルを作成できません: ${staged.message}`);
    const folder = dirname(target.lexical);
    const createdFolder = !(await lstat(folder).catch(() => undefined));
    try {
      await mkdir(folder, { recursive: true });
      await writeFileAtomic(target.lexical, text);
    } catch (error) {
      if (createdFolder) await rm(folder, { recursive: true, force: true }).catch(() => {});
      throw pathError(400, `新しいスキルを作成できません: ${messageFor(error)}`);
    }
    const realFile = await realpathNative(target.lexical).catch(() => undefined);
    if (realFile === undefined || !isInsideRoot(target.realRoot, realFile)) {
      throw pathError(400, "新しいスキルの実体を確認できません");
    }
    const nextVersion = skillFileVersion(Buffer.from(text, "utf8"));
    const failure = await verifyPublishedSkill(context, realFile, { description: body.description, name: body.name });
    if (failure) {
      // 自分が作った内容のままのときだけ畳む (確認の間に他者が変更していれば触らない)
      const current = await readFile(realFile).catch(() => undefined);
      if (current && skillFileVersion(current) === nextVersion) {
        await rm(dirname(realFile), { recursive: true, force: true }).catch(() => {});
      }
      throw pathError(500, `${failure}。現在の一覧を確認してください`);
    }
    return { relativePath: relativeToRoot(target.realRoot, realFile), fileVersion: nextVersion };
  });
}

/**
 * 共通スキルの保存。版照合 → 決定的な差し替え → 公開前の SDK 検証 → SDK のファイル隊列を使った
 * atomic な公開 → 公開後の確認の順に、すべて共通 gate の中で行う。変更なしなら書き込まない。
 */
async function saveCommonSkill(
  context: SkillCrudContext,
  body: SandboxSkillSaveBody,
  signal?: AbortSignal,
): Promise<SandboxSkillSaveResult> {
  return context.gate(async () => {
    throwIfAborted(signal);
    const target = await resolveCommonSkillTarget({
      rootCwd: context.rootCwd,
      requested: body.relativePath,
      mustExist: true,
    });
    const content = await readCommonSkillContent(target, signal);
    if (content.version !== body.fileVersion) {
      throw pathError(409, "スキルが他の変更と競合しました。再読み込みしてから保存してください");
    }
    const realFile = target.real ?? target.lexical;
    // 現行の一覧に発見できない内容は保存しない (公開後の確認まで進めても戻せない)
    if (target.real === undefined || !(await discoverCommonSkill(context, target.real))) {
      throw pathError(400, "現在の内容をスキルとして読み込めないため保存できません");
    }
    const edited = editSkillText({ original: content.text, description: body.description, body: body.body });
    if (!edited.ok) throw pathError(400, edited.reason);
    const relativePath = target.real ? relativeToRoot(target.realRoot, target.real) : target.relativePath;
    if (!edited.changed) return { relativePath, fileVersion: content.version };
    const staged = await diagnoseSkillCandidate({ text: edited.text, baseline: { text: content.text } });
    if (!staged.ok) throw pathError(400, `保存できません: ${staged.message}`);
    const expectedName = inspectSkillText(edited.text).name ?? basename(dirname(target.lexical));
    const nextVersion = skillFileVersion(Buffer.from(edited.text, "utf8"));
    await withFileMutationQueue(realFile, async () => {
      // 直前の再確認。ここで観測した変更は拒否する (外部プロセスとの完全な CAS は保証しない)
      const current = await readCommonSkillContent(target, signal).catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode === 404) {
          throw pathError(409, "スキルが削除されました。再読み込みしてください");
        }
        throw error;
      });
      if (current.version !== body.fileVersion) {
        throw pathError(409, "スキルが他の変更と競合しました。再読み込みしてから保存してください");
      }
      await writeFileAtomic(target.lexical, edited.text).catch((error: unknown) => {
        throw pathError(400, `保存できません: ${messageFor(error)}`);
      });
    });
    const failure = await verifyPublishedSkill(context, realFile, {
      description: body.description,
      name: expectedName,
    });
    if (failure) {
      // 自分が書いた版のままのときだけ、元の内容へ戻す (他の更新は巻き戻さない)
      const current = await readFile(realFile).catch(() => undefined);
      if (current && skillFileVersion(current) === nextVersion) {
        await writeFileAtomic(realFile, content.text).catch(() => {});
      }
      throw pathError(500, `${failure}。現在の一覧を確認してください`);
    }
    return { relativePath, fileVersion: nextVersion };
  });
}

/**
 * 共通スキルの専用フォルダ削除。treeVersion の照合を取ってから、配下ごと削除する。
 * symlink の参照先は辿らず、対象フォルダ内のエントリだけを扱う。
 */
async function deleteCommonSkill(
  context: SkillCrudContext,
  requested: string,
  treeVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  return context.gate(async () => {
    throwIfAborted(signal);
    const { folder } = await resolveCommonSkillFolder(context, requested, signal);
    const scan = await scanSkillFolder(folder.folder, context.archiveLimits);
    if (scan.digest !== treeVersion) {
      throw pathError(409, "フォルダの内容が変わりました。削除の確認を取り直してください");
    }
    await withFileMutationQueue(folder.skillFile, async () => {
      // 取得待ちの間の変更を確かめ直す (この 2 回目の scan 中に別の変更が入った場合は rm 後に気付く)
      const again = await scanSkillFolder(folder.folder, context.archiveLimits);
      if (again.digest !== treeVersion) {
        throw pathError(409, "フォルダの内容が変わりました。削除の確認を取り直してください");
      }
      await rm(folder.folder, { recursive: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw pathError(400, `Cannot delete the skill folder: ${messageFor(error)}`);
      });
    });
  });
}

/** 共通スキル置き場の親 (`.agents`)。取り込みの一時データを同じファイルシステムに置く */
const SKILLS_PARENT_DIR = dirname(COMMON_SKILLS_DIR);
/** 取り込みの一時ディレクトリ。受信 ZIP・staging・退避をここに閉じ、成功・失敗・中断のいずれでも消す */
const IMPORT_TEMP_PREFIX = ".import-";

/** staging へ展開したスキル 1 件。files はスキル名からの相対パス → SHA-256 */
interface StagedSkill {
  name: string;
  folder: string;
  files: Map<string, string>;
  skillFileVersion: string;
}

/** ZIP の直下フォルダ 1 つ分 (スキル 1 件) */
interface SkillImportGroup {
  name: string;
  entries: ZipReadEntry[];
  hasSkillFile: boolean;
}

/** 取り込みの計画 1 件。`reason` は invalid のとき、`protectReason` は置換できないときだけ入る */
interface SkillImportPlan {
  name: string;
  status: SandboxSkillImportStatus;
  reason?: string;
  staged: StagedSkill;
  /** 実在した置換対象の実フォルダ (置換できるときだけ) */
  replaceTarget?: string;
  protectReason?: string;
}

/**
 * 取り込みの `replace` query。保存名と同じ規則で検証し、重複は先勝ちで畳む。
 * 空値と不正な名前は 400 にする (黙って無視すると「置き換えたつもり」の食い違いを作る)。
 */
function parseReplaceQuery(
  values: string[] | undefined,
): { ok: true; names: string[] } | { ok: false; message: string } {
  const names = [...new Set(values ?? [])];
  const invalid = names.find((name) => !isValidEntryName(name));
  if (invalid !== undefined) return { ok: false, message: `Invalid replace name: ${invalid}` };
  return { ok: true, names };
}

/** `.agents` 配下に取り込みの一時ディレクトリを作る。既存の `.agents` が root 外へ解決する場合は 400 */
async function createImportTempDir(rootCwd: string): Promise<string> {
  const parentRel = await createWorkspaceDirectory(rootCwd, SKILLS_PARENT_DIR);
  const root = await realpathNative(rootCwd);
  const parent = parentRel === "." ? root : join(root, parentRel);
  const temp = join(parent, `${IMPORT_TEMP_PREFIX}${randomUUID()}`);
  await mkdir(temp).catch((error: unknown) => {
    throw pathError(400, `Cannot create the import workspace: ${messageFor(error)}`);
  });
  return temp;
}

/** 受信した ZIP を一時ファイルへ書く。上限はアップロードと同じ値で、超過は 413 */
async function receiveImportArchive(input: {
  dir: string;
  body: ReadableStream<Uint8Array> | null;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<string> {
  const path = join(input.dir, "archive.zip");
  const handle = await open(path, "wx", 0o600);
  let size = 0;
  try {
    if (input.body) {
      const reader = input.body.getReader();
      try {
        for (;;) {
          throwIfAborted(input.signal);
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > input.maxBytes) {
            await reader.cancel().catch(() => {});
            throw pathError(413, `Import archive is too large (max ${input.maxBytes} bytes)`);
          }
          await handle.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return path;
}

/**
 * 1 エントリのパスを検証し、セグメントに分ける。zip slip (絶対パス・`..`・`\`・制御文字) と、
 * `.git` の全階層除外、hidden の直下フォルダ、symlink / 特殊ファイルのエントリをここで断る。
 */
function importEntrySegments(entry: ZipReadEntry): string[] {
  if (entry.name.startsWith("/") || entry.name.startsWith("\\")) {
    throw pathError(400, `Invalid ZIP entry name: ${entry.name}`);
  }
  if (entry.unixMode !== undefined) {
    const fileType = entry.unixMode & 0o170000;
    if (fileType === 0o120000) throw pathError(400, `Symbolic link entries are not allowed: ${entry.name}`);
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      throw pathError(400, `Not a regular file or directory: ${entry.name}`);
    }
  }
  // 末尾の `/` はディレクトリの印。2 つ以上や、区切りの連続・空セグメントは名前として扱わない
  const trimmed = entry.isDirectory && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
  const segments = trimmed.split("/");
  if (trimmed === "" || segments.some((segment) => segment === "")) {
    throw pathError(400, `Invalid ZIP entry name: ${entry.name}`);
  }
  for (const segment of segments) {
    if (!isValidEntryName(segment)) throw pathError(400, `Invalid ZIP entry name: ${entry.name}`);
    // export の固定除外と对称 (全階層・ベース名の完全一致)
    if (segment === ".git") throw pathError(400, `Excluded from skill archives: ${entry.name}`);
  }
  if (segments[0]!.startsWith(".")) {
    throw pathError(400, `Hidden directories are not skill folders: ${entry.name}`);
  }
  return segments;
}

/** 直下がスキルフォルダだけであることと、各フォルダが `SKILL.md` を直接持つことを検証してグループへ分ける */
function groupImportEntries(entries: readonly ZipReadEntry[]): SkillImportGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, SkillImportGroup>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw pathError(400, `Duplicate ZIP entry: ${entry.name}`);
    seen.add(entry.name);
    const segments = importEntrySegments(entry);
    const name = segments[0]!;
    let group = groups.get(name);
    if (!group) {
      group = { name, entries: [], hasSkillFile: false };
      groups.set(name, group);
    }
    // 直下の項目はスキルフォルダ (ディレクトリ) だけ。ファイルはどのスキルにも属さない
    if (segments.length === 1 && !entry.isDirectory) {
      throw pathError(400, `SKILL.md を持たない直下項目です: ${entry.name}`);
    }
    if (segments.length === 2 && segments[1] === "SKILL.md" && !entry.isDirectory) group.hasSkillFile = true;
    group.entries.push(entry);
  }
  for (const group of groups.values()) {
    if (!group.hasSkillFile) throw pathError(400, `SKILL.md を持たないスキルフォルダです: ${group.name}`);
  }
  return [...groups.values()];
}

/** 検証済みの ZIP を staging へ展開し、同一判定に使うスキルごとのバイトハッシュを集める */
async function extractImportGroups(input: {
  archivePath: string;
  archive: ZipReadArchive;
  groups: readonly SkillImportGroup[];
  staging: string;
}): Promise<StagedSkill[]> {
  const staged: StagedSkill[] = [];
  for (const group of input.groups) {
    const folder = join(input.staging, group.name);
    await mkdir(folder, { recursive: true }).catch(() => {
      throw pathError(400, `Invalid ZIP archive: cannot extract ${group.name}`);
    });
    const files = new Map<string, string>();
    let skillFileVersion: string | undefined;
    for (const entry of group.entries) {
      const extracted = await extractZipEntry({
        archive: input.archivePath,
        entry,
        target: join(input.staging, entry.name),
        dataLimit: input.archive.dataLimit,
      });
      if (entry.isDirectory) continue;
      const relativePath = entry.name.slice(group.name.length + 1);
      files.set(relativePath, extracted.digest);
      if (relativePath === "SKILL.md") skillFileVersion = extracted.digest;
    }
    if (skillFileVersion === undefined) throw pathError(400, `SKILL.md を持たないスキルフォルダです: ${group.name}`);
    staged.push({ name: group.name, folder, files, skillFileVersion });
  }
  return staged;
}

/**
 * フォルダ下の通常ファイルの相対パス → SHA-256。symlink / 特殊ファイルがあるときと、
 * エントリ数 / 合計サイズが既存の上限 (export の walk と同じ値) を超えるときは undefined を返す
 * (同一とは言えない。上限付きで読むのは、共通スキル gate を握ったまま巨大なフォルダを読まないため)。
 */
async function folderFileDigests(folder: string, limits: ArchiveLimits): Promise<Map<string, string> | undefined> {
  const digests = new Map<string, string>();
  let entries = 0;
  let bytes = 0;
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    const children = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (!children) return false;
    for (const child of children) {
      entries += 1;
      if (entries > limits.maxEntries) return false;
      const name = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isSymbolicLink()) return false;
      if (child.isDirectory()) {
        if (!(await walk(join(dir, child.name), name))) return false;
        continue;
      }
      if (!child.isFile()) return false;
      const stats = await lstat(join(dir, child.name)).catch(() => undefined);
      if (!stats) return false;
      bytes += stats.size;
      if (bytes > limits.maxBytes) return false;
      const hash = createHash("sha256");
      try {
        await pipeline(createReadStream(join(dir, child.name)), hash);
      } catch {
        return false;
      }
      digests.set(name, hash.digest("hex"));
    }
    return true;
  };
  return (await walk(folder, "")) ? digests : undefined;
}

/** 2 つのファイル集合 (相対パス → SHA-256) が完全に一致するか */
function sameFileDigests(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, digest] of a) if (b.get(name) !== digest) return false;
  return true;
}

/** フォルダ自身が `<skills>` の内側へ解決するか (しないときは置換しない)。symlink の判定に使う */
async function resolvesInsideSkills(input: { rootCwd: string; target: string }): Promise<boolean> {
  const realRoot = await realpathNative(input.rootCwd).catch(() => undefined);
  if (!realRoot) return false;
  const realSkillsDir = await realpathNative(join(realRoot, COMMON_SKILLS_DIR)).catch(() => undefined);
  const real = await realpathNative(input.target).catch(() => undefined);
  if (!realSkillsDir || !real) return false;
  return isInsideRoot(realSkillsDir, real);
}

/**
 * bundle のスキル名に対する既存の置換対象を、共通スキルの CRUD と同じ規則で解決する
 * (realpath で置き場の内側、`SKILL.md` が symlink のスキルは置換しない)。
 * 既存の同名が置き場の外へ解決する symlink でも、そのスキルを置換対象にしないだけで、
 * bundle の他のスキル (new を含む) の取り込みは止めない。
 */
async function resolveImportTarget(input: {
  rootCwd: string;
  name: string;
}): Promise<{ state: "missing" } | { state: "protected"; reason: string } | { state: "existing"; folder: string }> {
  const requested = [...COMMON_SKILLS_SEGMENTS, input.name, "SKILL.md"].join("/");
  const lexical = join(resolve(input.rootCwd), ...COMMON_SKILLS_SEGMENTS, input.name, "SKILL.md");
  // 置換可否は lexical な形で先に見る (参照先が置き場の外でも resolveCommonSkillTarget の 400 にしない)
  const stats = await lstat(lexical).catch(() => undefined);
  if (stats?.isSymbolicLink()) {
    return { state: "protected", reason: "SKILL.md がシンボリックリンクのため置換できません" };
  }
  if (stats !== undefined && !stats.isFile()) {
    return { state: "protected", reason: "SKILL.md が通常ファイルではないため置換できません" };
  }
  const folderStats = await lstat(dirname(lexical)).catch(() => undefined);
  if (
    folderStats?.isSymbolicLink() &&
    !(await resolvesInsideSkills({ rootCwd: input.rootCwd, target: dirname(lexical) }))
  ) {
    return { state: "protected", reason: "スキルフォルダが置き場の外へ解決するため置換できません" };
  }

  const target = await resolveCommonSkillTarget({ rootCwd: input.rootCwd, requested, mustExist: false });
  const skillsDir = target.realSkillsDir;
  if (skillsDir === undefined) return { state: "missing" };
  if (target.real !== undefined) {
    const folder = dirname(target.real);
    if (!isInsideRoot(skillsDir, folder)) {
      return { state: "protected", reason: "スキルフォルダが置き場の外へ解決するため置換できません" };
    }
    return { state: "existing", folder };
  }
  const folder = dirname(target.lexical);
  if (folderStats === undefined) return { state: "missing" };
  // SKILL.md は無いがフォルダはある (非スキル項目)。中身を同一と判定できないため置換対象にする
  const real = await realpathNative(folder).catch(() => undefined);
  if (!real || !isInsideRoot(skillsDir, real)) {
    return { state: "protected", reason: "スキルフォルダが置き場の外へ解決するため置換できません" };
  }
  return { state: "existing", folder: real };
}

/** 展開済みの bundle を SDK で検証し、既存と突き合わせて new / identical / conflict / invalid に分ける */
async function planSkillsImport(input: {
  rootCwd: string;
  staged: readonly StagedSkill[];
  limits: ArchiveLimits;
}): Promise<SkillImportPlan[]> {
  const plans: SkillImportPlan[] = [];
  for (const staged of input.staged) {
    const diagnosed = await diagnoseSkillFolder(staged.folder);
    if (!diagnosed.ok) {
      plans.push({ name: staged.name, status: "invalid", reason: diagnosed.message, staged });
      continue;
    }
    if (diagnosed.name !== staged.name) {
      plans.push({
        name: staged.name,
        status: "invalid",
        reason: `スキル名 (name) がフォルダ名と一致しません: ${diagnosed.name}`,
        staged,
      });
      continue;
    }
    const existing = await resolveImportTarget({ rootCwd: input.rootCwd, name: staged.name });
    if (existing.state === "missing") {
      plans.push({ name: staged.name, status: "new", staged });
      continue;
    }
    if (existing.state === "protected") {
      plans.push({ name: staged.name, status: "conflict", protectReason: existing.reason, staged });
      continue;
    }
    const digests = await folderFileDigests(existing.folder, input.limits);
    const identical = digests !== undefined && sameFileDigests(digests, staged.files);
    plans.push({
      name: staged.name,
      status: identical ? "identical" : "conflict",
      replaceTarget: existing.folder,
      staged,
    });
  }
  return plans;
}

/**
 * 適用の失敗を、内部パスを含まない固定文言に写す。診断に要る OS メッセージ (絶対パスを含む) は
 * 応答本文には載せず、プロセスのログにだけ残す。ステータスは変更前の分類を保ち、OS の失敗は 500 にする。
 */
function importApplyFailure(error: unknown): Error & { statusCode: number } {
  console.warn(`[u7agent-sandbox] スキルの取り込みに失敗しました: ${messageFor(error)}`);
  const statusCode = (error as { statusCode?: number }).statusCode;
  const status = statusCode !== undefined && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  return pathError(status, "スキルを取り込めませんでした");
}

/**
 * 計画を適用する。置換対象を退避へ rename → 新フォルダを rename の順に行い、
 * 全件成功後に退避を消す。途中で失敗したら、適用済みの分を逆順に戻す。
 */
async function applySkillsImport(input: {
  rootCwd: string;
  tempDir: string;
  plans: readonly SkillImportPlan[];
  replace: ReadonlySet<string>;
  entries: number;
  bytes: number;
  signal?: AbortSignal;
}): Promise<SandboxSkillsImportApply> {
  const backupDir = join(input.tempDir, "backup");
  // 準備段階の失敗も OS メッセージ (絶対パス) を応答に載せない
  const root = await realpathNative(input.rootCwd).catch((error: unknown) => {
    throw importApplyFailure(error);
  });
  await mkdir(backupDir, { recursive: true }).catch((error: unknown) => {
    throw importApplyFailure(error);
  });
  const applied: SandboxSkillImportApplied[] = [];
  const skipped: SandboxSkillImportSkipped[] = [];
  const rollback: { destination: string; folder?: string; backup?: string }[] = [];
  /** スキルを 1 件でも作るときだけ `.agents/skills` を作る (全件 skip の要求では何も作らない) */
  let destinationRoot: string | undefined;
  const destinationRootOf = async (): Promise<string> => {
    if (destinationRoot !== undefined) return destinationRoot;
    const rel = await createWorkspaceDirectory(input.rootCwd, COMMON_SKILLS_DIR).catch((error: unknown) => {
      throw importApplyFailure(error);
    });
    destinationRoot = rel === "." ? root : join(root, rel);
    return destinationRoot;
  };
  try {
    for (const plan of input.plans) {
      throwIfAborted(input.signal);
      if (plan.status === "invalid") {
        skipped.push({ name: plan.name, reason: plan.reason ?? "スキルとして読み込めません" });
        continue;
      }
      if (plan.status === "identical") {
        skipped.push({ name: plan.name, reason: "内容が同一" });
        continue;
      }
      if (plan.protectReason !== undefined) {
        skipped.push({ name: plan.name, reason: plan.protectReason });
        continue;
      }
      if (plan.status === "conflict" && !input.replace.has(plan.name)) {
        skipped.push({ name: plan.name, reason: "同名のため取り込まない" });
        continue;
      }
      const destination = join(await destinationRootOf(), plan.name);
      let backup: string | undefined;
      if (plan.replaceTarget !== undefined) {
        backup = join(backupDir, plan.name);
        await rename(plan.replaceTarget, backup).catch((error: unknown) => {
          throw importApplyFailure(error);
        });
      }
      try {
        await rename(plan.staged.folder, destination).catch((error: unknown) => {
          throw importApplyFailure(error);
        });
      } catch (error) {
        if (backup !== undefined && plan.replaceTarget !== undefined) {
          await rename(backup, plan.replaceTarget).catch(() => {});
        }
        throw error;
      }
      rollback.push({ destination, folder: plan.replaceTarget, backup });
      applied.push({
        name: plan.name,
        relativePath: `${COMMON_SKILLS_DIR}/${plan.name}/SKILL.md`,
        fileVersion: plan.staged.skillFileVersion,
        replaced: plan.replaceTarget !== undefined,
      });
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    return { applied, skipped, entries: input.entries, bytes: input.bytes };
  } catch (error) {
    for (const item of rollback.reverse()) {
      await rm(item.destination, { recursive: true, force: true }).catch(() => {});
      if (item.backup !== undefined && item.folder !== undefined) {
        await rename(item.backup, item.folder).catch(() => {});
      }
    }
    throw error;
  }
}

/**
 * `.agents/skills` の取り込み。構造の検証と staging への展開を済ませてから、共通スキル置き場の gate の内側で
 * 全件を検証 (plan) し、apply のときだけ書き込む。一時データは成功・失敗・中断のいずれでも消す。
 */
async function importSkills(
  context: SkillCrudContext,
  input: {
    body: ReadableStream<Uint8Array> | null;
    replace: readonly string[];
    dryRun: boolean;
    signal?: AbortSignal;
  },
): Promise<SandboxSkillsImportResult> {
  const tempDir = await createImportTempDir(context.rootCwd);
  try {
    const archivePath = await receiveImportArchive({
      dir: tempDir,
      body: input.body,
      maxBytes: context.maxUploadBytes,
      signal: input.signal,
    });
    const archive = await readZipArchive(archivePath, context.archiveLimits);
    const groups = groupImportEntries(archive.entries);
    const staging = join(tempDir, "staging");
    await mkdir(staging, { recursive: true });
    const staged = await extractImportGroups({ archivePath, archive, groups, staging });
    return await context.gate(async () => {
      throwIfAborted(input.signal);
      const plans = await planSkillsImport({ rootCwd: context.rootCwd, staged, limits: context.archiveLimits });
      if (input.dryRun) {
        const skills = plans.map((plan): SandboxSkillImportPlanEntry => ({
          name: plan.name,
          status: plan.status,
          ...(plan.reason === undefined ? {} : { reason: plan.reason }),
        }));
        return { skills, entries: archive.entryCount, bytes: archive.bytes } satisfies SandboxSkillsImportPlan;
      }
      return await applySkillsImport({
        rootCwd: context.rootCwd,
        tempDir,
        plans,
        replace: new Set(input.replace),
        entries: archive.entryCount,
        bytes: archive.bytes,
        signal: input.signal,
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `env` の検証。BFF が登録時に名前を検証しているが、実行 API の入口としてサンドボックスでも同じ規則を見る
 * (予約名 / 起動制御名を子プロセスへ入れない)。空オブジェクトは「注入なし」と同じ扱いにする。
 */
export function parseInjectedEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("env must be an object");
  }
  const env: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "string") throw new Error(`env values must be strings: ${name}`);
    if (!isInjectableEnvName(name)) throw new Error(`env name is not allowed: ${name}`);
    if (raw.includes("\0")) throw new Error(`env value must not contain NUL: ${name}`);
    env[name] = raw;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * `writeScope` の検証。root 相対のディレクトリと、無ければ作ってよいかの宣言だけを受け付ける。
 * BFF 内部実行 (serve) 専用で、モデルはツール引数から指定できない。
 */
export function parseWriteScope(value: unknown): SandboxWriteScopeEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("writeScope must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("writeScope entries must be objects");
    }
    const { path, create } = entry as { path?: unknown; create?: unknown };
    if (typeof path !== "string") throw new Error("writeScope entries need a string path");
    if (create !== undefined && typeof create !== "boolean") {
      throw new Error("writeScope create must be a boolean");
    }
    return create === true ? { path, create: true } : { path };
  });
}

/**
 * `Range` ヘッダの解釈結果。`none` はレンジ指定なしとして扱う (応答は 200)。構文的に不正な値と
 * `bytes` 以外の単位、複数レンジは解釈しない (RFC 9110 はレンジを無視した 200 を許す)。
 */
type ByteRange = { kind: "none" } | { kind: "unsatisfiable" } | { kind: "satisfiable"; start: number; end: number };

/** 先頭の 0 を落とした桁だけの数字。10 進の大小は桁数 → 辞書順で size に依らず比較できる。 */
function normalizeDigits(text: string): string {
  return text.replace(/^0+/, "");
}

/** 正規化した数字の 10 進の大小。桁数が違えば長い方が大きく、同じ桁数なら辞書順で決まる。 */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 正規化した数字を size (100 MiB 以下) と比較できる整数へ読む。16 桁以上は size より必ず大きいので
 * 飽和させてよい (大小の比較は compareDigits で先に行う)。
 */
function byteIndex(digits: string): number {
  return digits.length > 15 ? Number.MAX_SAFE_INTEGER : Number(digits);
}

/**
 * 単一の `bytes=` レンジだけを解釈する (マルチパート / 複数レンジは対象外)。416 は「範囲として
 * 解釈できて満たせない」ときだけ返すため、先頭 > 末尾などの構文不正は none に倒す。end は inclusive。
 */
function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "none" };
  const [, firstText, lastText] = match;
  if (firstText === "" && lastText === "") return { kind: "none" };
  if (firstText === "") {
    // `bytes=-N` は末尾 N バイト。表現より長い要求は全体を使い、空の範囲 (N = 0) と 0 バイトは満たせない
    const suffix = byteIndex(normalizeDigits(lastText));
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "satisfiable", start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = byteIndex(normalizeDigits(firstText));
  if (lastText === "") {
    if (start >= size) return { kind: "unsatisfiable" };
    return { kind: "satisfiable", start, end: size - 1 };
  }
  // 先頭 > 末尾の byte-range-spec は不正なので Range ごと無視する。桁を丸める前に 10 進で比べる
  // (丸めると大小が潰れ、不正な範囲が 416 になってしまう)
  if (compareDigits(normalizeDigits(firstText), normalizeDigits(lastText)) > 0) return { kind: "none" };
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "satisfiable", start, end: Math.min(byteIndex(normalizeDigits(lastText)), size - 1) };
}

/**
 * クエリのポート番号。1..65535 の 10 進整数だけを受け付け、欠落・他の表記・範囲外は null。
 * `port` / `from` / `to` で同じ判定を使う (片方だけ緩いと排他の検証が崩れる)。
 */
function parsePortQuery(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** listen は呼び出し側 (@hono/node-server) が行い、テストは app.request() で検証する。 */
export function createSandboxService(options: SandboxServiceOptions): SandboxService {
  const token = options.token;
  if (!token || token.trim().length < 16) {
    throw new Error("PI_SANDBOX_TOKEN must be set to a non-trivial value (16+ chars)");
  }
  const rootCwd = options.rootCwd || "/workspace";
  const maxUploadBytes = options.maxUploadBytes ?? SANDBOX_MAX_UPLOAD_BYTES;
  const skillsScanTimeoutMs = options.skillsScanTimeoutMs ?? SKILLS_SCAN_TIMEOUT_MS;
  const gitInfoTimeoutMs = options.gitInfoTimeoutMs ?? GIT_INFO_TIMEOUT_MS;
  const gitPath = options.gitPath;
  const archiveLimits: ArchiveLimits = {
    maxBytes: options.maxArchiveBytes ?? DEFAULT_ARCHIVE_LIMITS.maxBytes,
    maxEntries: options.maxArchiveEntries ?? DEFAULT_ARCHIVE_LIMITS.maxEntries,
  };
  const probeRuntimeInfo = options.probeRuntimeInfo ?? ((workspaceRoot: string) => probeSandboxRuntime(workspaceRoot));
  // ラッパーは PATH からではなく固定パスから解決する (解決できなければ bash を実行しない)
  const landlockExec = options.resolveLandlockExec ? options.resolveLandlockExec() : resolveLandlockWrapper();
  /** ラッパーが exec する本物の shell。SDK の既定の解決結果をそのまま使う (PATH の二重管理をしない) */
  const targetShell = (() => {
    try {
      return getShellConfig(undefined).shell;
    } catch {
      return undefined;
    }
  })();
  const fixedLandlockRoots = fixedLandlockWriteRoots();
  const probeLandlock = options.probeLandlock ?? (() => probeLandlockStatus(landlockExec));
  let landlockProbe: Promise<SandboxLandlockStatus> | undefined;
  /** 診断と bash の入口が同じ結果を使う (ラッパーが使えない環境ではコマンドを実行しない) */
  const landlockStatus = (): Promise<SandboxLandlockStatus> => (landlockProbe ??= probeLandlock());

  /** bash を実行できない理由。実行できるときだけ undefined を返す (fail-closed の入口) */
  const bashUnavailableReason = async (): Promise<string | undefined> => {
    if (!landlockExec) {
      return landlockUnavailableMessage({
        state: "unavailable",
        abi: null,
        minAbi: LANDLOCK_MIN_ABI,
        reason: "wrapper_missing",
      });
    }
    if (!targetShell) return "bash を実行する shell が見つかりません";
    const status = await landlockStatus();
    return status.state === "enabled" ? undefined : landlockUnavailableMessage(status);
  };

  // bash にはセッションメタ変数 (PI_SESSION_ID 等) を注入せず (サンドボックスにセッションは無い)、
  // SDK の bash が process.env を継承しても、このプロセスの秘密値 (共有トークン / master key) だけは剥がす。
  // 作業フォルダの変数は spawnHook の後段で足す (名前の検証は上の parseInjectedEnv で済んでいる)。
  const spawnHookWithEnv =
    (injected: Record<string, string> | undefined, landlock: Record<string, string>) =>
    (context: BashSpawnContext): BashSpawnContext => {
      // ラッパーの制御変数は injected より後に置き、子から再注入させない
      const env: NodeJS.ProcessEnv = { ...context.env, ...injected, ...landlock };
      delete env.PI_SANDBOX_TOKEN;
      delete env[SECRET_MASTER_KEY_ENV];
      delete env[SECRET_MASTER_KEY_FILE_ENV];
      return { ...context, env };
    };

  /** bash の定義。注入する env と許可 root はリクエストごとに違うため、差があるときはキャッシュしない */
  const bashFor = (
    cwd: string,
    roots: readonly LandlockWriteRoot[],
    injected?: Record<string, string>,
  ): AnyToolDefinition =>
    createBashToolDefinition(cwd, {
      exposeSessionEnvironment: false,
      // 未解決でも SDK の既定 shell へは落とさず、実行の入口 (bashUnavailableReason) で断る
      shellPath: landlockExec,
      spawnHook: spawnHookWithEnv(injected, landlockRulesEnv({ shell: targetShell ?? "", roots })),
    });

  const lexicalRoot = resolve(rootCwd);

  /** 要求 cwd から write / edit の許可 root を組む。skillsDir は共通スキル (`<root>/.agents/skills`) で、未作成でも通す。 */
  const writeScopeFor = (requestedCwd: string, executionCwd: string): WriteScope => ({
    cwd: executionCwd,
    lexicalCwd: resolve(lexicalRoot, requestedCwd || "."),
    skillsDir: join(lexicalRoot, COMMON_SKILLS_DIR),
  });

  /** エージェントの bash の許可 root。要求 cwd から導出する (BFF 内部実行は要求 scope だけを使う) */
  const agentBashRoots = (executionCwd: string, scope: WriteScope): LandlockWriteRoot[] => [
    { path: executionCwd },
    { path: scope.skillsDir, create: true },
    ...fixedLandlockRoots,
  ];

  /**
   * BFF 内部実行の writeScope (root 相対) を実パスへ。要求由来の値を root 外へ出さず、作成は呼び出し側の
   * 宣言 (create) だけを尊重する (既存の作業ディレクトリは作らない)。
   */
  const requestBashRoots = (entries: readonly SandboxWriteScopeEntry[]): LandlockWriteRoot[] =>
    entries.map((entry) => {
      const target = resolve(lexicalRoot, entry.path || ".");
      if (!isInsideRoot(lexicalRoot, target)) {
        throw pathError(400, `writeScope is outside the workspace: ${entry.path}`);
      }
      return { path: target, create: entry.create === true };
    });

  /**
   * cwd ごとのツール定義。パス解決の起点が定義に焼き込まれるため、実行 cwd ごとに生成して再利用する。
   * key は realpath 解決済みの絶対パス (symlink 経由の別名で重複生成しない) と要求 cwd の lexical 形の組。
   * lexical 形は同じ実行 cwd へ解決する別名でも許可 root が変わるため、key から落とせない。
   */
  const registries = new Map<string, Map<string, AnyToolDefinition>>();
  const registryFor = (cwd: string, scope: WriteScope): Map<string, AnyToolDefinition> => {
    // 区切り文字の衝突で別の許可 root を使わないよう、JSON で組にする (パスに改行は入り得る)
    const key = JSON.stringify([cwd, scope.lexicalCwd]);
    const cached = registries.get(key);
    if (cached) return cached;
    const assertWritable = async (candidate: string): Promise<void> => {
      if (await isWritablePath(candidate, scope)) return;
      throw writeScopeError(candidate, scope.cwd, scope.skillsDir);
    };
    const definitions: AnyToolDefinition[] = [
      bashFor(cwd, agentBashRoots(cwd, scope)),
      createReadToolDefinition(cwd),
      createEditToolDefinition(cwd, {
        operations: {
          access: async (target) => {
            // 判定を実際の access より先に行う (実在しないパスでも SDK に ENOENT を先に出させない)
            await assertWritable(target);
            await access(target, constants.R_OK | constants.W_OK);
          },
          readFile: async (target) => {
            await assertWritable(target);
            return readFile(target);
          },
          writeFile: async (target, content) => {
            await assertWritable(target);
            await writeFile(target, content, "utf-8");
          },
        },
      }),
      createWriteToolDefinition(cwd, {
        operations: {
          // mkdir も判定する (先に許すと拒否パスでも workdir 外に親ディレクトリができる)
          mkdir: async (dir) => {
            await assertWritable(dir);
            await mkdir(dir, { recursive: true });
          },
          writeFile: async (target, content) => {
            await assertWritable(target);
            await writeFile(target, content, "utf-8");
          },
        },
      }),
      createGrepToolDefinition(cwd),
      createFindToolDefinition(cwd),
      createLsToolDefinition(cwd),
    ];
    const registry = new Map<string, AnyToolDefinition>(definitions.map((def) => [def.name, def]));
    registries.set(key, registry);
    return registry;
  };

  const executions = new Map<string, AbortController>();
  // 引き継ぎメモの書込みを実パス単位で直列化する (作業フォルダを共有する別の会話の同時追記を重ねる)
  const handoffWrites = new Map<string, Promise<unknown>>();
  // 共通スキル置き場の外側 gate。GUI CRUD と、共通内を変更し得る既存の変更 API が参加する
  // (SDK のファイル隊列はこの gate の内側で取得する)。共通外の編集は直列化しない
  const commonSkillGate = createAsyncGate();
  const skillCrud: SkillCrudContext = {
    rootCwd,
    scanTimeoutMs: skillsScanTimeoutMs,
    archiveLimits,
    maxUploadBytes,
    gate: commonSkillGate,
  };

  /** 対象が共通スキル置き場へ影響し得るときだけ、変更の全体を共通 gate の中で実行する */
  const withCommonGate = async <T>(
    paths: readonly { path: string; mode: "inside" | "any" }[],
    run: () => Promise<T>,
  ): Promise<T> => {
    const touched = await Promise.all(
      paths.map((entry) => touchesCommonSkills({ rootCwd, requested: entry.path, mode: entry.mode })),
    );
    return touched.some(Boolean) ? commonSkillGate(run) : run();
  };

  /**
   * edit / write の対象が共通スキル置き場の中へ解決するときだけ、実行全体を共通 gate に入れる。
   * SDK の読取〜書込は既に withFileMutationQueue で直列化されているため、順序は gate → ファイル隊列になる。
   */
  const runToolWithGate = async <T>(
    run: () => Promise<T>,
    toolName: string,
    params: unknown,
    cwd: string,
  ): Promise<T> => {
    if (toolName !== "edit" && toolName !== "write") return run();
    const requested = (params as { path?: unknown } | null | undefined)?.path;
    if (typeof requested !== "string") return run();
    const touched = await touchesCommonSkills({ rootCwd, requested: resolve(cwd, requested), mode: "inside" });
    return touched ? commonSkillGate(run) : run();
  };

  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      tools: [...registryFor(rootCwd, writeScopeFor("", rootCwd)).keys()],
      cwd: rootCwd,
      runningExecutions: executions.size,
    });
  });

  // /v1/* は Bearer 認証を要求する (未認証はここで 401 になる)
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !tokensEqual(match[1], token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  // 実行環境の診断。応答は分類だけを返し、内部エラーの詳細はプロセスのログに限る。
  // Landlock の状態はラッパーの解決を持つこの service が足す (probeSandboxRuntime はコマンド検出だけ)。
  app.get("/v1/runtime/info", async (c) => {
    try {
      const [info, landlock] = await Promise.all([probeRuntimeInfo(rootCwd), landlockStatus()]);
      return c.json({ ...info, landlock });
    } catch (error) {
      console.warn(`[u7agent-sandbox] runtime info failed: ${messageFor(error)}`);
      return c.json({ error: "実行環境の診断に失敗しました" }, 500);
    }
  });

  // 待受ソケットと所有 PID の観測 (serve の所有者照合)。bash 実行は Landlock の ptrace 制限で
  // 他ドメインの /proc/<pid>/fd を読めないため、制限の外にいるこのプロセスが代行する。
  app.get("/v1/procs/listeners", async (c) => {
    const failed = (error: unknown) => {
      console.warn(`[u7agent-sandbox] listener scan failed: ${messageFor(error)}`);
      return c.json({ error: "待受プロセスの観測に失敗しました" }, 500);
    };
    const portQuery = c.req.query("port");
    const fromQuery = c.req.query("from");
    const toQuery = c.req.query("to");

    // port は単一ポート、from/to はレンジ。両方を受けると対象が 2 通りに読めるため排他にする。
    if (portQuery !== undefined && (fromQuery !== undefined || toQuery !== undefined)) {
      return c.json({ error: "port and from/to are exclusive" }, 400);
    }

    if (fromQuery !== undefined || toQuery !== undefined) {
      // レンジは状態表示のポーリング専用。重い fd 走査は単一ポートのときだけ許可する。
      if (c.req.query("scan") === "true") {
        return c.json({ error: "scan is not supported with from/to" }, 400);
      }
      const from = parsePortQuery(fromQuery);
      const to = parsePortQuery(toQuery);
      if (from === null || to === null) {
        return c.json({ error: "from and to must be valid TCP ports" }, 400);
      }
      if (from > to) return c.json({ error: "from must be less than or equal to to" }, 400);
      if (to - from + 1 > SANDBOX_MAX_LISTENER_RANGE_PORTS) {
        return c.json({ error: `range must be at most ${SANDBOX_MAX_LISTENER_RANGE_PORTS} ports` }, 400);
      }
      try {
        return c.json(await scanListenerRange(from, to));
      } catch (error) {
        return failed(error);
      }
    }

    const port = parsePortQuery(portQuery);
    if (port === null) return c.json({ error: "port must be a valid TCP port" }, 400);
    try {
      return c.json(await scanListeners(port, { scan: c.req.query("scan") === "true" }));
    } catch (error) {
      return failed(error);
    }
  });

  app.post("/v1/tools/:tool/execute", async (c) => {
    const toolName = c.req.param("tool") ?? "";
    // 定義は cwd ごとに生成するため、未知のツールは名前だけで先に弾く
    if (!(SANDBOX_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { toolCallId, params, cwd, env, writeScope } = (body ?? {}) as SandboxExecuteRequestBody;
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return c.json({ error: "params must be an object" }, 400);
    }
    if (cwd !== undefined && typeof cwd !== "string") {
      return c.json({ error: "cwd must be a string" }, 400);
    }
    let injected: Record<string, string> | undefined;
    try {
      injected = parseInjectedEnv(env);
    } catch (error) {
      return c.json({ error: messageFor(error) }, 400);
    }
    let requestedScope: SandboxWriteScopeEntry[] | undefined;
    try {
      requestedScope = parseWriteScope(writeScope);
    } catch (error) {
      return c.json({ error: messageFor(error) }, 400);
    }
    // 実行 cwd はリクエストごとに root 配下の実在ディレクトリへ解決する (実行時隔離ではなくパス解決の起点)
    let executionCwd: string;
    try {
      executionCwd = (await resolveWorkspaceDirectory(rootCwd, cwd ?? "")).target;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    // bash の許可 root。エージェントの bash は要求 cwd から導出し、BFF 内部実行は要求 scope だけを使う
    // (内部実行で root へ落ちる既定経路を作らない)。
    let bashRoots: LandlockWriteRoot[] | undefined;
    if (toolName === "bash") {
      try {
        bashRoots =
          requestedScope === undefined
            ? agentBashRoots(executionCwd, writeScopeFor(cwd ?? "", executionCwd))
            : [...requestBashRoots(requestedScope), ...fixedLandlockRoots];
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
        return c.json({ error: messageFor(error) }, statusCode as 400);
      }
    }
    // bash だけが子プロセスを持つため、env は bash にだけ渡す (他のツールは値を使わないし、
    // 渡しても値が経路に増えるだけ)。scope も定義に焼き込む必要があるため、指定があるときはキャッシュしない。
    const definition =
      toolName === "bash" && (injected !== undefined || requestedScope !== undefined)
        ? bashFor(executionCwd, bashRoots ?? [], injected)
        : registryFor(executionCwd, writeScopeFor(cwd ?? "", executionCwd)).get(toolName);
    if (!definition) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }
    const executionId = randomUUID();
    const abort = new AbortController();
    executions.set(executionId, abort);

    const encoder = new TextEncoder();
    let closed = false;
    const write = (event: SandboxEvent): boolean => {
      if (closed) return false;
      try {
        controller.enqueue(encoder.encode(encodeSandboxEvent(event)));
        return true;
      } catch {
        return false;
      }
    };

    // クライアント切断 (BFF 死亡・cancel 前の abort) でも実行を止める。
    const signal = c.req.raw.signal;
    const onClientAbort = () => abort.abort();
    signal?.addEventListener("abort", onClientAbort, { once: true });

    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        void (async () => {
          write({ type: "start", executionId });
          const onUpdate: ExecuteUpdateCallback = (payload) => {
            write({ type: "update", payload: { content: payload?.content, details: payload?.details } });
          };
          try {
            // Landlock が使えない環境では bash を実行しない (SDK の無制限な既定 shell へ落とさない)
            if (toolName === "bash") {
              const reason = await bashUnavailableReason();
              if (reason) throw new Error(`bash を実行できません: ${reason}`);
            }
            const runTool = async () => {
              throwIfAborted(abort.signal);
              const ctx = { cwd: executionCwd } as Parameters<AnyToolDefinition["execute"]>[4];
              return definition.execute(
                normalizeToolCallId(toolCallId),
                (params ?? {}) as Record<string, never>,
                abort.signal,
                onUpdate,
                ctx,
              );
            };
            const result = await runToolWithGate(runTool, toolName, params, executionCwd);
            write({
              type: "result",
              payload: {
                content: result?.content ?? [],
                details: result?.details,
              },
            });
          } catch (error) {
            write({ type: "error", message: messageFor(error) });
          } finally {
            executions.delete(executionId);
            signal?.removeEventListener("abort", onClientAbort);
            closed = true;
            try {
              controller.close();
            } catch {
              // cancel() で既に閉じている
            }
          }
        })();
      },
      cancel() {
        // BFF がストリームを読み捨てた (切断・abort) 場合も実行を止める。
        closed = true;
        abort.abort();
        executions.delete(executionId);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.get("/v1/files/preview", async (c) => {
    try {
      const { target } = await resolveWorkspaceDirectory(rootCwd, c.req.query("path") ?? "", false);
      const handle = await open(target, "r");
      try {
        const limit = SANDBOX_MAX_PREVIEW_BYTES;
        if (!(await handle.stat()).isFile()) throw pathError(400, "Not a regular file");
        // stat 後の増大でも無制限に読み込まない。
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > limit) throw pathError(400, "プレビューは2 MiB以下のファイルに対応しています");
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
        } catch {
          throw pathError(400, "UTF-8のテキストファイルのみプレビューできます");
        }
        // oxlint-disable-next-line no-control-regex -- バイナリ判定のため制御文字を検出する。
        if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw pathError(400, "バイナリファイルはプレビューできません");
        return c.json({ text });
      } finally {
        await handle.close();
      }
    } catch (error) {
      return c.json({ error: messageFor(error) }, ((error as { statusCode?: number }).statusCode ?? 400) as 400);
    }
  });

  app.get("/v1/files", async (c) => {
    try {
      return c.json(await listWorkspaceDirectory(rootCwd, c.req.query("path") ?? ""));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 通常ファイルとして実在するかの確認だけを返す (本文は読まない)。テキスト固有の 400 を混ぜないため、
  // プレビューとは別の入口にする
  app.get("/v1/files/stat", async (c) => {
    try {
      const { root, target } = await resolveWorkspaceDirectory(rootCwd, c.req.query("path") ?? "", false);
      return c.json({ path: relativeToRoot(root, target) });
    } catch (error) {
      // 想定外の失敗を 400 (拒否) に混ぜない。BFF / client では 400 以外は確認不能として扱う
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 作業フォルダ (root 相対) が属する repo のブランチ。repo の外はエラーではなく branch: null を返す
  app.get("/v1/files/git", async (c) => {
    try {
      const { target } = await resolveWorkspaceDirectory(rootCwd, c.req.query("path") ?? "");
      return c.json(await readWorkspaceGitInfo(target, { timeoutMs: gitInfoTimeoutMs, gitPath }));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // ファイルスキル (`.agents/skills`) の発見。dir の検証は GET /v1/files と同じ経路を通す
  app.get("/v1/skills", async (c) => {
    try {
      return c.json(await listWorkspaceSkills(rootCwd, c.req.query("dir") ?? "", skillsScanTimeoutMs));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  /**
   * スキル持ち出しの計画。対象は `.agents/skills` 固定で、除外は `.git` 固定 + symlink 除外。
   * 利用者の除外設定 (archive-rules) は使わず、直下は SKILL.md を持つフォルダだけに絞る。
   */
  const planSkillsExport = async (): Promise<ArchivePlan> => {
    const { target } = await resolveWorkspaceDirectory(rootCwd, COMMON_SKILLS_DIR, true);
    return walkArchive({
      dir: target,
      excludeNames: SKILLS_ARCHIVE_EXCLUDE_NAMES,
      limits: archiveLimits,
      skillsOnly: true,
    });
  };

  // スキル持ち出しの事前チェック。download の check と同じ形を返し、UI は 413 の理由を先に出せる
  app.get("/v1/skills/export/check", async (c) => {
    try {
      const plan = await planSkillsExport();
      const check: SandboxDownloadCheck = {
        kind: "archive",
        name: SKILLS_EXPORT_NAME,
        bytes: plan.bytes,
        entries: plan.entryCount,
        skipped: plan.skipped,
      };
      return c.json(check);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // スキル持ち出しの本体。ZIP はストリームなので長さを確定できない (Content-Length を付けない)
  app.get("/v1/skills/export", async (c) => {
    try {
      const plan = await planSkillsExport();
      return new Response(createZipStream(plan.entries), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": archiveContentDisposition(SKILLS_EXPORT_NAME),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // スキル取り込み。BFF は bodyGuard を通さず raw の ZIP をそのまま流す (dryRun / replace は query)
  app.post("/v1/skills/import", async (c) => {
    const dryRun = parseTrueOnlyQuery(c.req.queries("dryRun"));
    if (!dryRun.ok) return c.json({ error: DRY_RUN_QUERY_ERROR }, 400);
    const replace = parseReplaceQuery(c.req.queries("replace"));
    if (!replace.ok) return c.json({ error: replace.message }, 400);
    try {
      return c.json(
        await importSkills(skillCrud, {
          body: c.req.raw.body,
          replace: replace.names,
          dryRun: dryRun.value,
          signal: c.req.raw.signal,
        }),
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 共通スキルの編集内容。GUI の選択キーは一覧の root 相対 relativePath に揃える
  app.get("/v1/skills/file", async (c) => {
    try {
      return c.json(await readCommonSkillDetail(skillCrud, c.req.query("relativePath") ?? "", c.req.raw.signal));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 共通スキルの新規作成。既存のディレクトリ / 同名の共通スキルは 409 (上書きも連番化もしない)
  app.post("/v1/skills/file", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const fields = skillTextFieldsOf(body, ["name", "description", "body"]);
    if (!fields.ok) return c.json({ error: fields.message }, 400);
    try {
      const input = fields.value as unknown as SandboxSkillCreateBody;
      return c.json(await createCommonSkill(skillCrud, input, c.req.raw.signal), 201);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 共通スキルの保存。name は受け付けず、fileVersion の一致と SDK 検証を要求する
  app.patch("/v1/skills/file", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const fields = skillTextFieldsOf(body, ["relativePath", "fileVersion", "description", "body"]);
    if (!fields.ok) return c.json({ error: fields.message }, 400);
    try {
      const input = fields.value as unknown as SandboxSkillSaveBody;
      return c.json(await saveCommonSkill(skillCrud, input, c.req.raw.signal));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 削除確認。対象フォルダと付随ファイル・treeVersion を返すだけで、何も変更しない
  app.get("/v1/skills/file/delete-preview", async (c) => {
    try {
      return c.json(await previewCommonSkillDelete(skillCrud, c.req.query("relativePath") ?? "", c.req.raw.signal));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 専用フォルダの削除。treeVersion の一致を要求し、成功時だけ配下ごと消す (body は読まない)
  app.delete("/v1/skills/file", async (c) => {
    try {
      await deleteCommonSkill(
        skillCrud,
        c.req.query("relativePath") ?? "",
        c.req.query("treeVersion") ?? "",
        c.req.raw.signal,
      );
      return c.body(null, 204);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 削除できるのは通常ファイルだけ (ディレクトリと symlink は 400)。成功は本文なしの 204
  app.delete("/v1/files", async (c) => {
    try {
      await withCommonGate([{ path: c.req.query("path") ?? "", mode: "any" }], () =>
        removeWorkspaceFile(rootCwd, c.req.query("path") ?? ""),
      );
      return c.body(null, 204);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 画像と音声をストリームで返す。BFF は status / Content-Type / 長さ / Range 系ヘッダ / no-store / nosniff を付け直して配る
  app.get("/v1/files/raw", async (c) => {
    const requested = c.req.query("path") ?? "";
    const contentType = rawContentType(requested);
    if (!contentType) return c.json({ error: `Not a servable file: ${requested}` }, 400);
    try {
      const { target } = await resolveWorkspaceDirectory(rootCwd, requested, false);
      const stats = await stat(target);
      if (stats.size > maxUploadBytes) {
        return c.json({ error: `File is too large (max ${maxUploadBytes} bytes)` }, 413);
      }
      const range = parseByteRange(c.req.header("range"), stats.size);
      if (range.kind === "unsatisfiable") {
        // 416 の Content-Range は「全体の長さ」を表す (bytes */<size>)
        return c.json({ error: "Range is not satisfiable" }, 416, {
          "Content-Range": `bytes */${stats.size}`,
          "Accept-Ranges": "bytes",
        });
      }
      if (range.kind === "satisfiable") {
        return new Response(
          Readable.toWeb(
            createReadStream(target, { start: range.start, end: range.end }),
          ) as ReadableStream<Uint8Array>,
          {
            status: 206,
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(range.end - range.start + 1),
              "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}`,
              "Accept-Ranges": "bytes",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          },
        );
      }
      return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(stats.size),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // ダウンロードの事前チェック。walk は download と同じ計画を使い、ブラウザに生 JSON を見せずに理由を出す
  app.get("/v1/files/download/check", async (c) => {
    const exclude = parseArchiveExcludeQuery(c.req.queries("exclude"));
    if (!exclude.ok) return c.json({ error: exclude.message }, 400);
    try {
      const plan = await planDownload({
        rootCwd,
        requested: c.req.query("path") ?? "",
        // param なしは「BFF 未指定」なので既定に倒す（直叩きでも安全側）
        excludeNames: exclude.names ?? DEFAULT_ARCHIVE_EXCLUDE_NAMES,
        limits: archiveLimits,
      });
      return c.json(downloadCheckFor(plan));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 通常ファイルは生配信、ディレクトリはストリーミング ZIP。どちらも添付として配るため画像 allowlist は通さない
  // (HTML / SVG もここでは配る。レンダリングさせないよう attachment と nosniff を付ける)
  app.get("/v1/files/download", async (c) => {
    const exclude = parseArchiveExcludeQuery(c.req.queries("exclude"));
    if (!exclude.ok) return c.json({ error: exclude.message }, 400);
    try {
      const plan = await planDownload({
        rootCwd,
        requested: c.req.query("path") ?? "",
        excludeNames: exclude.names ?? DEFAULT_ARCHIVE_EXCLUDE_NAMES,
        limits: archiveLimits,
      });
      const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (plan.kind === "file") {
        return new Response(Readable.toWeb(createReadStream(plan.target)) as ReadableStream<Uint8Array>, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(plan.size),
            "Content-Disposition": archiveContentDisposition(plan.name),
            ...common,
          },
        });
      }
      return new Response(createZipStream(plan.walk.entries), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          // ZIP はストリームなので長さを確定できない (Content-Length を付けない)
          "Content-Disposition": archiveContentDisposition(archiveDownloadName(plan.name)),
          ...common,
        },
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 引き継ぎメモ (HANDOFF.md) の読取り。専用の上限・UTF-8・バイナリ判定を持ち、不存在は 404。
  // プレビュー API の流用はしない (上限が変わるため)。最終要素の symlink は書込みと同じく拒む
  app.get("/v1/files/handoff", async (c) => {
    try {
      const requested = c.req.query("path") ?? "";
      const { target, existing } = await resolveHandoffPath(rootCwd, requested);
      if (!existing) throw pathError(404, `Path not found: ${requested}`);
      return c.json({ text: await readHandoffText(target) });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 引き継ぎメモの先頭追記。読んでから書くまでを実パス単位の排他の中で行い、既存の中身は解釈せずそのまま残す。
  app.post("/v1/files/handoff", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { path, section, dedupeKey } = (body ?? {}) as { path?: unknown; section?: unknown; dedupeKey?: unknown };
    if (typeof path !== "string" || typeof section !== "string" || typeof dedupeKey !== "string") {
      return c.json({ error: "path, section and dedupeKey must be strings" }, 400);
    }
    if (Buffer.byteLength(section, "utf8") > SANDBOX_MAX_HANDOFF_BYTES) {
      return c.json({ error: "The handoff memo is too large" }, 400);
    }
    try {
      return c.json(
        await withCommonGate([{ path, mode: "inside" }], () =>
          writeHandoffText(rootCwd, path, section, dedupeKey, handoffWrites),
        ),
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 新規作成した引き継ぎメモの取り消し。内容が expected と一致するときだけ、追記と同じ実パス排他の
  // 中で削除する (背後で進んだ他の追記を巻き戻さない)
  app.post("/v1/files/handoff/rollback", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { path, expected } = (body ?? {}) as { path?: unknown; expected?: unknown };
    if (typeof path !== "string" || typeof expected !== "string") {
      return c.json({ error: "path and expected must be strings" }, 400);
    }
    try {
      return c.json(
        await withCommonGate([{ path, mode: "inside" }], () =>
          rollbackHandoffText(rootCwd, path, expected, handoffWrites),
        ),
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 選択時の即時アップロード。BFF は bodyGuard (既定 64 KiB / text 化) を通さず、ここへ raw で流す
  app.post("/v1/files/upload", async (c) => {
    const name = c.req.query("name") ?? "";
    if (!isValidEntryName(name)) return c.json({ error: `Invalid file name: ${name}` }, 400);
    try {
      const uploaded = await withCommonGate([{ path: c.req.query("dir") ?? "", mode: "inside" }], () =>
        saveUploadedFile({
          rootCwd,
          dir: c.req.query("dir") ?? "",
          name,
          body: c.req.raw.body,
          maxBytes: maxUploadBytes,
        }),
      );
      return c.json(uploaded, 201);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 親をまたいで動かせるのは通常ファイルとディレクトリだけ (symlink は 400)。応答は移動後の root 相対パス
  app.post("/v1/files/move", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { from, to } = (body ?? {}) as SandboxMoveRequestBody;
    if (typeof from !== "string") return c.json({ error: "from must be a string" }, 400);
    if (typeof to !== "string") return c.json({ error: "to must be a string" }, 400);
    try {
      return c.json(
        await withCommonGate(
          [
            { path: from, mode: "any" },
            { path: to, mode: "any" },
          ],
          () => moveWorkspaceEntry(rootCwd, from, to),
        ),
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 名前を変えられるのは通常ファイルとディレクトリだけ (symlink は 400)。応答は改名後の root 相対パス
  app.post("/v1/files/rename", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { path, name } = (body ?? {}) as SandboxRenameRequestBody;
    if (typeof path !== "string") return c.json({ error: "path must be a string" }, 400);
    if (typeof name !== "string") return c.json({ error: "name must be a string" }, 400);
    // 名前の検証は保存名と同じ規則。同名の扱い (409) はパスの解決後に行う
    if (!isValidEntryName(name)) return c.json({ error: `Invalid name: ${name}` }, 400);
    try {
      return c.json(await withCommonGate([{ path, mode: "any" }], () => renameWorkspaceEntry(rootCwd, path, name)));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  app.post("/v1/dirs", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { path } = (body ?? {}) as SandboxCreateDirRequestBody;
    if (typeof path !== "string") {
      return c.json({ error: "path must be a string" }, 400);
    }
    try {
      return c.json({
        path: await withCommonGate([{ path, mode: "inside" }], () => createWorkspaceDirectory(rootCwd, path)),
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 削除できるのはディレクトリだけ (通常ファイルと symlink は 400)。recursive=true のときだけ配下ごと消す。
  // 成功は本文なしの 204
  app.delete("/v1/dirs", async (c) => {
    const recursive = parseRecursiveQuery(c.req.queries("recursive"));
    if (!recursive.ok) return c.json({ error: RECURSIVE_QUERY_ERROR }, 400);
    try {
      await withCommonGate([{ path: c.req.query("path") ?? "", mode: "any" }], () =>
        removeWorkspaceDirectory(rootCwd, c.req.query("path") ?? "", recursive.recursive),
      );
      return c.body(null, 204);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  app.post("/v1/executions/:id/cancel", (c) => {
    const id = c.req.param("id") ?? "";
    const abort = executions.get(id);
    if (!abort) {
      return c.json({ error: "Execution not found" }, 404);
    }
    abort.abort();
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return {
    app,
    executions,
    close: () => {
      for (const abort of executions.values()) abort.abort();
      executions.clear();
    },
  };
}
