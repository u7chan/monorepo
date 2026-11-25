/**
 * サンドボックス ツール実行サービス (HTTP)。SDK の作業用ツールをこのプロセスのローカル実装で実行し、結果を NDJSON で返す。
 * LLM 認証情報をこのプロセスの環境へ入れないことはデプロイ側の前提。
 * /v1/* は未認証を 401 で拒否し、/healthz だけは Compose healthcheck 用に無認証で開ける。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { DEFAULT_ARCHIVE_EXCLUDE_NAMES } from "../archive-rules";
import { messageFor } from "../errors";
import { KeyedSerialLock, SerialLock } from "../serial-lock";
import {
  archiveContentDisposition,
  DEFAULT_ARCHIVE_LIMITS,
  DEFAULT_ARCHIVE_PLAN_LIMITS,
  SKILLS_EXPORT_NAME,
  type ArchiveLimits,
  type ArchivePlanLimits,
} from "./archive";
import {
  createCommonSkill,
  deleteCommonSkill,
  listWorkspaceSkills,
  planSkillsExport,
  previewCommonSkillDelete,
  readCommonSkillDetail,
  saveCommonSkill,
  skillTextFieldsOf,
  withCommonGate,
  type SkillCrudContext,
} from "./common-skills";
import {
  downloadCheckFor,
  downloadPlanFor,
  downloadResponseFor,
  planDownload,
  saveUploadedFile,
  serveRawFile,
} from "./file-transfer";
import { createWorkspaceDirectory, relativeToRoot, resolveWorkspaceDirectory } from "./fs-path";
import { GIT_INFO_TIMEOUT_MS, readWorkspaceGitInfo } from "./git-info";
import { readHandoffFile, rollbackHandoffText, writeHandoffText } from "./handoff-file";
import { openedFilePath, readScopedImageInput } from "./image-input";
import { scanListenerRange, scanListeners } from "./process-scan";
import {
  DRY_RUN_QUERY_ERROR,
  isValidEntryName,
  parseArchiveExcludeQuery,
  parseMaxFileBytesQuery,
  parseRecursiveQuery,
  parseTrueOnlyQuery,
  RECURSIVE_QUERY_ERROR,
  SANDBOX_EGRESS_POLICY_CAPABILITY,
  SANDBOX_GIT_CONFIG_CAPABILITY,
  SANDBOX_MAX_HANDOFF_BYTES,
  SANDBOX_MAX_LISTENER_RANGE_PORTS,
  SANDBOX_MAX_UPLOAD_BYTES,
  type SandboxCreateDirRequestBody,
  type SandboxDownloadCheck,
  type SandboxLandlockStatus,
  type SandboxMoveRequestBody,
  type SandboxRenameRequestBody,
  type SandboxSkillCreateBody,
  type SandboxSkillSaveBody,
} from "./protocol";
import { readRouteJson, routeError } from "./route-http";
import { probeSandboxRuntime, type SandboxRuntimeProbeResult } from "./runtime-info";
import { importSkills, parseReplaceQuery } from "./skill-import";
import { SKILLS_SCAN_TIMEOUT_MS } from "./skills-scan";
import { createToolExecution } from "./tool-execution";
import {
  listWorkspaceDirectory,
  moveWorkspaceEntry,
  readWorkspacePreview,
  removeWorkspaceDirectory,
  removeWorkspaceFile,
  renameWorkspaceEntry,
} from "./workspace-files";
import { createZipStream } from "./zip";

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
  /** テストで小さくできる計画の一覧件数上限 (既定 500) */
  maxPlanFiles?: number;
  /** テストで小さくできる計画のパス一覧上限 (既定 100) */
  maxPlanPaths?: number;
  /** テストで小さくできるスキル走査の期限 (既定 2s) */
  skillsScanTimeoutMs?: number;
  /** テストで小さくできる git 情報の期限 (既定 2s) */
  gitInfoTimeoutMs?: number;
  /** テストで差し替える git の実行パス (既定は信頼ディレクトリから解決した git) */
  gitPath?: string;
  /** テストで差し替える HOME。既定は os.homedir() (HOME 優先、無ければ passwd) */
  homeDir?: string;
  /** テストで差し替える実行環境の診断 (既定は実プロセスでコマンドを検出する) */
  probeRuntimeInfo?: (rootCwd: string) => Promise<SandboxRuntimeProbeResult>;
  /** テストで差し替えるラッパーの解決 (既定は固定パスの実体を確認して解決する) */
  resolveLandlockExec?: () => string | undefined;
  /** テストで差し替える Landlock の診断 (既定はラッパーの `--abi` を実行する) */
  probeLandlock?: () => Promise<SandboxLandlockStatus>;
  /**
   * テストで差し替える「開いた実体の実パスを引き直す」処理。既定は procfs 経由。
   * undefined を返すと読取は拒否される (差し替え競合の回帰テスト用)。
   */
  resolveOpenedImageInputPath?: (fd: number) => Promise<string | undefined>;
}

