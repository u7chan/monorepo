import type { Context } from "hono";
import type { AgentCatalog } from "../agents";
import type { CreateAgentBody, CreateSkillBody, ReplaceCatalogBody, UpdateAgentBody, UpdateSkillBody } from "../schema";

export function createCatalogRoutes({ catalog }: { catalog: AgentCatalog }) {
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
