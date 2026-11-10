/**
 * バックアップの差分計算と正規化 (純粋関数)。plan と apply が同じ関数を通ることで、
 * モデルのフォールバックや `promptIds` の除去を「毎回の更新」に見せない (docs/backup.md)。
 * 日本語の文言は `client/src/lib/backup.ts` が持ち、ここはコードと値だけを返す。
 */
import { importedAgent } from "../agents";
import type { PromptRow, StoredAgent } from "../app-db";
import { importedPromptContent } from "../prompts";
import type {
  BackupAgent,
  BackupBlocker,
  BackupDiffCounts,
  BackupDiffItem,
  BackupDiffStatus,
  BackupPrompt,
  BackupTargetPlan,
  BackupWarning,
  ModelRef,
} from "../schema";
import type { SandboxSkillImportPlanEntry, SandboxSkillsImportPlan } from "../sandbox/protocol";

/** プレビューに並べる行の上限。超過分は件数だけを counts で示す */
export const BACKUP_PLAN_ITEMS_MAX = 50;

function emptyCounts(): BackupDiffCounts {
  return { added: 0, updated: 0, identical: 0, removed: 0, reordered: 0 };
}

function truncateItems(items: BackupDiffItem[]): { items: BackupDiffItem[]; truncated: boolean } {
  if (items.length <= BACKUP_PLAN_ITEMS_MAX) return { items, truncated: false };
  return { items: items.slice(0, BACKUP_PLAN_ITEMS_MAX), truncated: true };
}

function dedupeWarnings(warnings: readonly BackupWarning[]): BackupWarning[] {
  const seen = new Set<string>();
  const result: BackupWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}\u0000${warning.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result;
}

/** 実効モデルの判定。`unknown` は判断材料が無い (API キー未設定 / カタログ未取得) を表す */
export type BackupModelVerdict = "available" | "not_in_catalog" | "not_allowed" | "unknown";
export type BackupModelResolver = (model: ModelRef) => BackupModelVerdict;

export interface AgentNormalizeContext {
  /** 適用後の DB に存在するプロンプト ID (組み込み + 残す / 挿入する自作) */
  promptUniverse: ReadonlySet<string>;
  model: BackupModelResolver;
  /** 一覧が取れていない場合は undefined (見つからない警告を出さない) */
  knownCommonSkills?: ReadonlySet<string>;
  knownBuiltinSkills?: ReadonlySet<string>;
  knownTools?: ReadonlySet<string>;
}

export interface NormalizedAgent {
  agent: StoredAgent;
  warnings: BackupWarning[];
}

