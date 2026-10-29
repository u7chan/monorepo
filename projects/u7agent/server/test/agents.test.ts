import assert from "node:assert/strict";
import test from "node:test";
import { appendSystemPrompt, composePromptSnapshot, investigationSystemPrompt, investigationTools } from "../src/agent";
import { allowsNaturalInvocation, createAgentCatalog } from "../src/agents";
import { AppDb } from "../src/app-db";
import { BUILTIN_AGENT_PROMPT_IDS, BUILTIN_PROMPTS } from "../src/builtin-catalog";
import { createPromptCatalog } from "../src/prompts";
import { SKILL_NAME_MAX, SKILL_NAMES_MAX, TOOL_NAME_MAX, TOOL_NAMES_MAX } from "../src/schema";

/** カタログとマスタを同じメモリ DB に載せる (API と同じ共有のしかた) */
function testCatalog() {
  const db = AppDb.open({ storeDir: null });
  const prompts = createPromptCatalog({ db });
  return { db, prompts, catalog: createAgentCatalog({ db, prompts }) };
}

test("the built-in agent keeps model and thinkingLevel unspecified", () => {
  const catalog = createAgentCatalog();
  const agent = catalog.builtinAgent();
  assert.equal(Object.hasOwn(agent, "model"), false, "ビルトインはアプリ既定に従う");
  assert.equal(Object.hasOwn(agent, "thinkingLevel"), false);
});

test("ships the generic agent as the built-in and the zundamon sample as a user definition", () => {
  const catalog = createAgentCatalog();
  const agent = catalog.builtinAgent();
  assert.equal(agent.id, "agent-general");
  assert.equal(agent.name, "汎用アシスタント");
  // 既定のエージェント自身は役割もスキル割り当てを持たない (口調のサンプルはユーザー定義側に置く)
  assert.equal(agent.systemPrompt, "");
  assert.equal(agent.allowNaturalInvocation, false, "既定のエージェントは自然文で発火しない");
  assert.equal(Object.hasOwn(agent, "skillIds"), false);

  const samples = catalog.listAgents();
  assert.deepEqual(
    samples.map((sample) => sample.id),
    ["agent-zundamon"],
    "初期状態のユーザー定義はずんだもんだけ",
  );
  assert.equal(samples[0].name, "ずんだもん");
  assert.match(samples[0].systemPrompt, /なのだ/);
  // スキルの実体は DB ではなくファイル側にあるので、カタログ応答に定義は載らない
  assert.equal(Object.hasOwn(catalog.snapshot(), "skills"), false);
});

test("keeps the built-in agent out of the user-defined list", () => {
  const catalog = createAgentCatalog();

  // ビルトインは削除を受け付けず、常に残る (セッション作成の既定を担う)
  assert.equal(catalog.removeAgent("agent-general"), false);
  assert.equal(catalog.getAgent("agent-general")?.id, "agent-general");

  // ユーザー定義はサンプルも含めて 0 件まで減らせる (ビルトインが居るので非空の保証は不要)
  const created = catalog.createAgent({ name: "消せる定義" });
  assert.equal(catalog.removeAgent(created.id), true);
  assert.equal(catalog.removeAgent("agent-zundamon"), true);
  assert.deepEqual(catalog.listAgents(), []);
});

test("treats the zundamon sample as a normal user definition", () => {
  const catalog = createAgentCatalog();

  // 削除でき、新しい DB のカタログでは seed で戻る
  assert.equal(catalog.removeAgent("agent-zundamon"), true);
  assert.equal(catalog.getAgent("agent-zundamon"), undefined);
  assert.equal(createAgentCatalog().getAgent("agent-zundamon")?.name, "ずんだもん");
});

test("creates and updates agents with an independent model / thinkingLevel", () => {
  const catalog = createAgentCatalog();

  // 片方だけ / 両方
  const modelOnly = catalog.createAgent({
    name: "モデル指定",
    model: { provider: "openai", id: "gpt-5.5" },
  });
  assert.deepEqual(modelOnly.model, { provider: "openai", id: "gpt-5.5" });
  assert.equal(Object.hasOwn(modelOnly, "thinkingLevel"), false);

  const effortOnly = catalog.createAgent({ name: "Effort 指定", thinkingLevel: "high" });
  assert.equal(effortOnly.thinkingLevel, "high");
  assert.equal(Object.hasOwn(effortOnly, "model"), false);

  const both = catalog.createAgent({
    name: "両方指定",
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    thinkingLevel: "xhigh",
  });
  assert.deepEqual(both.model, { provider: "anthropic", id: "claude-sonnet-4-5" });
  assert.equal(both.thinkingLevel, "xhigh");

  // キー省略の更新は保持、null は指定解除、値は上書き
  const kept = catalog.updateAgent(both.id, { description: "説明だけ更新" });
  assert.deepEqual(kept?.model, { provider: "anthropic", id: "claude-sonnet-4-5" });
  assert.equal(kept?.thinkingLevel, "xhigh");

  const clearedModel = catalog.updateAgent(both.id, { model: null });
  assert.equal(Object.hasOwn(clearedModel ?? {}, "model"), false);
  assert.equal(clearedModel?.thinkingLevel, "xhigh");

  const replaced = catalog.updateAgent(both.id, {
    model: { provider: "openai", id: "gpt-5.5" },
    thinkingLevel: "minimal",
  });
  assert.deepEqual(replaced?.model, { provider: "openai", id: "gpt-5.5" });
  assert.equal(replaced?.thinkingLevel, "minimal");

  const clearedBoth = catalog.updateAgent(both.id, { model: null, thinkingLevel: null });
  assert.equal(Object.hasOwn(clearedBoth ?? {}, "model"), false);
  assert.equal(Object.hasOwn(clearedBoth ?? {}, "thinkingLevel"), false);

  // 作成時の null は未指定として扱う
  const nullCreated = catalog.createAgent({ name: "null 作成", model: null, thinkingLevel: null });
  assert.equal(Object.hasOwn(nullCreated, "model"), false);
  assert.equal(Object.hasOwn(nullCreated, "thinkingLevel"), false);
});

