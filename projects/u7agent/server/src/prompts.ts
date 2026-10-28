/**
 * 定型プロンプトのマスタのカタログ。保存はアプリデータの SQLite (app-db.ts) で、
 * エージェントからの参照は `promptIds` の順序付き配列として持つ (docs/api-catalog.md)。
 * マスタはアプリ共通で、エージェントやスペースに所有させない。
 */
import { randomUUID } from "node:crypto";
import type { AppDb, PromptRow } from "./app-db";
import { BUILTIN_AGENT_ID, BUILTIN_AGENT_NAME, BUILTIN_AGENT_PROMPT_IDS } from "./builtin-catalog";
import { httpError } from "./http";
import { AGENT_PROMPT_LIMIT, PROMPT_LABEL_MAX, PROMPT_TEXT_MAX } from "./schema";
import type { PromptDef, PromptRef, PromptUsage } from "./schema";

/** 使用中の削除拒否 (409)。画面が使用先をそのまま出せるよう、エラーに使用先を添える */
export interface PromptUsageConflict extends Error {
  usedBy: PromptUsage[];
}

export interface PromptCatalog {
  /** 一覧 (組み込みが先、その中は作成順)。各件に使用先を付ける */
  list(): PromptDef[];
  get(id: string): PromptDef | undefined;
  /** 作成。kind と ID はサーバーが決める (入力からは指定できない) */
  create(input: unknown): PromptDef;
  /** 更新。組み込み・未知は拒否する */
  update(id: string, input: unknown): PromptDef;
  /** 削除。組み込みは 400、使用中は 409、未知は 404 */
  remove(id: string): void;
  /** 全マスタを参照形で返す (エージェントの選択肢。使用先は含めない) */
  refs(): PromptRef[];
  /** エージェントが参照する ID 列を解決する (未知は 400) */
  resolve(ids: readonly string[]): PromptRef[];
  /**
   * エージェントの書き込みで受ける `promptIds` の正規化。未知・重複・上限超過は 400 で断り、
   * 呼び出し側が保存を始める前に確定させる (部分保存を残さない)。
   */
  normalizeIds(value: unknown): string[];
}

/** マスタの内容の上限は旧 `suggestions` を引き継ぐ。全文が入るので切らずに 400 で断る */
function contentOf(value: unknown, fallback: { label: string; prompt: string }): { label: string; prompt: string } {
  const record = value as { label?: unknown; prompt?: unknown } | null;
  const read = (raw: unknown, previous: string, max: number, name: string): string => {
    if (raw === undefined || raw === null) return previous;
    if (typeof raw !== "string") throw httpError(400, `Prompt ${name} must be a string`);
    const text = raw.trim();
    if (!text) throw httpError(400, `Prompt ${name} is required`);
    if (text.length > max) throw httpError(400, `Prompt ${name} must be at most ${max} characters`);
    return text;
  };
  return {
    label: read(record?.label, fallback.label, PROMPT_LABEL_MAX, "label"),
    prompt: read(record?.prompt, fallback.prompt, PROMPT_TEXT_MAX, "prompt"),
  };
}

/** 種別と ID はサーバーが管理する。入力での組み込みへの昇格・置換は黙って無視せず 400 にする */
function rejectManagedKeys(input: unknown): void {
  const record = input as Record<string, unknown> | null;
  if (record && Object.hasOwn(record, "id")) throw httpError(400, "Prompt id is assigned by the server");
  if (record && Object.hasOwn(record, "kind")) throw httpError(400, "Prompt kind is managed by the server");
}

function inUseError(usedBy: PromptUsage[]): PromptUsageConflict {
  const names = usedBy.map((usage) => usage.agentName).join("、");
  const error = httpError(409, `この定型プロンプトは使用中です（${names}）。先にすべての紐づけを解除してください。`);
  return Object.assign(error, { usedBy });
}

