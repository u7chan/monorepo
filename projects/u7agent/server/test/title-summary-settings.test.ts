// 設定 → 会話タイトル (GET / PUT /api/settings/session-title) を検証する。
//   - 行が無い = 既定 (Off・モデル未選択・既定の定義)
//   - On 保存には利用可能なモデルが要り、未選択・不明なモデルは 400
//   - 空白だけ・上限超過の定義は 400、定義は既定文へ戻せる
//   - Off に戻してもモデルと定義を保持し、再起動後も同じ値が読める
//   - 本会話のモデル設定とは独立している (モデルはタイトル専用の保存値)

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { TITLE_DEFINITION_DEFAULT, TITLE_DEFINITION_MAX } from "../src/session-title";
import { asPiBff, createStubPi, STUB_MODEL, STUB_PLAIN_MODEL } from "./stub-pi";

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-title-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function openBff(dir: string, options: { pi?: ReturnType<typeof createStubPi> | null } = {}) {
  return createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: dir,
    pi: options.pi === undefined ? asPiBff(createStubPi()) : options.pi === null ? null : asPiBff(options.pi),
  });
}

test("既定は Off・モデル未選択で、選択できるモデルを返す", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    try {
      const settings = await jsonBody(bff.app.request("/api/settings/session-title"));
      assert.equal(settings.enabled, false);
      assert.equal(settings.model, null);
      assert.equal(settings.definition, TITLE_DEFINITION_DEFAULT);
      assert.equal(settings.defaultDefinition, TITLE_DEFINITION_DEFAULT);
      assert.equal(settings.modelAvailable, false);
      assert.equal(settings.thinkingLevel, null);
      assert.equal(settings.effectiveThinkingLevel, null);
      assert.deepEqual(
        settings.models.map((model: { provider: string; id: string }) => `${model.provider}/${model.id}`),
        [`${STUB_MODEL.provider}/${STUB_MODEL.id}`, `${STUB_PLAIN_MODEL.provider}/${STUB_PLAIN_MODEL.id}`],
      );
      assert.deepEqual(settings.models[0].thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
      assert.deepEqual(settings.models[1].thinkingLevels, ["off"]);
    } finally {
      await bff.close();
    }
  });
});

test("モデル未選択のまま On にはできず、利用可能なモデルを指定したときだけ保存できる", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    try {
      const missing = await bff.app.request("/api/settings/session-title", jsonPut({ enabled: true }));
      assert.equal(missing.status, 400);
      assert.match((await jsonBody(missing)).error, /モデルを選択/);

      const unknown = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: false, model: "ghost/unknown" }),
      );
      assert.equal(unknown.status, 400);

      const label = `${STUB_MODEL.provider}/${STUB_MODEL.id}`;
      const saved = await bff.app.request("/api/settings/session-title", jsonPut({ enabled: true, model: label }));
      assert.equal(saved.status, 200);
      const body = await jsonBody(saved);
      assert.equal(body.enabled, true);
      assert.equal(body.model, label);
      assert.equal(body.modelAvailable, true);

      const listed = await jsonBody(bff.app.request("/api/settings/session-title"));
      assert.equal(listed.enabled, true);
      assert.equal(listed.model, label);
    } finally {
      await bff.close();
    }
  });
});

test("空白だけ・上限超過の定義は拒否し、既定文へ戻せる", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    try {
      for (const definition of ["", "   ", "\n\t"]) {
        const res = await bff.app.request("/api/settings/session-title", jsonPut({ enabled: false, definition }));
        assert.equal(res.status, 400, `definition=${JSON.stringify(definition)} が 400 でない`);
      }
      const tooLong = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: false, definition: "あ".repeat(TITLE_DEFINITION_MAX + 1) }),
      );
      assert.equal(tooLong.status, 400);

      const custom = "英語で20文字程度のタイトルにしてください。";
      const saved = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: false, definition: custom }),
      );
      assert.equal(saved.status, 200);
      assert.equal((await jsonBody(saved)).definition, custom);

      const reset = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: false, definition: TITLE_DEFINITION_DEFAULT }),
      );
      assert.equal((await jsonBody(reset)).definition, TITLE_DEFINITION_DEFAULT);
    } finally {
      await bff.close();
    }
  });
});