test("reorderAgents は既存の id だけを採用し、渡さなかった行を元の順で末尾に回す", () => {
  const catalog = createAgentCatalog();
  // seed のずんだもんを外し、並べ替えの対象を 3 件に絞る
  catalog.removeAgent("agent-zundamon");
  const a = catalog.createAgent({ name: "A" });
  const b = catalog.createAgent({ name: "B" });
  const c = catalog.createAgent({ name: "C" });
  const ids = () => catalog.listAgents().map((agent) => agent.id);
  assert.deepEqual(ids(), [a.id, b.id, c.id], "追加は末尾に付く");

  // 未知の id・重複・ビルトインは捨て、渡さなかった行は元の相対順で末尾に回る
  const reordered = catalog.reorderAgents([b.id, "agent-missing", b.id, "agent-general"]);
  assert.deepEqual(
    reordered.map((agent) => agent.id),
    [b.id, a.id, c.id],
  );
  assert.deepEqual(ids(), [b.id, a.id, c.id], "並びは保存され、一覧にも同じ順で出る");

  // [] と全件未知は現行順のまま
  assert.deepEqual(
    catalog.reorderAgents([]).map((agent) => agent.id),
    [b.id, a.id, c.id],
  );
  assert.deepEqual(
    catalog.reorderAgents(["agent-missing"]).map((agent) => agent.id),
    [b.id, a.id, c.id],
  );

  // 並べ替えたあとの追加は末尾 (MAX + 1)
  const d = catalog.createAgent({ name: "D" });
  assert.deepEqual(ids(), [b.id, a.id, c.id, d.id]);

  // 更新は位置を動かさない (名前や説明の保存で並びが変わらない)
  catalog.updateAgent(b.id, { name: "B 改", description: "説明" });
  assert.deepEqual(ids(), [b.id, a.id, c.id, d.id]);
});

test("reorderAgents はビルトインを含まないユーザー定義だけを並べ替える", () => {
  const catalog = createAgentCatalog();
  const agent = catalog.createAgent({ name: "1 件" });

  // ビルトインはユーザー定義の一覧に無いので、渡しても採用されない
  const reordered = catalog.reorderAgents(["agent-general", agent.id]);
  assert.deepEqual(
    reordered.map((entry) => entry.id),
    [agent.id, "agent-zundamon"],
  );
  assert.equal(catalog.builtinAgent().id, "agent-general");
});

test("rejects the removed skillIds on create and update", () => {
  const catalog = createAgentCatalog();

  // 撤去済みの割り当ては無視して成功させず、明示的に 400 にする (保存されたと誤認させない)
  for (const input of [
    { name: "参照あり", skillIds: ["skill-1"] },
    { name: "空でも拒否", skillIds: [] },
  ]) {
    assert.throws(
      () => catalog.createAgent(input),
      (error: Error & { statusCode?: number }) =>
        error.statusCode === 400 && error.message === "skillIds is no longer supported",
      JSON.stringify(input),
    );
  }

  const created = catalog.createAgent({ name: "既存" });
  assert.throws(
    () => catalog.updateAgent(created.id, { skillIds: ["skill-1"] }),
    (error: Error & { statusCode?: number }) =>
      error.statusCode === 400 && error.message === "skillIds is no longer supported",
  );
  assert.equal(Object.hasOwn(catalog.getAgent(created.id) ?? {}, "skillIds"), false);
});

test("the built-in agent resolves the fixed built-in prompt masters", () => {
  const { catalog } = testCatalog();
  const builtin = catalog.builtinAgent();
  assert.deepEqual(
    builtin.prompts?.map((prompt) => prompt.id),
    [...BUILTIN_AGENT_PROMPT_IDS],
    "組み込みの参照は固定 ID で、順序がそのまま表示順になる",
  );
  for (const prompt of builtin.prompts ?? []) {
    assert.equal(prompt.kind, "builtin");
    // 本文の正はマスタ側だけ (エージェント定義へ写さない)
    assert.equal(prompt.prompt, BUILTIN_PROMPTS.find((entry) => entry.id === prompt.id)?.prompt);
  }

  // 新しく作る自作エージェントへ組み込みを自動で足さない
  const created = catalog.createAgent({ name: "定型なし" });
  assert.equal(Object.hasOwn(created, "prompts"), false);
});

