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
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashSpawnContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { COMMON_SKILLS_DIR } from "../app-paths";
import { resolveArchiveExcludeNames } from "../archive-rules";
import {
  archiveContentDisposition,
  archiveDownloadName,
  archiveExcludedDirectoryError,
  archiveTooLargeError,
  DEFAULT_ARCHIVE_LIMITS,
  walkArchive,
  type ArchiveLimits,
  type ArchivePlan,
} from "./archive";
import { SKILLS_SCAN_TIMEOUT_MS, scanSkillsWithDeadline } from "./skills-scan";
import {
  SANDBOX_MAX_BODY_BYTES,
  SANDBOX_MAX_FILE_ENTRIES,
  SANDBOX_MAX_PREVIEW_BYTES,
  SANDBOX_MAX_UPLOAD_BYTES,
  encodeSandboxEvent,
  isValidEntryName,
  parseRecursiveQuery,
  rawImageContentType,
  RECURSIVE_QUERY_ERROR,
  type SandboxCreateDirRequestBody,
  type SandboxDownloadCheck,
  type SandboxExecuteRequestBody,
  type SandboxEvent,
  type SandboxFileEntry,
  type SandboxFileListing,
  type SandboxFileUpload,
  type SandboxRenameRequestBody,
  type SandboxRenameResult,
  type SandboxSkillEntry,
  type SandboxSkillsResponse,
} from "./protocol";
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
 * write / edit が書ける範囲。モデルの取り違え (workspace root への絶対パス) を防ぐファイルツールのポリシーで、
 * 実行隔離ではない (bash は塞げない)。許可 root は実行 cwd (realpath)・要求 cwd の lexical 形
 * (root / 登録ディレクトリが symlink でも system prompt に出た絶対パスを通す)・共通スキル置き場の 3 つ。
 */
interface WriteScope {
  cwd: string;
  lexicalCwd: string;
  skillsDir: string;
}

