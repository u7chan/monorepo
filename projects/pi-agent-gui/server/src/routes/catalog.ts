import type { Context } from "hono";
import type { AgentCatalog } from "../agents";
import { readJsonBody } from "../http";
import type { ReplaceCatalogBody } from "../schema";

export function createCatalogRoutes({ catalog }: { catalog: AgentCatalog }) {
  const updateAgent = async (c: Context) => {
    const agentId = c.req.param("id") ?? "";
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    const agent = catalog.updateAgent(agentId, body);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({ agent });
  };

  const updateSkill = async (c: Context) => {
    const skillId = c.req.param("id") ?? "";
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    const skill = catalog.updateSkill(skillId, body);
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    return c.json({ skill });
  };

  return {
    snapshot: (c: Context) => c.json(catalog.snapshot()),

    replace: (c: Context, body: ReplaceCatalogBody) => c.json(catalog.replace(body)),

    createAgent: async (c: Context) => {
      // 正規化とエラー文言は catalog 側が正なので body はそのまま渡す
      const body = (await readJsonBody(c)) as Record<string, unknown>;
      return c.json({ agent: catalog.createAgent(body) }, 201);
    },

    updateAgent,

    removeAgent: (c: Context) => {
      if (!catalog.removeAgent(c.req.param("id") ?? "")) {
        return c.json({ error: "Agent cannot be deleted (or it is the last agent)" }, 400);
      }
      return c.json({ ok: true });
    },

    listSkills: (c: Context) => c.json({ skills: catalog.listSkills() }),

    createSkill: async (c: Context) => {
      const body = (await readJsonBody(c)) as Record<string, unknown>;
      return c.json({ skill: catalog.createSkill(body) }, 201);
    },

    updateSkill,

    removeSkill: (c: Context) => {
      if (!catalog.removeSkill(c.req.param("id") ?? "")) {
        return c.json({ error: "Skill not found" }, 404);
      }
      return c.json({ ok: true });
    },
  };
}
