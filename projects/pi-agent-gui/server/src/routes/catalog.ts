import type { Context } from "hono";
import type { AgentCatalog } from "../agents";
import type { CreateAgentBody, CreateSkillBody, ReplaceCatalogBody, UpdateAgentBody, UpdateSkillBody } from "../schema";

export function createCatalogRoutes({ catalog }: { catalog: AgentCatalog }) {
  // body は route で形・型を検証済み。キー省略の解釈と正規化は catalog が正
  const updateAgent = (c: Context, body: UpdateAgentBody) => {
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
      if (!catalog.removeAgent(c.req.param("id") ?? "")) {
        return c.json({ error: "Agent cannot be deleted (or it is the last agent)" }, 400);
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