export function createPromptCatalog({ db }: { db: AppDb }): PromptCatalog {
  /** 使用先。組み込みの汎用アシスタントの固定参照も含め、DB の紐づけと区別する */
  const usageOf = (promptId: string, links: { agentId: string; promptId: string }[], names: Map<string, string>) => {
    const usedBy: PromptUsage[] = [];
    if (BUILTIN_AGENT_PROMPT_IDS.includes(promptId)) {
      usedBy.push({ agentId: BUILTIN_AGENT_ID, agentName: BUILTIN_AGENT_NAME, builtin: true });
    }
    for (const link of links) {
      if (link.promptId !== promptId) continue;
      usedBy.push({ agentId: link.agentId, agentName: names.get(link.agentId) ?? "", builtin: false });
    }
    return usedBy;
  };

  const definitionOf = (row: PromptRow, usedBy: PromptUsage[]): PromptDef => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    prompt: row.prompt,
    usedBy,
  });

  const list = (): PromptDef[] => {
    const links = db.listAgentPromptLinks();
    const names = new Map(db.listAgents().map((agent) => [agent.id, agent.name]));
    return db.listPrompts().map((row) => definitionOf(row, usageOf(row.id, links, names)));
  };

  const get = (id: string): PromptDef | undefined => {
    const row = db.getPrompt(id);
    if (!row) return undefined;
    const links = db.listAgentPromptLinks();
    const names = new Map(db.listAgents().map((agent) => [agent.id, agent.name]));
    return definitionOf(row, usageOf(row.id, links, names));
  };

  return {
    list,
    get,

    create(input) {
      rejectManagedKeys(input);
      const content = contentOf(input, { label: "", prompt: "" });
      const row: PromptRow = { id: `prompt-${randomUUID()}`, kind: "custom", ...content };
      db.insertPrompt(row);
      return definitionOf(row, []);
    },

    update(id, input) {
      rejectManagedKeys(input);
      const current = db.getPrompt(id);
      if (!current) throw httpError(404, "Prompt not found");
      if (current.kind === "builtin") throw httpError(400, "Built-in prompt cannot be updated");
      const content = contentOf(input, { label: current.label, prompt: current.prompt });
      // 行が消えていた場合は対象なしとして扱う (組み込みは条件側でも更新しない)
      if (!db.updatePrompt({ ...current, ...content })) throw httpError(404, "Prompt not found");
      return get(id) ?? definitionOf({ ...current, ...content }, []);
    },

    remove(id) {
      const current = get(id);
      if (!current) throw httpError(404, "Prompt not found");
      if (current.kind === "builtin") throw httpError(400, "Built-in prompt cannot be deleted");
      if (current.usedBy.length > 0) throw inUseError(current.usedBy);
      try {
        if (!db.deletePrompt(id)) throw httpError(404, "Prompt not found");
      } catch (error) {
        // API の事前判定をすり抜けた使用中 (同時実行など) は DB の ON DELETE RESTRICT が止める。
        // DB 障害 (503) に化けさせず、業務上の拒否として使用先を返す
        const usedBy = get(id)?.usedBy ?? [];
        if (usedBy.length > 0) throw inUseError(usedBy);
        throw error;
      }
    },

    refs() {
      return db.listPrompts().map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        prompt: row.prompt,
      }));
    },

    resolve(ids) {
      return ids.map((id) => {
        const row = db.getPrompt(id);
        if (!row) throw httpError(400, `Unknown prompt id: ${id}`);
        return { id: row.id, kind: row.kind, label: row.label, prompt: row.prompt };
      });
    },

    normalizeIds(value) {
      if (!Array.isArray(value)) throw httpError(400, "promptIds must be an array of prompt ids");
      if (value.length > AGENT_PROMPT_LIMIT) {
        throw httpError(400, `An agent can reference at most ${AGENT_PROMPT_LIMIT} prompts`);
      }
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const item of value) {
        if (typeof item !== "string") throw httpError(400, "promptIds must be an array of prompt ids");
        const id = item.trim();
        if (!id) throw httpError(400, "promptIds must not contain an empty id");
        if (seen.has(id)) throw httpError(400, `Duplicate prompt id: ${id}`);
        if (!db.getPrompt(id)) throw httpError(400, `Unknown prompt id: ${id}`);
        seen.add(id);
        ids.push(id);
      }
      return ids;
    },
  };
}