/** 判定は lexical。SDK が解決済みの絶対パスを resolve() で `..` まで畳んでから比較する (realpath / lstat は使わない)。 */
function isWritablePath(candidate: string, cwd: string, lexicalCwd: string, skillsDir: string): boolean {
  const target = resolve(candidate);
  return isInsideRoot(cwd, target) || isInsideRoot(lexicalCwd, target) || isInsideRoot(skillsDir, target);
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

/** listen は呼び出し側 (@hono/node-server) が行い、テストは app.request() で検証する。 */
export function createSandboxService(options: SandboxServiceOptions): SandboxService {
  const token = options.token;
  if (!token || token.trim().length < 16) {
    throw new Error("PI_SANDBOX_TOKEN must be set to a non-trivial value (16+ chars)");
  }
  const rootCwd = options.rootCwd || "/workspace";
  const maxUploadBytes = options.maxUploadBytes ?? SANDBOX_MAX_UPLOAD_BYTES;
  const skillsScanTimeoutMs = options.skillsScanTimeoutMs ?? SKILLS_SCAN_TIMEOUT_MS;
  const archiveLimits: ArchiveLimits = {
    maxBytes: options.maxArchiveBytes ?? DEFAULT_ARCHIVE_LIMITS.maxBytes,
    maxEntries: options.maxArchiveEntries ?? DEFAULT_ARCHIVE_LIMITS.maxEntries,
  };
  // 除外規則の実効値 (フェーズ 2 で設定ストアに差し替える)。health の開示と同じ関数から引く
  const archiveExcludeNames = resolveArchiveExcludeNames();

  // bash にはセッションメタ変数 (PI_SESSION_ID 等) を注入せず (サンドボックスにセッションは無い)、
  // SDK の bash が process.env を継承しても、このプロセスの唯一の秘密値である共有トークンだけは剥がす。
  const stripSandboxToken = (context: BashSpawnContext): BashSpawnContext => {
    const env: NodeJS.ProcessEnv = { ...context.env };
    delete env.PI_SANDBOX_TOKEN;
    return { ...context, env };
  };

  const lexicalRoot = resolve(rootCwd);

  /** 要求 cwd から write / edit の許可 root を組む。skillsDir は共通スキル (`<root>/.agents/skills`) で、未作成でも通す。 */
  const writeScopeFor = (requestedCwd: string, executionCwd: string): WriteScope => ({
    cwd: executionCwd,
    lexicalCwd: resolve(lexicalRoot, requestedCwd || "."),
    skillsDir: join(lexicalRoot, COMMON_SKILLS_DIR),
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
    const assertWritable = (candidate: string): void => {
      if (isWritablePath(candidate, scope.cwd, scope.lexicalCwd, scope.skillsDir)) return;
      throw writeScopeError(candidate, scope.cwd, scope.skillsDir);
    };
    const definitions: AnyToolDefinition[] = [
      createBashToolDefinition(cwd, {
        exposeSessionEnvironment: false,
        spawnHook: stripSandboxToken,
      }),
      createReadToolDefinition(cwd),
      createEditToolDefinition(cwd, {
        operations: {
          access: async (target) => {
            // 判定を実際の access より先に行う (実在しないパスでも SDK に ENOENT を先に出させない)
            assertWritable(target);
            await access(target, constants.R_OK | constants.W_OK);
          },
          readFile: async (target) => {
            assertWritable(target);
            return readFile(target);
          },
          writeFile: async (target, content) => {
            assertWritable(target);
            await writeFile(target, content, "utf-8");
          },
        },
      }),
      createWriteToolDefinition(cwd, {
        operations: {
          // mkdir も判定する (先に許すと拒否パスでも workdir 外に親ディレクトリができる)
          mkdir: async (dir) => {
            assertWritable(dir);
            await mkdir(dir, { recursive: true });
          },
          writeFile: async (target, content) => {
            assertWritable(target);
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
    const { toolCallId, params, cwd } = (body ?? {}) as SandboxExecuteRequestBody;
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return c.json({ error: "params must be an object" }, 400);
    }
    if (cwd !== undefined && typeof cwd !== "string") {
      return c.json({ error: "cwd must be a string" }, 400);
    }
    // 実行 cwd はリクエストごとに root 配下の実在ディレクトリへ解決する (実行時隔離ではなくパス解決の起点)
    let executionCwd: string;
    try {
      executionCwd = (await resolveWorkspaceDirectory(rootCwd, cwd ?? "")).target;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const definition = registryFor(executionCwd, writeScopeFor(cwd ?? "", executionCwd)).get(toolName);
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
            const ctx = { cwd: executionCwd } as Parameters<AnyToolDefinition["execute"]>[4];
            const result = await definition.execute(
              normalizeToolCallId(toolCallId),
              (params ?? {}) as Record<string, never>,
              abort.signal,
              onUpdate,
              ctx,
            );
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
        if (size > limit) throw pathError(400, "プレビューは256 KiB以下のファイルに対応しています");
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

  // ファイルスキル (`.agents/skills`) の発見。dir の検証は GET /v1/files と同じ経路を通す
  app.get("/v1/skills", async (c) => {
    try {
      return c.json(await listWorkspaceSkills(rootCwd, c.req.query("dir") ?? "", skillsScanTimeoutMs));
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 削除できるのは通常ファイルだけ (ディレクトリと symlink は 400)。成功は本文なしの 204
  app.delete("/v1/files", async (c) => {
    try {
      await removeWorkspaceFile(rootCwd, c.req.query("path") ?? "");
      return c.body(null, 204);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
  });

  // 画像だけをストリームで返す。BFF は Content-Type / 長さ / no-store / nosniff を付け直して配る
  app.get("/v1/files/raw", async (c) => {
    const requested = c.req.query("path") ?? "";
    const contentType = rawImageContentType(requested);
    if (!contentType) return c.json({ error: `Not a servable image: ${requested}` }, 400);
    try {
      const { target } = await resolveWorkspaceDirectory(rootCwd, requested, false);
      const stats = await stat(target);
      if (stats.size > maxUploadBytes) {
        return c.json({ error: `Image is too large (max ${maxUploadBytes} bytes)` }, 413);
      }
      return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(stats.size),
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
    try {
      const plan = await planDownload({
        rootCwd,
        requested: c.req.query("path") ?? "",
        excludeNames: archiveExcludeNames,
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
    try {
      const plan = await planDownload({
        rootCwd,
        requested: c.req.query("path") ?? "",
        excludeNames: archiveExcludeNames,
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

  // 選択時の即時アップロード。BFF は bodyGuard (既定 64 KiB / text 化) を通さず、ここへ raw で流す
  app.post("/v1/files/upload", async (c) => {
    const name = c.req.query("name") ?? "";
    if (!isValidEntryName(name)) return c.json({ error: `Invalid file name: ${name}` }, 400);
    try {
      const uploaded = await saveUploadedFile({
        rootCwd,
        dir: c.req.query("dir") ?? "",
        name,
        body: c.req.raw.body,
        maxBytes: maxUploadBytes,
      });
      return c.json(uploaded, 201);
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
      return c.json(await renameWorkspaceEntry(rootCwd, path, name));
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
      return c.json({ path: await createWorkspaceDirectory(rootCwd, path) });
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
      await removeWorkspaceDirectory(rootCwd, c.req.query("path") ?? "", recursive.recursive);
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
