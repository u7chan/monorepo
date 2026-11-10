/**
 * バックアップの書き出し / 復元 / 全削除。外側の ZIP と差分はこのサービスが持ち、スキルの中身は
 * サンドボックスの既存の export / import へそのまま流す (docs/backup.md)。
 * 変更は DB が 1 トランザクション、スキルが別なので、スキルだけが失敗したときは partial を返す。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppDb, PromptRow, StoredAgent } from "../app-db";
import { COMMON_SKILLS_DIR } from "../app-paths";
import { BUILTIN_AGENT_PROMPT_IDS, BUILTIN_PROMPTS } from "../builtin-catalog";
import { httpError, messageFor } from "../http";
import {
  BACKUP_AGENTS_FILE_ENTRY,
  BACKUP_APP,
  BACKUP_MANIFEST_ENTRY,
  BACKUP_PROMPTS_FILE_ENTRY,
  BACKUP_SCHEMA_VERSION,
  BACKUP_SKILLS_ENTRY,
  type BackupBlocker,
  type BackupDiffCounts,
  type BackupExportCheck,
  type BackupExportTarget,
  type BackupFailure,
  type BackupManifest,
  type BackupResetResult,
  type BackupRestorePlan,
  type BackupRestoreResult,
  type BackupTarget,
} from "../schema";
import type { SandboxSkillArchiveClient, SandboxSkillFileClient } from "../sandbox/client";
import type { SandboxSkillsImportApply, SandboxSkillsImportPlan, SandboxSkillsResponse } from "../sandbox/protocol";
import { SANDBOX_MAX_UPLOAD_BYTES } from "../sandbox/protocol";
import { createZipStream, type ZipEntry } from "../sandbox/zip";
import { readBackup, type ParsedBackup } from "./format";
import {
  normalizeBackupAgent,
  planAgents,
  planPrompts,
  planSkills,
  type AgentsPlan,
  type BackupModelResolver,
  type NormalizedAgent,
  type PromptsPlan,
  type SkillsPlan,
} from "./plan";

const ALL_TARGETS: readonly BackupTarget[] = ["prompts", "agents", "skills"];

/** 空の ZIP (EOCD だけの 22 バイト)。`.agents/skills` が無いときも `skills.zip` を入れる */
const EMPTY_ZIP = Buffer.from(`504b0506${"0".repeat(36)}`, "hex");

/** 操作の排他の衝突。route が 409 の `busy` へ写す */
export function backupBusyError(): Error {
  return Object.assign(httpError(409, "Another backup operation is running"), { code: "busy" as const });
}

/** plan のブロッカーが残ったままの apply。何も変更していない */
export function backupBlockedError(plan: BackupRestorePlan): Error {
  return Object.assign(httpError(409, "The backup cannot be restored as selected"), {
    code: "blocked" as const,
    plan,
  });
}

function statusOf(error: unknown): number | undefined {
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" ? value : undefined;
}

/** 共通スキルの一覧。`.agents/skills` が無い (404) は 0 件として扱う */
async function listCommonSkills(
  workspace: { listSkills(dir: string): Promise<SandboxSkillsResponse> } | null,
): Promise<{ names: string[]; error: unknown }> {
  if (!workspace) return { names: [], error: new Error("Sandbox is not configured") };
  try {
    const response = await workspace.listSkills(COMMON_SKILLS_DIR);
    return { names: response.skills.map((skill) => skill.name), error: null };
  } catch (error) {
    if (statusOf(error) === 404) return { names: [], error: null };
    return { names: [], error };
  }
}

function readableOf(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
}

