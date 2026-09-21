import type { Context } from "hono";
import type { AgentCatalog } from "../agents";
import { COMMON_SKILLS_DIR, composeFileSkills } from "../file-skills";
import { sandboxFailure, sandboxNotConfigured } from "../http";
import type { SandboxWorkspaceClient } from "../sandbox/client";
import {
  SandboxSkillsSchema,
  type CreateAgentBody,
  type CreateSkillBody,
  type ReplaceCatalogBody,
  type UpdateAgentBody,
  type UpdateSkillBody,
} from "../schema";

export function createCatalogRoutes({
  catalog,
  workspace,
  rootCwd,
}: {
  catalog: AgentCatalog;
  /** ファイルスキル (GET /api/skills/files) の取得元。未設定なら 503 */
  workspace: SandboxWorkspaceClient | null;
  /** 表示用の root 相対パスを組むためのワークスペース root */
  rootCwd: string;
}) {
  // ビルトインは置換対象のマップに無いので、ルートで明示的に区別して 400 を返す
  const isBuiltin = (c: Context) => (c.req.param("id") ?? "") === catalog.builtinAgent().id;

  // body は route で形・型を検証済み。キー省略の解釈と正規化は catalog が正
  const updateAgent = (c: Context, body: UpdateAgentBody) => {
    if (isBuiltin(c)) return c.json({ error: "Built-in agent cannot be updated" }, 400);
    const agent = catalog.updateAgent(c.req.param("id") ?? "", body);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({ agent });
  };

  const updateSkill = (c: Context, body: UpdateSkillBody) => {
    const skill = catalog.updateSkill(c.req.param("id") ?? "", body);
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    return c.json({ skill });
  };

  return {
    snapshot: (c: Context) => c.json(catalog.snapshot()),

    replace: (c: Context, body: ReplaceCatalogBody) => c.json(catalog.replace(body)),

    createAgent: (c: Context, body: CreateAgentBody) => c.json({ agent: catalog.createAgent(body) }, 201),

    updateAgent,

    removeAgent: (c: Context) => {
      if (isBuiltin(c)) return c.json({ error: "Built-in agent cannot be deleted" }, 400);
      if (!catalog.removeAgent(c.req.param("id") ?? "")) {
        return c.json({ error: "Agent not found" }, 404);
      }
      return c.json({ ok: true });
    },

    listSkills: (c: Context) => c.json({ skills: catalog.listSkills() }),

    /**
     * ファイルスキル (共通 `<root>/.agents/skills`) の読み取り専用一覧。同名は優先順位で一意化済みで、
     * 影になった側は shadowed に入る。編集・削除・エージェント割り当ての対象ではない。
     */
    listFileSkills: async (c: Context) => {
      if (!workspace) return sandboxNotConfigured(c);
      try {
        const parsed = SandboxSkillsSchema.safeParse(await workspace.listSkills(COMMON_SKILLS_DIR));
        if (!parsed.success) return c.json({ error: "サンドボックスのスキル一覧が不正です" }, 502);
        return c.json(composeFileSkills([{ scope: "user", entries: parsed.data.skills }], rootCwd).response);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },

    createSkill: (c: Context, body: CreateSkillBody) => c.json({ skill: catalog.createSkill(body) }, 201),

    updateSkill,

    removeSkill: (c: Context) => {
      if (!catalog.removeSkill(c.req.param("id") ?? "")) {
        return c.json({ error: "Skill not found" }, 404);
      }
      return c.json({ ok: true });
    },
  };
}