test("rejects the legacy suggestions write with 400 instead of dropping it", () => {
  const { catalog } = testCatalog();
  const suggestions = [{ label: "旧", prompt: "旧い書き込み" }];
  assert.throws(
    () => catalog.createAgent({ name: "旧形式", suggestions }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400 && /promptIds/.test(error.message),
  );
  const agent = catalog.createAgent({ name: "既存" });
  assert.throws(
    () => catalog.updateAgent(agent.id, { suggestions }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400 && /promptIds/.test(error.message),
  );
  // 断った書き込みは何も変えない
  assert.equal(Object.hasOwn(catalog.getAgent(agent.id) ?? {}, "prompts"), false);
});

test("stores ordered prompt references and keeps same-content masters distinct", () => {
  const { catalog, prompts } = testCatalog();
  const first = prompts.create({ label: "同じ", prompt: "同じ本文" });
  const second = prompts.create({ label: "同じ", prompt: "同じ本文" });
  const other = prompts.create({ label: "別", prompt: "別の本文" });

  const agent = catalog.createAgent({
    name: "参照あり",
    promptIds: [second.id, first.id, other.id],
  });
  assert.deepEqual(
    agent.prompts?.map((prompt) => prompt.id),
    [second.id, first.id, other.id],
    "同じ本文でも本文でまとめず、参照の順序を保つ",
  );

  // マスタの編集は、次の取得から共通で反映される (選択済みチップはクライアントの持ち物)
  prompts.update(second.id, { label: "編集後", prompt: "編集後の本文" });
  assert.deepEqual(
    catalog.getAgent(agent.id)?.prompts?.map((prompt) => prompt.label),
    ["編集後", "同じ", "別"],
  );
});

test("validates prompt ids and never partially saves an agent", () => {
  const { catalog, prompts } = testCatalog();
  const known = prompts.create({ label: "既知", prompt: "既知の本文" });
  assert.equal(catalog.createAgent({ name: "0 件", promptIds: [] }).prompts, undefined);

  const six = Array.from({ length: 6 }, (_, index) => prompts.create({ label: `L${index}`, prompt: `P${index}` }));
  const full = catalog.createAgent({ name: "6 件", promptIds: six.map((prompt) => prompt.id) });
  assert.equal(full.prompts?.length, 6);

  const agent = catalog.createAgent({ name: "検証", promptIds: [known.id] });
  const rejected: unknown[] = [
    [known.id, known.id],
    [known.id, "prompt-unknown"],
    [...six.map((prompt) => prompt.id), known.id],
    [""],
    "not-an-array",
    [42],
  ];
  for (const promptIds of rejected) {
    assert.throws(
      () => catalog.updateAgent(agent.id, { promptIds }),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
      `must reject ${JSON.stringify(promptIds)}`,
    );
    assert.deepEqual(
      catalog.getAgent(agent.id)?.prompts?.map((prompt) => prompt.id),
      [known.id],
      "拒否した更新は保存済みの参照を変えない",
    );
  }
});

test("updates and clears prompt references", () => {
  const { catalog, prompts } = testCatalog();
  const prompt = prompts.create({ label: "ラベル", prompt: "本文" });
  const agent = catalog.createAgent({ name: "参照あり", promptIds: [prompt.id] });

  // キー省略 / null は現状維持
  assert.deepEqual(
    catalog.updateAgent(agent.id, { description: "説明だけ更新" })?.prompts?.map((p) => p.id),
    [prompt.id],
  );
  assert.deepEqual(
    catalog.updateAgent(agent.id, { promptIds: null })?.prompts?.map((p) => p.id),
    [prompt.id],
  );

  // `[]` は全解除
  assert.equal(catalog.updateAgent(agent.id, { promptIds: [] })?.prompts, undefined);
  assert.equal(catalog.getAgent(agent.id)?.prompts, undefined);
});

test("deleting an agent keeps the master and other references", () => {
  const { catalog, prompts } = testCatalog();
  const prompt = prompts.create({ label: "共有", prompt: "共有の本文" });
  const keep = catalog.createAgent({ name: "残す", promptIds: [prompt.id] });
  const remove = catalog.createAgent({ name: "消す", promptIds: [prompt.id] });

  assert.equal(catalog.removeAgent(remove.id), true);
  assert.deepEqual(
    prompts.list().map((entry) => entry.id),
    [...BUILTIN_AGENT_PROMPT_IDS, prompt.id],
    "エージェントを消してもマスタは残る",
  );
  assert.deepEqual(prompts.get(prompt.id)?.usedBy, [{ agentId: keep.id, agentName: "残す", builtin: false }]);
  assert.deepEqual(
    catalog.getAgent(keep.id)?.prompts?.map((p) => p.id),
    [prompt.id],
  );
});

test("public agents copy the resolved prompts of the internal catalog", () => {
  const { catalog, prompts } = testCatalog();

  // ビルトイン (ユーザー定義の外) も応答のたびにコピーを返し、書き換えても内部に残らない
  const internalBuiltin = catalog.getAgent("agent-general")?.prompts;
  const exportedBuiltin = catalog.builtinAgent().prompts;
  assert.ok(internalBuiltin && exportedBuiltin);
  assert.notEqual(exportedBuiltin, internalBuiltin);
  assert.notEqual(exportedBuiltin[0], internalBuiltin[0]);
  exportedBuiltin[0].label = "書き換え";
  exportedBuiltin.push({ id: "extra", kind: "custom", label: "追加", prompt: "追加のプロンプト" });
  assert.deepEqual(
    catalog.getAgent("agent-general")?.prompts?.map((prompt) => prompt.label),
    BUILTIN_PROMPTS.map((prompt) => prompt.label),
  );

  const prompt = prompts.create({ label: "l", prompt: "p" });
  const agent = catalog.createAgent({ name: "参照あり", promptIds: [prompt.id] });
  const exported = catalog.listAgents().find((listed) => listed.id === agent.id)?.prompts;
  assert.ok(exported);
  assert.notEqual(exported, agent.prompts);
  assert.notEqual(exported[0], agent.prompts?.[0]);
  exported[0].label = "書き換え";
  assert.equal(catalog.getAgent(agent.id)?.prompts?.[0].label, "l");
});

test("rejects malformed model references and unknown thinking levels with 400", () => {
  const catalog = createAgentCatalog();
  const invalidInputs: unknown[] = [
    { name: "x", model: { provider: "openai" } },
    { name: "x", model: { provider: "", id: "gpt" } },
    { name: "x", model: "openai/gpt" },
    { name: "x", model: { provider: 42, id: "gpt" } },
    { name: "x", thinkingLevel: "ultra" },
    { name: "x", thinkingLevel: 3 },
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => catalog.createAgent(input),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
      `must reject ${JSON.stringify(input)}`,
    );
  }

  // 不正な更新も 400 (既存値は保持)
  const agent = catalog.createAgent({ name: "更新検証" });
  assert.throws(
    () => catalog.updateAgent(agent.id, { thinkingLevel: "ultra" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(catalog.getAgent(agent.id), agent);
});

/** PNG / webp の署名だけを持つ data URL。server は署名まで見るため、長さだけを変えて使う */
function iconBody(mime: "png" | "webp", bytes: number): Buffer {
  const body = Buffer.alloc(bytes, 0);
  if (mime === "png") Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  else {
    body.write("RIFF", 0, "latin1");
    body.write("WEBP", 8, "latin1");
  }
  return body;
}

const dataUrlOf = (mime: "png" | "webp", body: Buffer): string =>
  `data:image/${mime};base64,${body.toString("base64")}`;

const iconDataUrl = (mime: "png" | "webp", bytes: number): string => dataUrlOf(mime, iconBody(mime, bytes));

test("normalizes agent icons on create and update", () => {
  const catalog = createAgentCatalog();
  const png = iconDataUrl("png", 64);
  const webp = iconDataUrl("webp", 64);

  // webp / png はそのまま保持する (trim も slice もしない)
  const created = catalog.createAgent({ name: "アイコンあり", icon: webp });
  assert.equal(created.icon, webp);
  assert.equal(catalog.getAgent(created.id)?.icon, webp);

  // 未指定 / null はキーごと落ちる
  const plain = catalog.createAgent({ name: "アイコンなし" });
  assert.equal(Object.hasOwn(plain, "icon"), false);
  const nullCreated = catalog.createAgent({ name: "null 作成", icon: null });
  assert.equal(Object.hasOwn(nullCreated, "icon"), false);

  // キー省略の更新は保持、null は解除、値は上書き
  const kept = catalog.updateAgent(created.id, { description: "説明だけ更新" });
  assert.equal(kept?.icon, webp);
  const replaced = catalog.updateAgent(created.id, { icon: png });
  assert.equal(replaced?.icon, png);
  const cleared = catalog.updateAgent(created.id, { icon: null });
  assert.equal(Object.hasOwn(cleared ?? {}, "icon"), false);
  // 解除後にキー省略で更新しても戻らない
  const afterClear = catalog.updateAgent(created.id, { description: "解除後" });
  assert.equal(Object.hasOwn(afterClear ?? {}, "icon"), false);
});

test("rejects icons that are not webp / png data URLs or exceed 16 KiB", () => {
  const catalog = createAgentCatalog();
  const atLimit = iconDataUrl("png", 16 * 1024);
  // 上限ちょうどは通る (境界)
  assert.equal(catalog.createAgent({ name: "上限", icon: atLimit }).icon, atLimit);

  const invalidIcons: unknown[] = [
    "https://example.com/icon.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/jpeg;base64,/9j/4A==",
    "data:text/plain;base64,AAAA",
    "data:image/png;base64,",
    // 非正規の base64 (padding なし) はデコードしても壊れた画像になるため拒否する
    "data:image/png;base64,AAA",
    "data:image/png;base64,****",
    // base64 としては正しいが、中身が画像でないもの (prefix と署名の不一致も同じ扱い)
    "data:image/png;base64,AAAA",
    dataUrlOf("webp", iconBody("png", 64)),
    iconDataUrl("webp", 16 * 1024 + 1),
    42,
    { icon: atLimit },
  ];
  for (const icon of invalidIcons) {
    assert.throws(
      () => catalog.createAgent({ name: "不正", icon }),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
      `must reject ${String(icon).slice(0, 40)}`,
    );
  }

  // 不正な更新も 400 (既存値は保持)
  const agent = catalog.createAgent({ name: "更新検証", icon: atLimit });
  assert.throws(
    () => catalog.updateAgent(agent.id, { icon: iconDataUrl("png", 16 * 1024 + 1) }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  assert.equal(catalog.getAgent(agent.id)?.icon, atLimit);
});

test("normalizes the common skill allowlist without collapsing undefined and []", () => {
  const catalog = createAgentCatalog();

  // 未指定 / null はキーごと省略 (= 全可視)、`[]` は「すべて OFF」なので残す
  const plain = catalog.createAgent({ name: "未指定" });
  assert.equal(Object.hasOwn(plain, "commonSkillNames"), false);
  const nullCreated = catalog.createAgent({ name: "null 作成", commonSkillNames: null });
  assert.equal(Object.hasOwn(nullCreated, "commonSkillNames"), false);
  const off = catalog.createAgent({ name: "全 OFF", commonSkillNames: [] });
  assert.deepEqual(off.commonSkillNames, []);

  // trim / 空除去 / 重複排除。空になった配列も `[]` = すべて OFF として残す
  const normalized = catalog.createAgent({
    name: "正規化",
    commonSkillNames: [" writer ", "", "  ", "writer", "gh"],
  });
  assert.deepEqual(normalized.commonSkillNames, ["writer", "gh"]);
  assert.deepEqual(catalog.getAgent(normalized.id)?.commonSkillNames, ["writer", "gh"]);
  assert.deepEqual(catalog.createAgent({ name: "空だけ", commonSkillNames: ["", " "] }).commonSkillNames, []);

  // キー省略の更新は保持、null は解除、`[]` はすべて OFF へ上書き
  const kept = catalog.updateAgent(normalized.id, { description: "説明だけ更新" });
  assert.deepEqual(kept?.commonSkillNames, ["writer", "gh"]);
  const cleared = catalog.updateAgent(normalized.id, { commonSkillNames: null });
  assert.equal(Object.hasOwn(cleared ?? {}, "commonSkillNames"), false);
  const replaced = catalog.updateAgent(normalized.id, { commonSkillNames: ["gh"] });
  assert.deepEqual(replaced?.commonSkillNames, ["gh"]);
  assert.deepEqual(catalog.updateAgent(normalized.id, { commonSkillNames: [] })?.commonSkillNames, []);
  assert.deepEqual(
    catalog.updateAgent(normalized.id, { description: "空のまま" })?.commonSkillNames,
    [],
    "解除 (キー省略) と 空配列を混同しない",
  );

  // 応答はコピーを返す (呼び出し側の書き換えが内部へ染みない)
  const exported = catalog.getAgent(normalized.id)?.commonSkillNames;
  assert.ok(exported);
  exported.push("追加");
  assert.deepEqual(catalog.listAgents().find((agent) => agent.id === normalized.id)?.commonSkillNames, []);
});

test("rejects malformed common skill lists with 400", () => {
  const catalog = createAgentCatalog();
  const atLimit = Array.from({ length: SKILL_NAMES_MAX }, (_, index) => `skill-${index}`);
  assert.equal(
    catalog.createAgent({ name: "配列の上限ちょうど", commonSkillNames: atLimit }).commonSkillNames?.length,
    SKILL_NAMES_MAX,
  );
  const longName = "あ".repeat(SKILL_NAME_MAX);
  assert.deepEqual(catalog.createAgent({ name: "名前の上限ちょうど", commonSkillNames: [longName] }).commonSkillNames, [
    longName,
  ]);

  const invalidInputs: unknown[] = [
    { name: "x", commonSkillNames: "writer" },
    { name: "x", commonSkillNames: { name: "writer" } },
    { name: "x", commonSkillNames: [42] },
    { name: "x", commonSkillNames: ["writer", 42] },
    { name: "x", commonSkillNames: [...atLimit, "one-more"] },
    { name: "x", commonSkillNames: ["あ".repeat(SKILL_NAME_MAX + 1)] },
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => catalog.createAgent(input),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
      `must reject ${JSON.stringify(input).slice(0, 80)}`,
    );
  }

  // 不正な更新も 400 (既存値は保持)
  const agent = catalog.createAgent({ name: "更新検証", commonSkillNames: ["writer"] });
  assert.throws(
    () => catalog.updateAgent(agent.id, { commonSkillNames: [42] }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(catalog.getAgent(agent.id)?.commonSkillNames, ["writer"]);
});

test("自然文での発火は既定で ON、false だけを保存し、ビルトインは常に OFF", () => {
  const catalog = createAgentCatalog();
  assert.equal(catalog.builtinAgent().allowNaturalInvocation, false);
  assert.equal(allowsNaturalInvocation(catalog.builtinAgent()), false);

  const user = catalog.createAgent({ name: "ユーザー" });
  assert.equal(Object.hasOwn(user, "allowNaturalInvocation"), false, "既定はキーを省略する");
  assert.equal(allowsNaturalInvocation(user), true);

  const manual = catalog.createAgent({ name: "手動", allowNaturalInvocation: false });
  assert.equal(manual.allowNaturalInvocation, false);
  assert.equal(allowsNaturalInvocation(manual), false);

  // true / null は既定 (ON) に戻る。true は保存しない
  assert.equal(
    Object.hasOwn(catalog.updateAgent(manual.id, { allowNaturalInvocation: true }) ?? {}, "allowNaturalInvocation"),
    false,
  );
  assert.equal(allowsNaturalInvocation(catalog.getAgent(manual.id) ?? manual), true);
  assert.equal(
    Object.hasOwn(catalog.updateAgent(manual.id, { allowNaturalInvocation: null }) ?? {}, "allowNaturalInvocation"),
    false,
  );

  // 不正な値は 400 (既存値は保持)
  const stillManual = catalog.createAgent({ name: "手動のまま", allowNaturalInvocation: false });
  assert.throws(
    () => catalog.updateAgent(stillManual.id, { allowNaturalInvocation: "on" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  assert.equal(catalog.getAgent(stillManual.id)?.allowNaturalInvocation, false);
});

test("normalizes the builtin skill allowlist independently from the common one", () => {
  const catalog = createAgentCatalog();

  // 未指定 / null はキーごと省略 (= 全部 ON)、`[]` は「すべて OFF」なので残す
  assert.equal(Object.hasOwn(catalog.createAgent({ name: "未指定" }), "builtinSkillNames"), false);
  assert.equal(
    Object.hasOwn(catalog.createAgent({ name: "null 作成", builtinSkillNames: null }), "builtinSkillNames"),
    false,
  );
  assert.deepEqual(catalog.createAgent({ name: "全 OFF", builtinSkillNames: [] }).builtinSkillNames, []);

  // trim / 空除去 / 重複排除
  const normalized = catalog.createAgent({ name: "正規化", builtinSkillNames: [" serve ", "", "serve", "gh"] });
  assert.deepEqual(normalized.builtinSkillNames, ["serve", "gh"]);

  // キー省略の更新は保持、null は解除、`[]` はすべて OFF へ上書き。共通側とは独立して保持する
  assert.deepEqual(catalog.updateAgent(normalized.id, { description: "説明だけ更新" })?.builtinSkillNames, [
    "serve",
    "gh",
  ]);
  assert.deepEqual(catalog.updateAgent(normalized.id, { commonSkillNames: ["writer"] })?.builtinSkillNames, [
    "serve",
    "gh",
  ]);
  assert.equal(
    Object.hasOwn(catalog.updateAgent(normalized.id, { builtinSkillNames: null }) ?? {}, "builtinSkillNames"),
    false,
  );
  assert.deepEqual(catalog.updateAgent(normalized.id, { builtinSkillNames: [] })?.builtinSkillNames, []);

  // 不正な値は共通と同じく 400 (既存値は保持)
  assert.throws(
    () => catalog.updateAgent(normalized.id, { builtinSkillNames: [42] }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(catalog.getAgent(normalized.id)?.builtinSkillNames, []);
});

test("normalizes the tool allowlist without collapsing undefined and []", () => {
  const catalog = createAgentCatalog();

  // 未指定 / null はキーごと省略 (= 全部 ON)、`[]` は「すべて OFF」なので残す
  assert.equal(Object.hasOwn(catalog.createAgent({ name: "未指定" }), "toolNames"), false);
  assert.equal(Object.hasOwn(catalog.createAgent({ name: "null 作成", toolNames: null }), "toolNames"), false);
  assert.deepEqual(catalog.createAgent({ name: "全 OFF", toolNames: [] }).toolNames, []);

  // trim / 空除去 / 重複排除。空になった配列も `[]` = すべて OFF として残す
  const normalized = catalog.createAgent({ name: "正規化", toolNames: [" read ", "", "read", "serve"] });
  assert.deepEqual(normalized.toolNames, ["read", "serve"]);
  assert.deepEqual(catalog.createAgent({ name: "空だけ", toolNames: ["", " "] }).toolNames, []);

  // 一覧に無い保存名もそのまま残す (改名・削除・同梱の入れ替えで保存値を書き換えない)
  const unknown = catalog.createAgent({ name: "未知", toolNames: ["gone"] });
  assert.deepEqual(unknown.toolNames, ["gone"]);

  // キー省略の更新は保持、null は解除、`[]` はすべて OFF へ上書き
  const kept = catalog.updateAgent(normalized.id, { description: "説明だけ更新" });
  assert.deepEqual(kept?.toolNames, ["read", "serve"]);
  const cleared = catalog.updateAgent(normalized.id, { toolNames: null });
  assert.equal(Object.hasOwn(cleared ?? {}, "toolNames"), false);
  assert.deepEqual(catalog.updateAgent(normalized.id, { toolNames: ["read"] })?.toolNames, ["read"]);
  assert.deepEqual(catalog.updateAgent(normalized.id, { toolNames: [] })?.toolNames, []);
  assert.deepEqual(catalog.getAgent(normalized.id)?.toolNames, []);

  // 応答はコピーを返す (呼び出し側の書き換えが内部へ染みない)
  const exported = catalog.getAgent(unknown.id)?.toolNames;
  assert.ok(exported);
  exported.push("追加");
  assert.deepEqual(catalog.listAgents().find((agent) => agent.id === unknown.id)?.toolNames, ["gone"]);
});

test("rejects malformed tool lists with 400", () => {
  const catalog = createAgentCatalog();
  const atLimit = Array.from({ length: TOOL_NAMES_MAX }, (_, index) => `tool-${index}`);
  assert.equal(
    catalog.createAgent({ name: "配列の上限ちょうど", toolNames: atLimit }).toolNames?.length,
    TOOL_NAMES_MAX,
  );
  const longName = "a".repeat(TOOL_NAME_MAX);
  assert.deepEqual(catalog.createAgent({ name: "名前の上限ちょうど", toolNames: [longName] }).toolNames, [longName]);

  const invalidInputs: unknown[] = [
    { name: "x", toolNames: "read" },
    { name: "x", toolNames: { name: "read" } },
    { name: "x", toolNames: [42] },
    { name: "x", toolNames: ["read", 42] },
    { name: "x", toolNames: [...atLimit, "one-more"] },
    { name: "x", toolNames: ["a".repeat(TOOL_NAME_MAX + 1)] },
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => catalog.createAgent(input),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
      `must reject ${JSON.stringify(input).slice(0, 80)}`,
    );
  }

  // 不正な更新も 400 (既存値は保持)
  const agent = catalog.createAgent({ name: "更新検証", toolNames: ["read"] });
  assert.throws(
    () => catalog.updateAgent(agent.id, { toolNames: [42] }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(catalog.getAgent(agent.id)?.toolNames, ["read"]);
});

test("composePromptSnapshot はエージェントプロファイルだけを固定し、スキル本文は含めない", () => {
  const snapshot = composePromptSnapshot({
    id: "agent-example",
    name: "例",
    description: "説明",
    systemPrompt: "短く答えてください。",
  });
  assert.match(snapshot.agent, /<agent_profile name="例">/);
  assert.match(snapshot.agent, /短く答えてください。/);
  // スキルの本文はファイル側の現行定義を read / `/skill:` で読む (セッションへ固定しない)
  assert.deepEqual(Object.keys(snapshot), ["agent"]);
});

test("reports the injected builtin skills as a separate copy", () => {
  const builtinSkills = [{ name: "skill-creator", description: "スキルの作成を依頼されたときに使う", version: "3" }];
  const catalog = createAgentCatalog({ builtinSkills });

  assert.deepEqual(catalog.snapshot().builtinSkills, builtinSkills);

  // 呼び出し側 / 応答側の書き換えが内部や次の応答へ染みない
  builtinSkills[0].name = "書き換え";
  const exported = catalog.snapshot().builtinSkills;
  assert.equal(exported[0].name, "skill-creator");
  exported[0].name = "書き換え 2";
  assert.equal(catalog.snapshot().builtinSkills[0].name, "skill-creator");

  // 同梱物はファイル側のスキルで、このカタログの定義ではない (読み書きの対象も持たない)
  assert.equal(Object.hasOwn(catalog.snapshot(), "skills"), false);
});

test("appendSystemPrompt は作業ディレクトリとファイル / スキルの置き場を rootCwd で説明する", () => {
  const prompt = appendSystemPrompt("/workspace");
  assert.match(prompt, /registered project directory/);
  assert.match(prompt, /scratch directory/);
  assert.match(prompt, /relative to the working directory/);
  // bash の書き込みは許可 root の外で EACCES になる。リダイレクトではなく write / edit を使わせる
  assert.match(prompt, /writes elsewhere fail with `EACCES`/);
  assert.match(prompt, /Use the `write` \/ `edit` tools instead of shell redirection/);
  assert.match(
    prompt,
    /When summarizing files, refer to files inside the working directory by cwd-relative path, but use their absolute paths for files under `\/workspace\/\.agents\/skills`; a cwd-relative path there points somewhere else\./,
  );
  // 入力欄へ落とした `@<path>` の参照を read で開かせる。空白を含むパスは引用付き (`@"<path>"`)
  assert.match(prompt, /`@<path>` mention/);
  assert.match(prompt, /`@"<path>"`/);
  assert.match(prompt, /`\/workspace\/\.agents\/skills`/);
  // セッション cwd の絶対パスは SDK が Current working directory: で付ける
  assert.doesNotMatch(prompt, /\/workspace\/\.u7agent/);
  // 未所属で発見されないスキルの置き場だけを案内しない
  assert.doesNotMatch(prompt, /The working directory is the user's local project/);
  assert.match(appendSystemPrompt("/other/root"), /`\/other\/root\/\.agents\/skills`/);
});

test("appendSystemPrompt は外した組み込みスキルの案内を出さない", () => {
  const all = appendSystemPrompt("/workspace");
  assert.match(all, /follow the bundled `serve` skill/);
  assert.match(all, /follow the bundled `skill-creator` skill/);

  // 外した組み込みは索引からも prompt からも落ちる。ツールと置き場の案内はスキルとは別に残す
  const none = appendSystemPrompt("/workspace", { builtinSkillNames: [] });
  assert.doesNotMatch(none, /bundled `serve` skill/);
  assert.doesNotMatch(none, /bundled `skill-creator` skill/);
  assert.match(none, /drive it with the `serve` tool/);
  assert.match(none, /put it in the `\.agents\/skills` directory/);

  const skillCreatorOnly = appendSystemPrompt("/workspace", { builtinSkillNames: ["skill-creator"] });
  assert.doesNotMatch(skillCreatorOnly, /bundled `serve` skill/);
  assert.match(skillCreatorOnly, /follow the bundled `skill-creator` skill/);

  // 自然文で発火しない = 索引に載らないので、スキルへの案内も出さない
  const manualOnly = appendSystemPrompt("/workspace", { allowNaturalInvocation: false });
  assert.doesNotMatch(manualOnly, /bundled `serve` skill/);
  assert.doesNotMatch(manualOnly, /bundled `skill-creator` skill/);
  assert.match(manualOnly, /drive it with the `serve` tool/);
});

test("appendSystemPrompt は環境変数の契約文を持たない (正は同梱の serve スキル)", () => {
  const prompt = appendSystemPrompt("/workspace");
  // 種別ごとの注入先と確認方法は serve ツールの guideline とスキルに置き、system prompt はポインタだけを保つ
  assert.match(prompt, /follow the bundled `serve` skill/);
  assert.doesNotMatch(prompt, /process\.env/);
  assert.doesNotMatch(prompt, /REDACTED/);
});

test("appendSystemPrompt は画像生成ツールの案内を有効時だけ足す", () => {
  const off = appendSystemPrompt("/workspace");
  assert.doesNotMatch(off, /generate_image/);
  const on = appendSystemPrompt("/workspace", { imageGeneration: true });
  assert.match(on, /generate_image saves generated images/);
  assert.match(on, /Markdown image/);
  assert.match(on, /generated\/name\.png/);
});

test("appendSystemPrompt は音声生成ツールの案内を有効時だけ足し、演技指示と連結を約束しない", () => {
  const off = appendSystemPrompt("/workspace");
  assert.doesNotMatch(off, /generate_speech/);
  const on = appendSystemPrompt("/workspace", { speechGeneration: true });
  assert.match(on, /generate_speech writes only the words to read/);
  assert.match(on, /verbatim/);
  assert.match(on, /multiple times with separate parts/);
  assert.match(on, /concatenating them is out of scope/);
  assert.match(on, /actual saved path/);
  // 連結の道具はサンドボックスに無いので、やることを約束しない
  assert.doesNotMatch(on, /concatenate the files|join the parts for the user/);
});

test("appendSystemPrompt はサンドボックスの python / uv と .venv の運用を説明する", () => {
  const prompt = appendSystemPrompt("/workspace");
  // ベースイメージの Python が上がったらプロンプトの記述も見直す (node 26 と同じ性質のドリフト)
  assert.match(prompt, /python 3\.13, uv/);
  assert.match(prompt, /`\.venv` directly under it/);
  assert.match(prompt, /uv pip install --python \.venv\/bin\/python/);
  assert.doesNotMatch(prompt, /Not installed there:.*\bpython3\b/);
});

test("system prompt の同梱物一覧はヘッドレスブラウザを名指しする", () => {
  // 一覧はイメージの中身を写したもので、apt 相当の一覧と command -v 検査 (Dockerfile) とセットで更新する
  assert.match(appendSystemPrompt("/workspace"), /chromium \(headless, u7agent-browser\)/);
  // 子エージェントにも同じコンテナを見せる。読み取り専用でも dom / check は使える
  assert.match(investigationSystemPrompt(), /chromium \(headless, u7agent-browser\)/);
});

test("investigationSystemPrompt は読み取り専用と調査に要る案内だけを残す", () => {
  const prompt = investigationSystemPrompt();
  assert.match(prompt, /read-only investigation sub-agent/);
  assert.match(prompt, /Never change files/);
  assert.match(prompt, /`@<path>` mention/);
  assert.match(prompt, /curl for HTTP\(S\)/);
  assert.match(prompt, /working directory/);
  // 子に渡さないツールの案内は入れない (存在しない操作を促さない)
  assert.doesNotMatch(prompt, /\bserve\b/);
  assert.doesNotMatch(prompt, /generate_image/);
  assert.doesNotMatch(prompt, /\.agents\/skills/);
  assert.doesNotMatch(prompt, /uv venv/);
});

test("investigationTools は読み取り専用ツールと allowlist の積になる", () => {
  assert.deepEqual(investigationTools(["read", "bash", "edit", "write", "grep", "find", "ls"]), [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
  ]);
  // PI_AGENT_TOOLS で bash を外している運用では子にも入らない
  assert.deepEqual(investigationTools(["read", "grep"]), ["read", "grep"]);
  assert.deepEqual(investigationTools(["edit", "write"]), []);
});
