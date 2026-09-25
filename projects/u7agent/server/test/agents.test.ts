import assert from "node:assert/strict";
import test from "node:test";
import { appendSystemPrompt, composePromptSnapshot } from "../src/agent";
import { createAgentCatalog } from "../src/agents";

const DEFAULT_SUGGESTIONS = [
  { label: "プロジェクトを説明して", prompt: "このプロジェクトの構成を簡単に教えて" },
  { label: "テストを確認して", prompt: "まずテストがあるか確認して" },
  { label: "README をレビューして", prompt: "README を読んで改善案を3つ出して" },
];

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
  // 既定のエージェント自身は役割もスキルも持たない (口調のサンプルはユーザー定義側に置く)
  assert.equal(agent.systemPrompt, "");
  assert.deepEqual(agent.skillIds, []);

  const samples = catalog.listAgents();
  assert.deepEqual(
    samples.map((sample) => sample.id),
    ["agent-zundamon"],
    "初期状態のユーザー定義はずんだもんだけ",
  );
  assert.equal(samples[0].name, "ずんだもん");
  assert.match(samples[0].systemPrompt, /なのだ/);
  assert.deepEqual(samples[0].skillIds, []);
  // カタログスキルは 0 件から始まる (常時効かせたい指示はエージェント側へ置く)
  assert.deepEqual(catalog.listSkills(), []);
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

test("drops references to skills that do not exist", () => {
  const catalog = createAgentCatalog();
  const skill = catalog.createSkill({ name: "実在スキル", description: "説明", body: "本文" });

  // 存在しない id を混ぜても、実在する参照だけを残す
  const created = catalog.createAgent({ name: "参照あり", skillIds: [skill.id, "skill-missing"] });
  assert.deepEqual(created.skillIds, [skill.id]);

  // 存在しない id だけを送った更新でも空になる
  const updated = catalog.updateAgent(created.id, { skillIds: ["skill-missing"] });
  assert.deepEqual(updated?.skillIds, []);
});

test("only the built-in agent ships with default suggestions", () => {
  const catalog = createAgentCatalog();
  assert.deepEqual(catalog.builtinAgent().suggestions, DEFAULT_SUGGESTIONS);

  // ユーザー定義は追加項目を書かない限り suggestions を持たない
  const created = catalog.createAgent({ name: "定型なし" });
  assert.equal(Object.hasOwn(created, "suggestions"), false);
});

test("normalizes agent suggestions on create", () => {
  const catalog = createAgentCatalog();

  // 配列でなければ未指定 (キー省略)。null / 文字列 / オブジェクト / 数値はすべて同じ扱い
  const nonArrays: unknown[] = [null, undefined, "プロンプト", { label: "x", prompt: "y" }, 42];
  for (const suggestions of nonArrays) {
    const agent = catalog.createAgent({ name: "非配列", suggestions });
    assert.equal(
      Object.hasOwn(agent, "suggestions"),
      false,
      `must omit suggestions for ${JSON.stringify(suggestions)}`,
    );
  }

  // label / prompt が空・非文字列の要素は捨てる
  const kept = { label: "残る", prompt: "残るプロンプト" };
  const dropped = catalog.createAgent({
    name: "空要素",
    suggestions: [
      { label: "   ", prompt: "有効なプロンプト" },
      { label: "有効なラベル", prompt: "   " },
      { label: 42, prompt: "数値ラベル" },
      { prompt: "ラベルなし" },
      null,
      "文字列",
      kept,
    ],
  });
  assert.deepEqual(dropped.suggestions, [{ label: "残る", prompt: "残るプロンプト" }]);
  // 元の入力オブジェクトを参照で持ち回らない
  assert.notEqual(dropped.suggestions?.[0], kept);

  // 正規化後に 0 件ならキーを省略する
  const empty = catalog.createAgent({
    name: "全部空",
    suggestions: [{ label: "", prompt: "" }, { label: " ", prompt: " " }, null],
  });
  assert.equal(Object.hasOwn(empty, "suggestions"), false);
});

