import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, open, stat, unlink } from "node:fs/promises";
import { basename, join, parse } from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { parseByteRange } from "../byte-range";
import { messageFor, pathError } from "../errors";
import {
  archiveContentDisposition,
  archiveDownloadName,
  archiveExcludedDirectoryError,
  archiveTooLargeError,
  walkArchive,
  type ArchiveLimits,
  type ArchivePlan,
  type ArchivePlanLimits,
} from "./archive";
import {
  createWorkspaceDirectory,
  realpathNative,
  relativeToRoot,
  resolveWorkspaceDirectory,
  resolveWorkspaceEntry,
  workspaceEntryName,
} from "./fs-path";
import {
  rawContentType,
  type SandboxDownloadCheck,
  type SandboxDownloadPlan,
  type SandboxFileUpload,
} from "./protocol";
import { routeError } from "./route-http";
import { createZipStream } from "./zip";

/** 解決だけをしたダウンロード対象。archive の `size` は使わない（`planDownload` が `walk` を付ける） */
interface DownloadTarget {
  kind: "file" | "archive";
  /** 保存名の元。ファイルはその名前、ZIP はフォルダ名（`.zip` は応答で付ける） */
  name: string;
  target: string;
  /** file のサイズ */
  size: number;
}

type DownloadPlan = ({ kind: "file" } & DownloadTarget) | ({ kind: "archive"; walk: ArchivePlan } & DownloadTarget);

async function resolveDownloadTarget(rootCwd: string, requestedRaw: string): Promise<DownloadTarget> {
  // 末尾の区切りは同じ対象を指すため落とす (`..` の適用順を変える字句正規化はしない)
  const requested = requestedRaw.replace(/\/+$/, "");
  if (!requested || requested === ".") {
    const { root, target } = await resolveWorkspaceDirectory(rootCwd, "", true);
    return { kind: "archive", name: basename(root) || "workspace", target, size: 0 };
  }

  const name = workspaceEntryName(requested);
  if (name === undefined) throw pathError(400, `Not a file or directory: ${requested}`);
  const { target, targetStat, kind } = await resolveWorkspaceEntry(
    rootCwd,
    requested,
    name,
    "file or directory",
    "Symbolic links cannot be downloaded",
  );
  if (kind === "regular file") return { kind: "file", name, target, size: targetStat.size };
  return { kind: "archive", name, target, size: 0 };
}

/**
 * 事前チェックと本文送出が共有する計画。walk はヘッダを送る前に終わらせ、除外名のディレクトリ・
 * サイズ超過・件数超過を 4xx で返す（途中で切れた zip を配らない）。
 */
export async function planDownload(input: {
  rootCwd: string;
  requested: string;
  excludeNames: readonly string[];
  limits: ArchiveLimits;
  planLimits?: ArchivePlanLimits;
  /** このサイズを超えたファイルを oversizeFiles に載せる (省略時は個別サイズを見ない) */
  maxFileBytes?: number;
}): Promise<DownloadPlan> {
  const target = await resolveDownloadTarget(input.rootCwd, input.requested);
  if (target.kind === "file") {
    if (target.size > input.limits.maxBytes) throw archiveTooLargeError(input.limits.maxBytes);
    return { ...target, kind: "file" };
  }
  // 除外名のディレクトリそのものを指定されたら断る (UI は行に導線を出さないが、直叩きも防ぐ)
  if (input.excludeNames.includes(target.name)) throw archiveExcludedDirectoryError(target.name);
  const walk = await walkArchive({
    dir: target.target,
    excludeNames: input.excludeNames,
    limits: input.limits,
    ...(input.planLimits ? { planLimits: input.planLimits } : {}),
    ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }),
  });
  return { ...target, kind: "archive", walk };
}

/**
 * 計画の応答。download / check と同じ計画から導き、一覧は先頭だけに切り詰める
 * (`entries` / `bytes` は打ち切らない)。単体ファイルは walk を通らないのでここで埋める。
 */
export function downloadPlanFor(plan: DownloadPlan, maxFileBytes: number | undefined): SandboxDownloadPlan {
  if (plan.kind === "file") {
    return {
      kind: "file",
      name: plan.name,
      entries: 0,
      bytes: plan.size,
      files: [{ name: plan.name, size: plan.size }],
      truncated: false,
      links: [],
      linksTruncated: false,
      oversizeFiles: maxFileBytes !== undefined && plan.size > maxFileBytes ? [plan.name] : [],
      oversizeTruncated: false,
      hasIndexHtml: plan.name === "index.html",
      skipped: [],
    };
  }
  return {
    kind: "archive",
    name: archiveDownloadName(plan.name),
    entries: plan.walk.entryCount,
    bytes: plan.walk.bytes,
    files: plan.walk.files,
    truncated: plan.walk.filesTruncated,
    links: plan.walk.links,
    linksTruncated: plan.walk.linksTruncated,
    oversizeFiles: plan.walk.oversizeFiles,
    oversizeTruncated: plan.walk.oversizeTruncated,
    hasIndexHtml: plan.walk.hasIndexHtml,
    skipped: plan.walk.skipped,
  };
}

/** 事前チェックの応答。見積りは download と同じ計画から導く（エラーの出どころを 1 つにする）。 */
export function downloadCheckFor(plan: DownloadPlan): SandboxDownloadCheck {
  if (plan.kind === "file") return { kind: "file", name: plan.name, bytes: plan.size, entries: 0, skipped: [] };
  return {
    kind: "archive",
    name: archiveDownloadName(plan.name),
    bytes: plan.walk.bytes,
    entries: plan.walk.entryCount,
    skipped: plan.walk.skipped,
  };
}

// HTML / SVG も添付できる。ブラウザでレンダリングさせないよう attachment と nosniff を付ける。
export function downloadResponseFor(plan: DownloadPlan): Response {
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
}

// BFF の中継も status、Content-Type、長さ、Range 系ヘッダ、no-store、nosniff を保つ。
export async function serveRawFile(c: Context, rootCwd: string, maxUploadBytes: number): Promise<Response> {
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
        Readable.toWeb(createReadStream(target, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>,
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
    return routeError(c, error, 500);
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
export async function saveUploadedFile(input: {
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