test("Off に戻してもモデルと定義を保持し、再起動後も同じ値が読める", async () => {
  await withStoreDir(async (dir) => {
    const label = `${STUB_MODEL.provider}/${STUB_MODEL.id}`;
    const definition = "日本語で短く。";
    const first = await openBff(dir);
    try {
      const saved = await first.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: true, model: label, thinkingLevel: "high", definition }),
      );
      assert.equal(saved.status, 200);
      const off = await first.app.request("/api/settings/session-title", jsonPut({ enabled: false }));
      assert.equal(off.status, 200);
      const body = await jsonBody(off);
      assert.equal(body.enabled, false);
      assert.equal(body.model, label);
      assert.equal(body.thinkingLevel, "high");
      assert.equal(body.effectiveThinkingLevel, "high");
      assert.equal(body.definition, definition);
    } finally {
      await first.close();
    }

    const restarted = await openBff(dir);
    try {
      const settings = await jsonBody(restarted.app.request("/api/settings/session-title"));
      assert.equal(settings.enabled, false);
      assert.equal(settings.model, label);
      assert.equal(settings.definition, definition);
      assert.equal(settings.modelAvailable, true);
      assert.equal(settings.thinkingLevel, "high");
      assert.equal(settings.effectiveThinkingLevel, "high");
    } finally {
      await restarted.close();
    }
  });
});

test("Effort はモデルが対応する段階だけ保存でき、未指定なら最小段階を実効値にする", async () => {
  await withStoreDir(async (dir) => {
    const label = `${STUB_MODEL.provider}/${STUB_MODEL.id}`;
    const plain = `${STUB_PLAIN_MODEL.provider}/${STUB_PLAIN_MODEL.id}`;
    const bff = await openBff(dir);
    try {
      const noModel = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: false, thinkingLevel: "high" }),
      );
      assert.equal(noModel.status, 400);
      assert.match((await jsonBody(noModel)).error, /要約モデル/);

      const saved = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: true, model: label, thinkingLevel: "high" }),
      );
      assert.equal(saved.status, 200);
      const body = await jsonBody(saved);
      assert.equal(body.thinkingLevel, "high");
      assert.equal(body.effectiveThinkingLevel, "high");

      // 対応しない段階は保存しない
      const unsupported = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: false, model: plain, thinkingLevel: "high" }),
      );
      assert.equal(unsupported.status, 400);
      assert.match((await jsonBody(unsupported)).error, /Effort/);

      // モデルを変えて Effort を省略したら、新モデルが対応しない保存値は未指定へ戻す
      const switched = await bff.app.request("/api/settings/session-title", jsonPut({ enabled: false, model: plain }));
      assert.equal(switched.status, 200);
      const switchedBody = await jsonBody(switched);
      assert.equal(switchedBody.model, plain);
      assert.equal(switchedBody.thinkingLevel, null);
      assert.equal(switchedBody.effectiveThinkingLevel, "off");

      // 明示的に戻せばモデルの最小段階が実効値になる
      const reset = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: false, model: label, thinkingLevel: null }),
      );
      assert.equal(reset.status, 200);
      const resetBody = await jsonBody(reset);
      assert.equal(resetBody.thinkingLevel, null);
      assert.equal(resetBody.effectiveThinkingLevel, "off");
    } finally {
      await bff.close();
    }
  });
});

test("保存済みモデルが候補から消えたら modelAvailable=false で警告し、保存値は書き換えない", async () => {
  await withStoreDir(async (dir) => {
    const label = `${STUB_MODEL.provider}/${STUB_MODEL.id}`;
    const first = await openBff(dir);
    try {
      await first.app.request("/api/settings/session-title", jsonPut({ enabled: true, model: label }));
    } finally {
      await first.close();
    }

    // 認証が外れて候補が減った状態 (無断で別モデルへ切り替えない)
    const narrowed = await openBff(dir, {
      pi: createStubPi({ availableModels: [STUB_PLAIN_MODEL], selectedModel: STUB_PLAIN_MODEL }),
    });
    try {
      const settings = await jsonBody(narrowed.app.request("/api/settings/session-title"));
      assert.equal(settings.model, label);
      assert.equal(settings.modelAvailable, false);
    } finally {
      await narrowed.close();
    }
  });
});