/** 応答を送り終えた / 中断したときに一時ディレクトリを消す */
function withCleanup(source: ReadableStream<Uint8Array>, cleanup: () => Promise<void>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    void cleanup().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function backupFileName(now: Date): string {
  return `u7agent-backup-${now.toISOString().slice(0, 10)}.zip`;
}

export interface BackupServiceDeps {
  db: AppDb;
  /** 共通スキルの一覧 (workspace の狭い IF のうち listSkills だけ) */
  workspace: { listSkills(dir: string): Promise<SandboxSkillsResponse> } | null;
  skillSandbox: SandboxSkillFileClient | null;
  skillArchive: SandboxSkillArchiveClient | null;
  /** セッション作成と同じ実効モデルの判定 */
  models: BackupModelResolver;
  /** 許可リストの警告に使う既知の名前。一覧が取れないときは undefined */
  knownSkills?: () => { common?: readonly string[]; builtin?: readonly string[] } | undefined;
  knownTools?: () => readonly string[] | undefined;
  now?: () => Date;
  tempRoot?: string;
}

export interface BackupService {
  exportCheck(targets: readonly string[] | undefined): Promise<BackupExportCheck>;
  exportZip(targets: readonly string[] | undefined): Promise<{ body: ReadableStream<Uint8Array>; fileName: string }>;
  restore(input: {
    path: string;
    dir: string;
    targets: readonly string[] | undefined;
    dryRun: boolean;
  }): Promise<BackupRestorePlan | BackupRestoreResult>;
  reset(): Promise<BackupResetResult>;
}

interface SkillDraft {
  plan: SkillsPlan;
  importPlan: SandboxSkillsImportPlan | null;
}

interface RestorePlanDraft {
  plan: BackupRestorePlan;
  prompts: PromptsPlan | null;
  agents: AgentsPlan | null;
  skills: SkillDraft | null;
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  let busy = false;
  const now = () => deps.now?.() ?? new Date();
  const tempRoot = deps.tempRoot ?? tmpdir();

  /** プロセス内で 1 本の排他。進行中の操作があれば 409 の busy にする */
  const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy) throw backupBusyError();
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };

  const customPrompts = (): PromptRow[] => deps.db.listPrompts().filter((row) => row.kind === "custom");

  /** 適用後の DB に存在するプロンプト ID。agents の参照はこの集合で正規化する */
  const promptUniverse = (parsed: ParsedBackup): Set<string> => {
    const ids = new Set<string>(BUILTIN_PROMPTS.map((entry) => entry.id));
    for (const id of BUILTIN_AGENT_PROMPT_IDS) ids.add(id);
    if (parsed.selected.includes("prompts")) {
      for (const entry of parsed.prompts) ids.add(entry.id);
    } else {
      for (const row of customPrompts()) ids.add(row.id);
    }
    return ids;
  };

  const dryRunSkills = async (
    skillsZip: string,
  ): Promise<{ importPlan: SandboxSkillsImportPlan | null; blocker: BackupBlocker | null }> => {
    if (!deps.skillArchive) {
      return {
        importPlan: null,
        blocker: { code: "skill_unavailable", message: "Sandbox is not configured for skills", names: [] },
      };
    }
    try {
      const result = await deps.skillArchive.importSkills({
        body: readableOf(skillsZip),
        dryRun: ["true"],
        replace: [],
      });
      if (!("skills" in result)) {
        return {
          importPlan: null,
          blocker: { code: "skill_unreadable", message: "The skills archive could not be inspected", names: [] },
        };
      }
      return { importPlan: result, blocker: null };
    } catch (error) {
      return {
        importPlan: null,
        blocker: {
          code: statusOf(error) === 413 ? "skill_too_large" : "skill_unreadable",
          message: messageFor(error),
          names: [],
        },
      };
    }
  };

  const buildPlan = async (parsed: ParsedBackup): Promise<RestorePlanDraft> => {
    const agentsSelected = parsed.selected.includes("agents");
    const promptsSelected = parsed.selected.includes("prompts");
    const skillsSelected = parsed.selected.includes("skills");

    const currentAgents = deps.db.listAgents();
    const universe = promptUniverse(parsed);
    // 一覧はスキルを置き換えるときの削除対象と、エージェントの許可リストの警告の両方で使う。
    // 置き換えるときに取れないと「バックアップに無い既存スキル」を決められないため、
    // 何も変更せずブロックする (一覧が取れないまま全置換を成功にしない)
    const currentSkills =
      skillsSelected || agentsSelected ? await listCommonSkills(deps.workspace) : { names: [], error: null };
    const skillRun = skillsSelected && parsed.skillsZip ? await dryRunSkills(parsed.skillsZip) : null;
    const listingBlocker: BackupBlocker | null =
      !skillsSelected || currentSkills.error === null
        ? null
        : { code: "skill_unreadable", message: messageFor(currentSkills.error), names: [] };
    const skills: SkillDraft | null = skillRun
      ? {
          importPlan: skillRun.importPlan,
          plan: planSkills({
            current: currentSkills.names,
            importPlan: skillRun.importPlan,
            blocker: skillRun.blocker ?? listingBlocker,
          }),
        }
      : null;

    const known = deps.knownSkills?.();
    // 名前の警告は「適用後の一覧」が分かるときだけ出す。スキルを置き換えるなら取り込む分、
    // 置き換えないなら現在の一覧で、どちらも取得できていないときは警告しない (誤警告を作らない)
    const commonAfter: ReadonlySet<string> | undefined = skills
      ? new Set((skills.importPlan?.skills ?? []).map((entry) => entry.name))
      : currentSkills.error === null
        ? new Set(currentSkills.names)
        : undefined;
    const tools = deps.knownTools?.();

    const normalized: NormalizedAgent[] = parsed.agents.map((entry) =>
      normalizeBackupAgent(entry, {
        promptUniverse: universe,
        model: deps.models,
        knownCommonSkills: commonAfter,
        knownBuiltinSkills: known?.builtin ? new Set(known.builtin) : undefined,
        knownTools: tools ? new Set(tools) : undefined,
      }),
    );

    // 適用後に残るエージェント。agents を置き換えるならバックアップ側、残すなら現在の行
    const survivingAgents = agentsSelected
      ? normalized.map((entry) => ({ name: entry.agent.name, promptIds: entry.agent.promptIds ?? [] }))
      : currentAgents.map((agent) => ({ name: agent.name, promptIds: agent.promptIds ?? [] }));

    const prompts = promptsSelected
      ? planPrompts({ current: customPrompts(), backup: parsed.prompts, survivingAgents })
      : null;
    const agents = agentsSelected ? planAgents({ current: currentAgents, normalized }) : null;

    const plans = [prompts?.plan, agents?.plan, skills?.plan.plan].filter(
      (plan): plan is NonNullable<typeof plan> => plan !== undefined,
    );
    const blocked = plans.some((plan) => plan.blocker !== null);
    const changed =
      !blocked &&
      plans.some((plan) => plan.counts.added + plan.counts.updated + plan.counts.removed + plan.counts.reordered > 0);
    const kept = ALL_TARGETS.filter((target) => !parsed.selected.includes(target));

    return {
      plan: { manifest: parsed.manifest, selected: parsed.selected, plans, changed, blocked, kept },
      prompts,
      agents,
      skills,
    };
  };

  const describeExport = async (selected: readonly BackupTarget[]): Promise<BackupExportCheck> => {
    const entries: BackupExportTarget[] = [];
    let bytes = 0;
    if (selected.includes("prompts")) {
      const prompts = customPrompts().map((row) => ({ id: row.id, label: row.label, prompt: row.prompt }));
      const size = jsonBytes({ prompts }).length;
      entries.push({ target: "prompts", count: prompts.length, bytes: size });
      bytes += size;
    }
    if (selected.includes("agents")) {
      const agents = deps.db.listAgents().map((agent) => backupAgentOf(agent));
      const size = jsonBytes({ agents }).length;
      entries.push({ target: "agents", count: agents.length, bytes: size });
      bytes += size;
    }
    if (selected.includes("skills")) {
      if (!deps.skillArchive) {
        entries.push({ target: "skills", count: 0, bytes: 0, available: false, reason: "Sandbox is not configured" });
      } else {
        try {
          const check = await deps.skillArchive.checkSkillsExport();
          // `entries` は ZIP のエントリ数 (SKILL.md と付随ファイル) なので、画面の件数には
          // 発見済みフォルダ数を使う。一覧が取れないときだけエントリ数で代用する
          const listed = await listCommonSkills(deps.workspace);
          entries.push({
            target: "skills",
            count: listed.error === null ? listed.names.length : check.entries,
            bytes: check.bytes,
            available: true,
          });
          bytes += check.bytes;
        } catch (error) {
          // `.agents/skills` が無い (404) は 0 件として扱い、空の skills.zip を書き出す
          const empty = statusOf(error) === 404;
          entries.push({
            target: "skills",
            count: 0,
            bytes: 0,
            available: empty,
            ...(empty ? {} : { reason: messageFor(error) }),
          });
        }
      }
    }
    return { targets: [...selected], entries, bytes: bytes + 1024, fileName: backupFileName(now()) };
  };

  /** preview で取った版が変わっていた場合だけ 1 回だけ取り直す */
  const deleteSkill = async (name: string): Promise<void> => {
    const sandbox = deps.skillSandbox;
    if (!sandbox) throw new Error("Sandbox is not configured for skills");
    // サンドボックスの削除 API はスキルのファイル (.agents/skills/<name>/SKILL.md) を受ける
    // (フォルダを渡すと 400 になり、全削除も復元も失敗する)
    const relativePath = `${COMMON_SKILLS_DIR}/${name}/SKILL.md`;
    for (let attempt = 0; ; attempt += 1) {
      const preview = await sandbox.previewSkillDelete(relativePath);
      try {
        await sandbox.deleteSkillFolder(relativePath, preview.treeVersion);
        return;
      } catch (error) {
        if (statusOf(error) !== 409 || attempt >= 1) throw error;
      }
    }
  };

  const applySkills = async (skillsZip: string, draft: SkillDraft): Promise<BackupFailure[]> => {
    const failed: BackupFailure[] = [];
    const archive = deps.skillArchive;
    if (!archive) return [{ target: "skills", message: "Sandbox is not configured" }];
    try {
      const result = await archive.importSkills({
        body: readableOf(skillsZip),
        dryRun: [],
        replace: draft.plan.replaceNames,
      });
      if (!("applied" in result)) {
        return [{ target: "skills", message: "The skills archive could not be applied" }];
      }
      const applied = result as SandboxSkillsImportApply;
      // 計画で取り込むと決めたスキルが applied にも skipped にも無い / 置換できずに skipped に
      // 入った場合は、全置換として未完了なので partial にする (内容が同一の skipped は成功扱い)
      const imported = new Set(applied.applied.map((item) => item.name));
      const skipped = new Set(applied.skipped.map((item) => item.name));
      for (const item of applied.skipped) {
        if (!draft.plan.importNames.includes(item.name)) continue;
        failed.push({ target: "skills", message: `${item.name}: ${item.reason}` });
      }
      for (const name of draft.plan.importNames) {
        if (imported.has(name) || skipped.has(name)) continue;
        failed.push({ target: "skills", message: `${name}: not applied` });
      }
      // 取り込みに失敗したら削除まで進めない (置換できていないスキルを消して被害を広げない)。
      // 再実行すれば残りの適用と削除が続く
      if (failed.length > 0) return failed;
      // 適用に失敗したものは残す。既存スキルを全滅させないよう、削除は適用の後だけ行う
      for (const name of draft.plan.deleteNames) {
        if (imported.has(name)) continue;
        try {
          await deleteSkill(name);
        } catch (error) {
          failed.push({ target: "skills", message: `${name}: ${messageFor(error)}` });
        }
      }
      return failed;
    } catch (error) {
      return [{ target: "skills", message: messageFor(error) }];
    }
  };

  /** スキルの export を内側の ZIP として一時ファイルへ落とす。404 は空の ZIP にする */
  const spoolSkills = async (path: string): Promise<void> => {
    const archive = deps.skillArchive;
    if (!archive) throw httpError(503, "Sandbox is not configured");
    let file;
    try {
      file = await archive.exportSkills();
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      await writeFile(path, EMPTY_ZIP, { mode: 0o600 });
      return;
    }
    if (!file.body) throw httpError(502, "Sandbox returned no archive body");
    if (file.contentLength !== undefined && file.contentLength > SANDBOX_MAX_UPLOAD_BYTES) {
      throw httpError(413, `Skills archive is too large (max ${SANDBOX_MAX_UPLOAD_BYTES} bytes)`);
    }
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > SANDBOX_MAX_UPLOAD_BYTES) {
          callback(httpError(413, `Skills archive is too large (max ${SANDBOX_MAX_UPLOAD_BYTES} bytes)`));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(file.body as Parameters<typeof Readable.fromWeb>[0]),
      limit,
      createWriteStream(path, { mode: 0o600 }),
    );
  };

  return {
    async exportCheck(targets) {
      const selected = targets === undefined ? [...ALL_TARGETS] : normalizeTargets(targets);
      return exclusive(() => describeExport(selected));
    },

    async exportZip(targets) {
      const selected = targets === undefined ? [...ALL_TARGETS] : normalizeTargets(targets);
      return exclusive(async () => {
        const dir = await mkdtemp(join(tempRoot, "u7agent-backup-"));
        await chmod(dir, 0o700);
        try {
          const entries: ZipEntry[] = [];
          const manifest: BackupManifest = {
            app: BACKUP_APP,
            schema: BACKUP_SCHEMA_VERSION,
            exportedAt: now().toISOString(),
            targets: [...selected],
          };
          entries.push({ name: BACKUP_MANIFEST_ENTRY, data: jsonBytes(manifest) });
          if (selected.includes("prompts")) {
            const prompts = customPrompts().map((row) => ({ id: row.id, label: row.label, prompt: row.prompt }));
            entries.push({ name: BACKUP_PROMPTS_FILE_ENTRY, data: jsonBytes({ prompts }) });
          }
          if (selected.includes("agents")) {
            entries.push({
              name: BACKUP_AGENTS_FILE_ENTRY,
              data: jsonBytes({ agents: deps.db.listAgents().map((agent) => backupAgentOf(agent)) }),
            });
          }
          if (selected.includes("skills")) {
            const skillsZip = join(dir, BACKUP_SKILLS_ENTRY);
            await spoolSkills(skillsZip);
            entries.push({ name: BACKUP_SKILLS_ENTRY, source: skillsZip });
          }
          const body = withCleanup(createZipStream(entries), () => rm(dir, { recursive: true, force: true }));
          return { body, fileName: backupFileName(now()) };
        } catch (error) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      });
    },

    async restore(input) {
      return exclusive(async () => {
        const parsed = await readBackup(input.path, { dir: input.dir, targets: input.targets });
        const draft = await buildPlan(parsed);
        if (input.dryRun) return draft.plan;
        if (draft.plan.blocked) throw backupBlockedError(draft.plan);

        const applied: BackupRestoreResult["applied"] = [];
        const failed: BackupFailure[] = [];

        const promptsPlan = draft.prompts;
        const agentsPlan = draft.agents;
        const changedOf = (plan: { counts: BackupDiffCounts } | null) =>
          plan !== null && plan.counts.added + plan.counts.updated + plan.counts.removed + plan.counts.reordered > 0;
        const promptsChanged = changedOf(promptsPlan?.plan ?? null);
        const agentsChanged = changedOf(agentsPlan?.plan ?? null);

        // DB を先に確定させる。ここで失敗した場合は 503 (not_stored) になり、スキルには触れない
        if (promptsChanged || agentsChanged) {
          deps.db.applyDefinitions({
            deleteAgentIds: agentsChanged ? (agentsPlan?.deleteIds ?? []) : [],
            promptUpserts: promptsChanged ? (promptsPlan?.upserts ?? []) : [],
            agentUpserts: agentsChanged ? (agentsPlan?.upserts ?? []) : [],
            deletePromptIds: promptsChanged ? (promptsPlan?.deleteIds ?? []) : [],
            agentOrder: agentsChanged ? (agentsPlan?.order ?? []) : [],
            promptOrder: promptsChanged ? (promptsPlan?.order ?? []) : [],
          });
        }
        if (promptsChanged && promptsPlan) applied.push({ target: "prompts", counts: promptsPlan.plan.counts });
        if (agentsChanged && agentsPlan) applied.push({ target: "agents", counts: agentsPlan.plan.counts });

        if (draft.skills && parsed.skillsZip) {
          const failures = await applySkills(parsed.skillsZip, draft.skills);
          if (failures.length === 0) applied.push({ target: "skills", counts: draft.skills.plan.plan.counts });
          failed.push(...failures);
        }

        return { complete: failed.length === 0, plan: draft.plan, applied, failed };
      });
    },

    async reset() {
      return exclusive(async () => {
        const removed = deps.db.deleteAllDefinitions();
        const failed: BackupFailure[] = [];
        let skills = 0;
        const current = await listCommonSkills(deps.workspace);
        if (current.error) failed.push({ target: "skills", message: messageFor(current.error) });
        for (const name of current.names) {
          try {
            await deleteSkill(name);
            skills += 1;
          } catch (error) {
            failed.push({ target: "skills", message: `${name}: ${messageFor(error)}` });
          }
        }
        return { complete: failed.length === 0, agents: removed.agents, prompts: removed.prompts, skills, failed };
      });
    },
  };

  function backupAgentOf(agent: StoredAgent) {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      ...(agent.icon ? { icon: agent.icon } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
      ...(agent.commonSkillNames ? { commonSkillNames: [...agent.commonSkillNames] } : {}),
      ...(agent.builtinSkillNames ? { builtinSkillNames: [...agent.builtinSkillNames] } : {}),
      ...(agent.allowNaturalInvocationBuiltin === false ? { allowNaturalInvocationBuiltin: false } : {}),
      ...(agent.allowNaturalInvocationFile === false ? { allowNaturalInvocationFile: false } : {}),
      ...(agent.toolNames ? { toolNames: [...agent.toolNames] } : {}),
      ...(agent.promptIds ? { promptIds: [...agent.promptIds] } : {}),
    };
  }
}

function normalizeTargets(targets: readonly string[]): BackupTarget[] {
  const result: BackupTarget[] = [];
  for (const value of targets) {
    if (!ALL_TARGETS.includes(value as BackupTarget)) throw httpError(400, `Unknown backup target: ${value}`);
    if (!result.includes(value as BackupTarget)) result.push(value as BackupTarget);
  }
  if (result.length === 0) throw httpError(400, "Backup target must not be empty");
  return result;
}