export interface SandboxService {
  app: Hono;
  executions: Map<string, AbortController>;
  close: () => void;
}

/** 長さを漏らさないための定数時間比較 (sha256 で同じ長さに揃える)。 */
function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
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
  const planLimits: ArchivePlanLimits = {
    maxFiles: options.maxPlanFiles ?? DEFAULT_ARCHIVE_PLAN_LIMITS.maxFiles,
    maxPaths: options.maxPlanPaths ?? DEFAULT_ARCHIVE_PLAN_LIMITS.maxPaths,
  };
  const probeRuntimeInfo = options.probeRuntimeInfo ?? ((workspaceRoot: string) => probeSandboxRuntime(workspaceRoot));
  const resolveOpenedImageInputPath = options.resolveOpenedImageInputPath ?? openedFilePath;
  // 作業フォルダを共有する会話の同時追記を失わないよう、会話 ID ではなく実パスで揃える。
  const handoffWrites = new KeyedSerialLock<string>();
  const skillCrud: SkillCrudContext = {
    rootCwd,
    scanTimeoutMs: skillsScanTimeoutMs,
    archiveLimits,
    maxUploadBytes,
    gate: new SerialLock(),
  };
  const tools = createToolExecution(rootCwd, gitPath, options, skillCrud.gate);

  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      tools: tools.listToolNames(),
      cwd: rootCwd,
      runningExecutions: tools.executions.size,
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
  app.get("/v1/runtime/info", async (c) => {
    try {
      const [info, landlock] = await Promise.all([probeRuntimeInfo(rootCwd), tools.landlockStatus()]);
      await tools.startupGitPrepare;
      return c.json({
        ...info,
        landlock,
        capabilities: [SANDBOX_GIT_CONFIG_CAPABILITY, SANDBOX_EGRESS_POLICY_CAPABILITY],
        gitConfig: tools.gitConfigStatus(),
      });
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

  app.post("/v1/tools/:tool/execute", tools.execute);

  app.get("/v1/files/preview", async (c) => {
    try {
      return c.json({ text: await readWorkspacePreview(rootCwd, c.req.query("path") ?? "") });
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

  app.get("/v1/files", async (c) => {
    try {
      return c.json(await listWorkspaceDirectory(rootCwd, c.req.query("path") ?? ""));
    } catch (error) {
      return routeError(c, error, 500);
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
      return routeError(c, error, 500);
    }
  });

  // 作業フォルダ (root 相対) が属する repo のブランチ。repo の外はエラーではなく branch: null を返す
  app.get("/v1/files/git", async (c) => {
    try {
      const { target } = await resolveWorkspaceDirectory(rootCwd, c.req.query("path") ?? "");
      return c.json(await readWorkspaceGitInfo(target, { timeoutMs: gitInfoTimeoutMs, gitPath }));
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  app.get("/v1/skills", async (c) => {
    try {
      return c.json(await listWorkspaceSkills(rootCwd, c.req.query("dir") ?? "", skillsScanTimeoutMs));
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  // スキル持ち出しの事前チェック。download の check と同じ形を返し、UI は 413 の理由を先に出せる
  app.get("/v1/skills/export/check", async (c) => {
    try {
      const plan = await planSkillsExport(rootCwd, archiveLimits);
      const check: SandboxDownloadCheck = {
        kind: "archive",
        name: SKILLS_EXPORT_NAME,
        bytes: plan.bytes,
        entries: plan.entryCount,
        skipped: plan.skipped,
      };
      return c.json(check);
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

  // ZIP はストリームなので長さを確定できない (Content-Length を付けない)
  app.get("/v1/skills/export", async (c) => {
    try {
      const plan = await planSkillsExport(rootCwd, archiveLimits);
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
      return routeError(c, error, 400);
    }
  });

  // BFF は bodyGuard を通さず raw の ZIP をそのまま流す (dryRun / replace は query)
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
      return routeError(c, error, 500);
    }
  });

  // 共通スキルの編集内容。GUI の選択キーは一覧の root 相対 relativePath に揃える
  app.get("/v1/skills/file", async (c) => {
    try {
      return c.json(await readCommonSkillDetail(skillCrud, c.req.query("relativePath") ?? "", c.req.raw.signal));
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

  app.post("/v1/skills/file", async (c) => {
    const parsed = await readRouteJson(c);
    if (!parsed.ok) return parsed.response;
    const fields = skillTextFieldsOf(parsed.body, ["name", "description", "body"]);
    if (!fields.ok) return c.json({ error: fields.message }, 400);
    try {
      const input = fields.value as unknown as SandboxSkillCreateBody;
      return c.json(await createCommonSkill(skillCrud, input, c.req.raw.signal), 201);
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  app.patch("/v1/skills/file", async (c) => {
    const parsed = await readRouteJson(c);
    if (!parsed.ok) return parsed.response;
    const fields = skillTextFieldsOf(parsed.body, ["relativePath", "fileVersion", "description", "body"]);
    if (!fields.ok) return c.json({ error: fields.message }, 400);
    try {
      const input = fields.value as unknown as SandboxSkillSaveBody;
      return c.json(await saveCommonSkill(skillCrud, input, c.req.raw.signal));
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  app.get("/v1/skills/file/delete-preview", async (c) => {
    try {
      return c.json(await previewCommonSkillDelete(skillCrud, c.req.query("relativePath") ?? "", c.req.raw.signal));
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

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
      return routeError(c, error, 400);
    }
  });

  app.delete("/v1/files", async (c) => {
    try {
      await withCommonGate(skillCrud, [{ path: c.req.query("path") ?? "", mode: "any" }], () =>
        removeWorkspaceFile(rootCwd, c.req.query("path") ?? ""),
      );
      return c.body(null, 204);
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

  app.get("/v1/files/raw", (c) => serveRawFile(c, rootCwd, maxUploadBytes));

  app.get("/v1/files/image-input", async (c) => {
    const requested = c.req.query("path") ?? "";
    if (requested === "") return c.json({ error: "path is required" }, 400);
    try {
      const bytes = await readScopedImageInput(
        rootCwd,
        requested,
        c.req.queries("scope") ?? [],
        c.req.raw.signal,
        resolveOpenedImageInputPath,
      );
      return new Response(bytes, {
        status: 200,
        headers: {
          // 形式は BFF が実バイトから判定するため、ここでは中継用の固定値だけを付ける
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

  app.get("/v1/files/download/plan", async (c) => {
    const exclude = parseArchiveExcludeQuery(c.req.queries("exclude"));
    if (!exclude.ok) return c.json({ error: exclude.message }, 400);
    const maxFileBytes = parseMaxFileBytesQuery(c.req.queries("maxFileBytes"));
    if (!maxFileBytes.ok) return c.json({ error: maxFileBytes.message }, 400);
    try {
      const plan = await planDownload({
        rootCwd,
        requested: c.req.query("path") ?? "",
        // param なしは「BFF 未指定」なので既定に倒す（直叩きでも安全側）
        excludeNames: exclude.names ?? DEFAULT_ARCHIVE_EXCLUDE_NAMES,
        limits: archiveLimits,
        planLimits,
        ...(maxFileBytes.value === undefined ? {} : { maxFileBytes: maxFileBytes.value }),
      });
      return c.json(downloadPlanFor(plan, maxFileBytes.value));
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

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
      return routeError(c, error, 400);
    }
  });

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
      return downloadResponseFor(plan);
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  app.get("/v1/files/handoff", async (c) => {
    try {
      return c.json({ text: await readHandoffFile(rootCwd, c.req.query("path") ?? "") });
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

  app.post("/v1/files/handoff", async (c) => {
    const parsed = await readRouteJson(c);
    if (!parsed.ok) return parsed.response;
    const { path, section, dedupeKey } = (parsed.body ?? {}) as {
      path?: unknown;
      section?: unknown;
      dedupeKey?: unknown;
    };
    if (typeof path !== "string" || typeof section !== "string" || typeof dedupeKey !== "string") {
      return c.json({ error: "path, section and dedupeKey must be strings" }, 400);
    }
    if (Buffer.byteLength(section, "utf8") > SANDBOX_MAX_HANDOFF_BYTES) {
      return c.json({ error: "The handoff memo is too large" }, 400);
    }
    try {
      return c.json(
        await withCommonGate(skillCrud, [{ path, mode: "inside" }], () =>
          writeHandoffText(rootCwd, path, section, dedupeKey, handoffWrites),
        ),
      );
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  app.post("/v1/files/handoff/rollback", async (c) => {
    const parsed = await readRouteJson(c);
    if (!parsed.ok) return parsed.response;
    const { path, expected } = (parsed.body ?? {}) as { path?: unknown; expected?: unknown };
    if (typeof path !== "string" || typeof expected !== "string") {
      return c.json({ error: "path and expected must be strings" }, 400);
    }
    try {
      return c.json(
        await withCommonGate(skillCrud, [{ path, mode: "inside" }], () =>
          rollbackHandoffText(rootCwd, path, expected, handoffWrites),
        ),
      );
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  // BFF は bodyGuard (上限付きのテキスト読取) を通さず、ここへ raw で流す。
  app.post("/v1/files/upload", async (c) => {
    const name = c.req.query("name") ?? "";
    if (!isValidEntryName(name)) return c.json({ error: `Invalid file name: ${name}` }, 400);
    try {
      const uploaded = await withCommonGate(skillCrud, [{ path: c.req.query("dir") ?? "", mode: "inside" }], () =>
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
      return routeError(c, error, 500);
    }
  });

  app.post("/v1/files/move", async (c) => {
    const parsed = await readRouteJson(c);
    if (!parsed.ok) return parsed.response;
    const { from, to } = (parsed.body ?? {}) as SandboxMoveRequestBody;
    if (typeof from !== "string") return c.json({ error: "from must be a string" }, 400);
    if (typeof to !== "string") return c.json({ error: "to must be a string" }, 400);
    try {
      return c.json(
        await withCommonGate(
          skillCrud,
          [
            { path: from, mode: "any" },
            { path: to, mode: "any" },
          ],
          () => moveWorkspaceEntry(rootCwd, from, to),
        ),
      );
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  app.post("/v1/files/rename", async (c) => {
    const parsed = await readRouteJson(c);
    if (!parsed.ok) return parsed.response;
    const { path, name } = (parsed.body ?? {}) as SandboxRenameRequestBody;
    if (typeof path !== "string") return c.json({ error: "path must be a string" }, 400);
    if (typeof name !== "string") return c.json({ error: "name must be a string" }, 400);
    // 名前の検証は保存名と同じ規則。同名の扱い (409) はパスの解決後に行う
    if (!isValidEntryName(name)) return c.json({ error: `Invalid name: ${name}` }, 400);
    try {
      return c.json(
        await withCommonGate(skillCrud, [{ path, mode: "any" }], () => renameWorkspaceEntry(rootCwd, path, name)),
      );
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  app.post("/v1/dirs", async (c) => {
    const parsed = await readRouteJson(c);
    if (!parsed.ok) return parsed.response;
    const { path } = (parsed.body ?? {}) as SandboxCreateDirRequestBody;
    if (typeof path !== "string") {
      return c.json({ error: "path must be a string" }, 400);
    }
    try {
      return c.json({
        path: await withCommonGate(skillCrud, [{ path, mode: "inside" }], () =>
          createWorkspaceDirectory(rootCwd, path),
        ),
      });
    } catch (error) {
      return routeError(c, error, 500);
    }
  });

  app.delete("/v1/dirs", async (c) => {
    const recursive = parseRecursiveQuery(c.req.queries("recursive"));
    if (!recursive.ok) return c.json({ error: RECURSIVE_QUERY_ERROR }, 400);
    try {
      await withCommonGate(skillCrud, [{ path: c.req.query("path") ?? "", mode: "any" }], () =>
        removeWorkspaceDirectory(rootCwd, c.req.query("path") ?? "", recursive.recursive),
      );
      return c.body(null, 204);
    } catch (error) {
      return routeError(c, error, 400);
    }
  });

  app.post("/v1/executions/:id/cancel", (c) => {
    const id = c.req.param("id") ?? "";
    const abort = tools.executions.get(id);
    if (!abort) {
      return c.json({ error: "Execution not found" }, 404);
    }
    abort.abort();
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return { app, executions: tools.executions, close: tools.close };
}