test("trims, truncates and deduplicates suggestions before the 6 item cap", () => {
  const catalog = createAgentCatalog();

  const trimmed = catalog.createAgent({
    name: "trim と切り詰め",
    suggestions: [{ label: `  ${"い".repeat(70)}  `, prompt: `  ${"う".repeat(600)}  ` }],
  });
  assert.equal(trimmed.suggestions?.[0].label, "い".repeat(60));
  assert.equal(trimmed.suggestions?.[0].prompt, "う".repeat(500));

  // prompt の重複は最初の 1 件だけ残す (trim 後で比較する)
  const deduped = catalog.createAgent({
    name: "重複排除",
    suggestions: [
      { label: "1 件目", prompt: "同じ" },
      { label: "2 件目", prompt: "同じ" },
      { label: "3 件目", prompt: " 同じ " },
      { label: "別", prompt: "別のプロンプト" },
    ],
  });
  assert.deepEqual(deduped.suggestions, [
    { label: "1 件目", prompt: "同じ" },
    { label: "別", prompt: "別のプロンプト" },
  ]);

  // 重複排除が先なので、重複は 6 件の枠を消費せず 7 件目のユニークが残る
  const capped = catalog.createAgent({
    name: "上限",
    suggestions: [
      { label: "A", prompt: "A" },
      { label: "A の重複", prompt: "A" },
      { label: "B", prompt: "B" },
      { label: "C", prompt: "C" },
      { label: "D", prompt: "D" },
      { label: "E", prompt: "E" },
      { label: "F", prompt: "F" },
      { label: "G", prompt: "G" },
    ],
  });
  assert.deepEqual(
    capped.suggestions?.map((suggestion) => suggestion.prompt),
    ["A", "B", "C", "D", "E", "F"],
  );
});

test("updates and clears agent suggestions", () => {
  const catalog = createAgentCatalog();
  const agent = catalog.createAgent({ name: "定型あり", suggestions: DEFAULT_SUGGESTIONS });

  // キー省略の更新は保持する
  const kept = catalog.updateAgent(agent.id, { description: "説明だけ更新" });
  assert.deepEqual(kept?.suggestions, DEFAULT_SUGGESTIONS);

  const replaced = catalog.updateAgent(agent.id, {
    suggestions: [{ label: " 足す ", prompt: " 追加のプロンプト " }],
  });
  assert.deepEqual(replaced?.suggestions, [{ label: "足す", prompt: "追加のプロンプト" }]);

  // 空配列 / null は解除 (キー省略)
  const cleared = catalog.updateAgent(agent.id, { suggestions: [] });
  assert.equal(Object.hasOwn(cleared ?? {}, "suggestions"), false);
  const afterClear = catalog.updateAgent(agent.id, { description: "解除後" });
  assert.equal(Object.hasOwn(afterClear ?? {}, "suggestions"), false);

  const nullCleared = catalog.updateAgent(agent.id, {
    suggestions: [{ label: "一時", prompt: "一時的なプロンプト" }],
  });
  assert.equal(nullCleared?.suggestions?.length, 1);
  const nulled = catalog.updateAgent(agent.id, { suggestions: null });
  assert.equal(Object.hasOwn(nulled ?? {}, "suggestions"), false);
});

