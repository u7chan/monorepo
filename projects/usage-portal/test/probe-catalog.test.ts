// /api/probe/models が返す catalog の形（provider 別・Google 除外・重複なし・秘密なし）を固定する。
import { describe, expect, test } from "bun:test";
import {
  findProbeModel,
  listProbeModels,
  readProbeCatalog,
  supportsProbeThinking,
  validateProbeConfig,
} from "../src/server/probe/catalog";

describe("readProbeCatalog", () => {
  test("codex と opencodeGo を別々に返し、どちらも空でない", () => {
    const catalog = readProbeCatalog();

    expect(catalog.codex.length).toBeGreaterThan(0);
    expect(catalog.opencodeGo.length).toBeGreaterThan(0);
  });

  test("id は provider 内で一意で、name・thinkingLevels・cost を持つ", () => {
    const catalog = readProbeCatalog();

    for (const models of [catalog.codex, catalog.opencodeGo]) {
      expect(new Set(models.map((model) => model.id)).size).toBe(models.length);

      for (const model of models) {
        expect(model.id).not.toBe("");
        expect(model.name).not.toBe("");
        expect(model.thinkingLevels.length).toBeGreaterThan(0);

        for (const level of model.thinkingLevels) {
          expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(level);
        }

        for (const rate of [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite]) {
          expect(typeof rate).toBe("number");
          expect(Number.isFinite(rate)).toBe(true);
        }
      }
    }
  });

  test("Google の adapter しか使わないモデルは含めない", () => {
    const catalog = readProbeCatalog();
    const googleOnly = [...listProbeModels("codex"), ...listProbeModels("opencodeGo")].filter(
      (model) => model.id === "gemini-3-pro",
    );

    // Gemini 系の id が catalog から消えている（provider 側の一覧に Google の api だけが残る）。
    expect(googleOnly).toEqual([]);
    expect(catalog.opencodeGo.some((model) => model.id === "deepseek-v4.1-flash")).toBe(true);
  });

  test("off を許すモデルと許さないモデルが両方ある", () => {
    const catalog = readProbeCatalog();
    const all = [...catalog.codex, ...catalog.opencodeGo];

    expect(all.some((model) => model.thinkingLevels.includes("off"))).toBe(true);
    expect(all.some((model) => !model.thinkingLevels.includes("off"))).toBe(true);
  });
});

describe("findProbeModel / supportsProbeThinking", () => {
  test("catalog にある id だけを返し、未知の id は null にする", () => {
    expect(findProbeModel("codex", "gpt-6-luna")).not.toBeNull();
    expect(findProbeModel("codex", "no-such-model")).toBeNull();
    // provider をまたいだ id は引かない。
    expect(findProbeModel("codex", "deepseek-v4.1-flash")).toBeNull();
  });

  test("モデルが対応しない思考レベルは false になる", () => {
    const model = findProbeModel("opencodeGo", "deepseek-v4.1-flash");

    expect(model).not.toBeNull();
    expect(supportsProbeThinking(model!, "low")).toBe(true);
    expect(supportsProbeThinking(model!, "off")).toBe(false);
    expect(supportsProbeThinking(model!, "unknown")).toBe(false);
  });

  test("設定 API の検証は invalid_model と invalid_thinking を返す", () => {
    expect(validateProbeConfig("codex", "no-such-model", "low")).toBe("invalid_model");
    // gpt-6-astra は off を持たない。
    expect(validateProbeConfig("codex", "gpt-6-astra", "off")).toBe("invalid_thinking");
    expect(validateProbeConfig("codex", "gpt-6-astra", "low")).toBeNull();
    expect(validateProbeConfig("codex", "gpt-6-astra", "unknown")).toBe("invalid_thinking");
  });
});