function modelName(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

/**
 * バックアップ 1 件を保存形へ正規化する。モデルはカタログ / 許可リストで落とせるときだけ落とし、
 * 材料が無ければ保持したまま警告する。`promptIds` は適用後の DB に無い参照だけを外す。
 */
export function normalizeBackupAgent(entry: BackupAgent, context: AgentNormalizeContext): NormalizedAgent {
  const warnings: BackupWarning[] = [];
  const promptIds: string[] = [];
  for (const id of entry.promptIds ?? []) {
    if (!context.promptUniverse.has(id)) {
      warnings.push({ code: "prompt_reference_removed", name: id });
      continue;
    }
    if (!promptIds.includes(id)) promptIds.push(id);
  }

  let model = entry.model;
  if (model) {
    const verdict = context.model(model);
    if (verdict === "unknown") {
      // 判断できないものを落とすと、あとから API キーを設定しても元のモデルへ戻せない
      warnings.push({ code: "model_unknown", name: modelName(model) });
      warnings.push({ code: "model_settings_missing" });
    } else if (verdict !== "available") {
      warnings.push({
        code: verdict === "not_allowed" ? "model_not_allowed" : "model_unavailable",
        name: modelName(model),
      });
      model = undefined;
    }
  }

  const missing = (names: readonly string[] | undefined, known: ReadonlySet<string> | undefined, code: string) => {
    if (!known) return;
    for (const name of new Set(names ?? [])) {
      if (!known.has(name)) warnings.push({ code, name });
    }
  };
  missing(entry.commonSkillNames, context.knownCommonSkills, "common_skill_not_found");
  missing(entry.builtinSkillNames, context.knownBuiltinSkills, "builtin_skill_not_found");
  missing(entry.toolNames, context.knownTools, "tool_not_found");

  // 長さの検証はここで済ませる (`importedAgent` が makeAgent の検証をそのまま使う)
  const agent = importedAgent({ ...entry, model }, promptIds, entry.id);
  return { agent, warnings };
}

/** 内容の同一判定に使う正規化キー。並び (`order`) はここに含めず、別に比べる */
export function agentKey(agent: StoredAgent): string {
  return JSON.stringify([
    agent.name,
    agent.description,
    agent.systemPrompt,
    agent.icon ?? null,
    agent.model ? [agent.model.provider, agent.model.id] : null,
    agent.thinkingLevel ?? null,
    agent.commonSkillNames ?? null,
    agent.builtinSkillNames ?? null,
    agent.allowNaturalInvocationBuiltin === false,
    agent.allowNaturalInvocationFile === false,
    agent.toolNames ?? null,
    agent.promptIds ?? [],
  ]);
}

function promptKey(row: { label: string; prompt: string }): string {
  return JSON.stringify([row.label, row.prompt]);
}

/**
 * 並び替えだけが変わった行を求める。両方に居る ID を現在順 / バックアップ順で並べ、
 * 位置が変わった ID を返す (追加・削除だけで位置がずれる分は数えない)。
 */
function reorderedIds(currentIds: readonly string[], backupIds: readonly string[]): Set<string> {
  const inBackup = new Set(backupIds);
  const inCurrent = new Set(currentIds);
  const before = currentIds.filter((id) => inBackup.has(id));
  const after = backupIds.filter((id) => inCurrent.has(id));
  const result = new Set<string>();
  after.forEach((id, index) => {
    if (before[index] !== id) result.add(id);
  });
  return result;
}

export interface PromptsPlan {
  plan: BackupTargetPlan;
  upserts: PromptRow[];
  deleteIds: string[];
  /** 適用後の自作プロンプトの並び */
  order: string[];
}

/** 自作プロンプトの差分。適用後に残るエージェントが参照する行は削除できないので blocker にする */
export function planPrompts(input: {
  current: readonly PromptRow[];
  backup: readonly BackupPrompt[];
  survivingAgents: readonly { name: string; promptIds?: readonly string[] }[];
}): PromptsPlan {
  const backupRows: PromptRow[] = input.backup.map((entry) => ({
    id: entry.id,
    kind: "custom",
    ...importedPromptContent(entry),
  }));
  const currentById = new Map(input.current.map((row) => [row.id, row]));
  const backupById = new Map(backupRows.map((row) => [row.id, row]));
  const moved = reorderedIds(
    input.current.map((row) => row.id),
    backupRows.map((row) => row.id),
  );
  const counts = emptyCounts();
  const items: BackupDiffItem[] = [];
  const upserts: PromptRow[] = [];
  const deleteIds: string[] = [];

  for (const row of backupRows) {
    const existing = currentById.get(row.id);
    if (!existing) {
      counts.added += 1;
      items.push({ id: row.id, name: row.label, status: "added" });
      upserts.push(row);
      continue;
    }
    if (promptKey(existing) !== promptKey(row)) {
      counts.updated += 1;
      items.push({ id: row.id, name: row.label, status: "updated" });
      upserts.push(row);
      continue;
    }
    if (moved.has(row.id)) {
      counts.reordered += 1;
      items.push({ id: row.id, name: row.label, status: "reordered" });
      continue;
    }
    counts.identical += 1;
    items.push({ id: row.id, name: row.label, status: "identical" });
  }
  for (const row of input.current) {
    if (backupById.has(row.id)) continue;
    counts.removed += 1;
    items.push({ id: row.id, name: row.label, status: "removed" });
    deleteIds.push(row.id);
  }

  const removedSet = new Set(deleteIds);
  const inUse: string[] = [];
  for (const agent of input.survivingAgents) {
    for (const id of agent.promptIds ?? []) {
      if (!removedSet.has(id)) continue;
      const label = currentById.get(id)?.label ?? id;
      if (!inUse.includes(label)) inUse.push(label);
    }
  }
  const blocker: BackupBlocker | null =
    inUse.length > 0
      ? {
          code: "prompt_in_use",
          message: "A prompt that is still referenced by an agent cannot be deleted",
          names: inUse,
        }
      : null;

  const { items: shown, truncated } = truncateItems(items);
  return {
    plan: {
      target: "prompts",
      counts,
      items: shown,
      truncated,
      total: backupRows.length,
      warnings: [],
      blocker,
    },
    upserts,
    deleteIds,
    order: backupRows.map((row) => row.id),
  };
}

export interface AgentsPlan {
  plan: BackupTargetPlan;
  upserts: StoredAgent[];
  deleteIds: string[];
  order: string[];
}

/** ユーザー定義エージェントの差分。正規化後の実効値で比べる (再復元で更新に見せない) */
export function planAgents(input: {
  current: readonly StoredAgent[];
  normalized: readonly NormalizedAgent[];
}): AgentsPlan {
  const currentById = new Map(input.current.map((row) => [row.id, row]));
  const backupById = new Map(input.normalized.map((row) => [row.agent.id, row.agent]));
  const moved = reorderedIds(
    input.current.map((row) => row.id),
    input.normalized.map((row) => row.agent.id),
  );
  const counts = emptyCounts();
  const items: BackupDiffItem[] = [];
  const upserts: StoredAgent[] = [];
  const deleteIds: string[] = [];

  for (const { agent } of input.normalized) {
    const existing = currentById.get(agent.id);
    if (!existing) {
      counts.added += 1;
      items.push({ id: agent.id, name: agent.name, status: "added" });
      upserts.push(agent);
      continue;
    }
    if (agentKey(existing) !== agentKey(agent)) {
      counts.updated += 1;
      items.push({ id: agent.id, name: agent.name, status: "updated" });
      upserts.push(agent);
      continue;
    }
    if (moved.has(agent.id)) {
      counts.reordered += 1;
      items.push({ id: agent.id, name: agent.name, status: "reordered" });
      continue;
    }
    counts.identical += 1;
    items.push({ id: agent.id, name: agent.name, status: "identical" });
  }
  for (const agent of input.current) {
    if (backupById.has(agent.id)) continue;
    counts.removed += 1;
    items.push({ id: agent.id, name: agent.name, status: "removed" });
    deleteIds.push(agent.id);
  }

  const { items: shown, truncated } = truncateItems(items);
  return {
    plan: {
      target: "agents",
      counts,
      items: shown,
      truncated,
      total: input.normalized.length,
      warnings: dedupeWarnings(input.normalized.flatMap((entry) => entry.warnings)),
      blocker: null,
    },
    upserts,
    deleteIds,
    order: input.normalized.map((entry) => entry.agent.id),
  };
}

export interface SkillsPlan {
  plan: BackupTargetPlan;
  /** 取り込む (同名置換を含む) スキル名 */
  importNames: string[];
  /** 同名で置き換えるスキル名 (取り込みの `replace`) */
  replaceNames: string[];
  /** バックアップに無いために削除するスキル名 */
  deleteNames: string[];
}

const SKILL_STATUS: Record<SandboxSkillImportPlanEntry["status"], BackupDiffStatus> = {
  new: "added",
  identical: "identical",
  conflict: "updated",
  invalid: "blocked",
};

/** 共通スキルの差分。取り込めない行が 1 件でもあれば、その対象をブロックする */
export function planSkills(input: {
  current: readonly string[];
  importPlan: SandboxSkillsImportPlan | null;
  blocker: BackupBlocker | null;
}): SkillsPlan {
  const counts = emptyCounts();
  const items: BackupDiffItem[] = [];
  const importNames: string[] = [];
  const replaceNames: string[] = [];
  const invalid: string[] = [];
  const backupNames = new Set<string>();

  for (const entry of input.importPlan?.skills ?? []) {
    backupNames.add(entry.name);
    const status = SKILL_STATUS[entry.status];
    if (status === "blocked") {
      invalid.push(entry.name);
    } else {
      if (status === "added") counts.added += 1;
      if (status === "updated") counts.updated += 1;
      if (status === "identical") counts.identical += 1;
      if (status !== "identical") importNames.push(entry.name);
      if (status === "updated") replaceNames.push(entry.name);
    }
    items.push({ id: entry.name, name: entry.name, status });
  }
  const deleteNames = input.current.filter((name) => !backupNames.has(name));
  for (const name of deleteNames) {
    counts.removed += 1;
    items.push({ id: name, name, status: "removed" });
  }

  const blocker =
    input.blocker ??
    (invalid.length > 0
      ? {
          code: "skill_invalid",
          message: "Some skills in the backup cannot be imported",
          names: invalid,
        }
      : null);
  const { items: shown, truncated } = truncateItems(items);
  return {
    plan: {
      target: "skills",
      counts,
      items: shown,
      truncated,
      total: (input.importPlan?.skills ?? []).length - invalid.length,
      warnings: [],
      blocker,
    },
    importNames,
    replaceNames,
    deleteNames,
  };
}