test("public agents copy the suggestions of the internal catalog", () => {
  const catalog = createAgentCatalog();

  // ビルトイン (ユーザー定義の外) も応答のたびにコピーを返し、書き換えても内部に残らない
  const internalBuiltin = catalog.getAgent("agent-general")?.suggestions;
  const exportedBuiltin = catalog.builtinAgent().suggestions;
  assert.ok(internalBuiltin && exportedBuiltin);
  assert.notEqual(exportedBuiltin, internalBuiltin);
  assert.notEqual(exportedBuiltin[0], internalBuiltin[0]);
  exportedBuiltin[0].label = "書き換え";
  exportedBuiltin.push({ label: "追加", prompt: "追加のプロンプト" });
  assert.deepEqual(catalog.getAgent("agent-general")?.suggestions, DEFAULT_SUGGESTIONS);

  const agent = catalog.createAgent({ name: "定型あり", suggestions: [{ label: "l", prompt: "p" }] });
  const internal = catalog.getAgent(agent.id)?.suggestions;
  const exported = catalog.listAgents().find((listed) => listed.id === agent.id)?.suggestions;
  assert.ok(exported && internal);
  assert.notEqual(exported, internal);
  assert.notEqual(exported[0], internal[0]);
  exported[0].label = "書き換え";
  assert.equal(catalog.getAgent(agent.id)?.suggestions?.[0].label, "l");
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

test("composePromptSnapshot はカタログスキルの本文を agent_skill タグで固定する", () => {
  const snapshot = composePromptSnapshot(
    {
      id: "agent-example",
      name: "例",
      description: "説明",
      systemPrompt: "短く答えてください。",
      skillIds: ["skill-example"],
    },
    [{ id: "skill-example", name: "例スキル", description: "説明", body: "本文です。" }],
  );
  assert.match(snapshot.agent, /<agent_profile name="例">/);
  assert.deepEqual(snapshot.skills, ['<agent_skill name="例スキル">\n本文です。\n</agent_skill>']);
});

test("creates and updates skills with body and rejects the old prompt field", () => {
  const catalog = createAgentCatalog();

  const created = catalog.createSkill({ name: " 本文あり ", description: "説明", body: " 本文 " });
  assert.deepEqual(created, { id: created.id, name: "本文あり", description: "説明", body: "本文" });
  assert.equal(catalog.getSkill(created.id)?.body, "本文");

  // キー省略の更新は本文を残し、body だけを差し替える
  const kept = catalog.updateSkill(created.id, { description: "説明だけ更新" });
  assert.equal(kept?.body, "本文");
  assert.equal(catalog.updateSkill(created.id, { body: "新しい本文" })?.body, "新しい本文");

  // 旧フィールド名 (prompt) は受理しない (旧形式の互換は持たない)
  assert.throws(
    () => catalog.createSkill({ name: "旧形式", prompt: "旧本文" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400 && /body/.test(error.message),
  );
});

test("reports the injected builtin skills as a separate copy", () => {
  const builtinSkills = [{ name: "skill-creator", description: "スキルの作成を依頼されたときに使う" }];
  const catalog = createAgentCatalog({ builtinSkills });

  assert.deepEqual(catalog.snapshot().builtinSkills, builtinSkills);

  // 呼び出し側 / 応答側の書き換えが内部や次の応答へ染みない
  builtinSkills[0].name = "書き換え";
  const exported = catalog.snapshot().builtinSkills;
  assert.equal(exported[0].name, "skill-creator");
  exported[0].name = "書き換え 2";
  assert.equal(catalog.snapshot().builtinSkills[0].name, "skill-creator");

  // 組み込みはカタログの CRUD と skillIds の対象外
  assert.deepEqual(catalog.listSkills(), []);
  assert.equal(catalog.getSkill("skill-creator"), undefined);
});

test("appendSystemPrompt は作業ディレクトリとファイル / スキルの置き場を rootCwd で説明する", () => {
  const prompt = appendSystemPrompt("/workspace");
  assert.match(prompt, /registered project directory/);
  assert.match(prompt, /scratch directory/);
  assert.match(prompt, /relative to the working directory/);
  // 入力欄へ落とした `@<path>` の参照を read で開かせる
  assert.match(prompt, /`@<path>` mention/);
  assert.match(prompt, /`\/workspace\/\.agents\/skills`/);
  // セッション cwd の絶対パスは SDK が Current working directory: で付ける
  assert.doesNotMatch(prompt, /\/workspace\/\.u7agent/);
  // 未所属で発見されないスキルの置き場だけを案内しない
  assert.doesNotMatch(prompt, /The working directory is the user's local project/);
  assert.match(appendSystemPrompt("/other/root"), /`\/other\/root\/\.agents\/skills`/);
});

test("appendSystemPrompt はサンドボックスの python / uv と .venv の運用を説明する", () => {
  const prompt = appendSystemPrompt("/workspace");
  // ベースイメージの Python が上がったらプロンプトの記述も見直す (node 24 と同じ性質のドリフト)
  assert.match(prompt, /python 3\.13, uv/);
  assert.match(prompt, /`\.venv` directly under it/);
  assert.match(prompt, /uv pip install --python \.venv\/bin\/python/);
  assert.doesNotMatch(prompt, /Not installed there:.*\bpython3\b/);
});
