// ツールのレジストリ (tool-catalog.ts) と、セッションへ公開する集合 (agent.ts の sessionToolPlan) の検証。
// 実サンドボックス・実 SDK は使わない。

import assert from "node:assert/strict";
import test from "node:test";
import { investigationTools, sessionToolPlan, type SessionToolPlan } from "../src/agent";
import { ASK_USER_TOOL_NAME } from "../src/ask-user-tool";
import { IMAGE_TOOL_NAME } from "../src/image-tools";
import { INVESTIGATE_TOOL_NAME } from "../src/investigate-tool";
import { REMOTE_TOOL_NAMES } from "../src/sandbox/remote-tools";
import { SERVE_TOOL_NAME } from "../src/serve-tool";
import { SPEECH_TOOL_NAME } from "../src/speech-tools";
import { BGM_TOOL_NAME } from "../src/bgm-tools";
import { toolCatalog, type ToolAvailability } from "../src/tool-catalog";
import { WEB_SEARCH_TOOL_NAME } from "../src/web-search-tool";

const ALL_SANDBOX_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const OPEN: ToolAvailability = {
  sandboxTools: ALL_SANDBOX_TOOLS,
  contentGeneration: true,
  webSearch: true,
  serve: true,
  askUser: true,
  investigate: true,
};

/** レジストリの app グループと `enabled` の並び */
const APP_TOOL_NAMES = [
  WEB_SEARCH_TOOL_NAME,
  IMAGE_TOOL_NAME,
  SPEECH_TOOL_NAME,
  BGM_TOOL_NAME,
  SERVE_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  INVESTIGATE_TOOL_NAME,
];

/** `tools` の名前へ app ツールが追加される順 (agent.ts の with* チェーン) */
const REGISTERED_APP_NAMES = [
  IMAGE_TOOL_NAME,
  SPEECH_TOOL_NAME,
  BGM_TOOL_NAME,
  SERVE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  INVESTIGATE_TOOL_NAME,
];

function entry(name: string, availability: ToolAvailability = OPEN) {
  const found = toolCatalog(availability).find((tool) => tool.name === name);
  assert.ok(found, `${name} がレジストリに無い`);
  return found;
}

/** 意図的に全 OFF にした組み合わせは、アプリ側の理由コードとして出る */
test("レジストリは作業ツールとアプリのツールを種別つきで並べる", () => {
  const catalog = toolCatalog(OPEN);
  assert.equal(catalog.length, 14);
  assert.deepEqual(
    catalog.filter((tool) => tool.group === "sandbox").map((tool) => tool.name),
    ALL_SANDBOX_TOOLS,
  );
  assert.deepEqual(
    catalog
      .filter((tool) => tool.group === "sandbox")
      .map((tool) => tool.name)
      .toSorted(),
    REMOTE_TOOL_NAMES.toSorted(),
    "作業ツールはサンドボックスの提供リストと一致する",
  );
  assert.deepEqual(
    catalog.filter((tool) => tool.group === "app").map((tool) => tool.name),
    APP_TOOL_NAMES,
  );
  for (const tool of catalog) {
    assert.equal(tool.available, true);
    assert.equal(tool.description.length > 0, true, `${tool.name} に画面用の説明が無い`);
    // available のときは理由コードを載せない (画面が「使えない」と読み違えない)
    assert.equal(Object.hasOwn(tool, "reason"), false);
  }
});

test("作業ツールの可否は PI_AGENT_TOOLS の実効で決まり、外れた名前は理由付きで返る", () => {
  const limited = toolCatalog({ ...OPEN, sandboxTools: ["read", "grep"] });
  assert.deepEqual(
    limited.filter((tool) => tool.available).map((tool) => tool.name),
    ["read", "grep", ...APP_TOOL_NAMES],
  );
  assert.deepEqual(
    limited.filter((tool) => tool.reason === "deploy_allowlist").map((tool) => tool.name),
    ["bash", "edit", "write", "find", "ls"],
  );
  // デプロイ側の上限はアプリのツールには掛からない (docs/api-catalog.md)
  assert.equal(entry(SERVE_TOOL_NAME, { ...OPEN, sandboxTools: [] }).available, true);
});

test("アプリのツールはキー・実行時トグル・実体の有無で止まり、理由コードが変わる", () => {
  // キー未設定 (コンテンツ生成が無効) だけは no_key。行は残し、画面が「キーを設定すれば使える」と伝える
  assert.deepEqual(entry(IMAGE_TOOL_NAME, { ...OPEN, contentGeneration: false }), {
    name: IMAGE_TOOL_NAME,
    description: entry(IMAGE_TOOL_NAME).description,
    group: "app",
    available: false,
    reason: "no_key",
  });
  assert.equal(entry(SPEECH_TOOL_NAME, { ...OPEN, contentGeneration: false }).reason, "no_key");
  assert.equal(entry(BGM_TOOL_NAME, { ...OPEN, contentGeneration: false }).reason, "no_key");

  for (const [name, patch] of [
    [WEB_SEARCH_TOOL_NAME, { webSearch: false }],
    [SERVE_TOOL_NAME, { serve: false }],
    [ASK_USER_TOOL_NAME, { askUser: false }],
    [INVESTIGATE_TOOL_NAME, { investigate: false }],
  ] as const) {
    const tool = entry(name, { ...OPEN, ...patch });
    assert.equal(tool.available, false, name);
    assert.equal(tool.reason, "app_disabled", name);
  }
});

/** 実効はアプリ側 ∩ エージェントの許可リスト。tools の名前と customTools の enabled を同じ判定から作る */
test("sessionToolPlan は許可リストの積を取り、tools と enabled が一致する", () => {
  const all = sessionToolPlan({ base: ALL_SANDBOX_TOOLS, availability: OPEN, investigation: false });
  assert.deepEqual(all.names, [...ALL_SANDBOX_TOOLS, ...REGISTERED_APP_NAMES]);
  // `enabled` は customTools 用の対象 (アプリのツール) だけを持ち、`names` のアプリ分と一致する
  assert.deepEqual([...all.enabled], APP_TOOL_NAMES);

  // 未指定 = 全部 ON、`[]` = すべて OFF。どちらも「アプリ側の実効」を上限とする
  const off = sessionToolPlan({ base: ALL_SANDBOX_TOOLS, toolNames: [], availability: OPEN, investigation: false });
  assert.deepEqual(off.names, []);
  assert.deepEqual([...off.enabled], []);

  const readOnly = sessionToolPlan({
    base: ALL_SANDBOX_TOOLS,
    toolNames: ["read", "bash"],
    availability: OPEN,
    investigation: false,
  });
  assert.deepEqual(readOnly.names, ["read", "bash"]);
  assert.deepEqual([...readOnly.enabled], []);

  const sandboxOnly = sessionToolPlan({
    base: ALL_SANDBOX_TOOLS,
    toolNames: ["read", "bash", SERVE_TOOL_NAME],
    availability: OPEN,
    investigation: false,
  });
  assert.deepEqual(sandboxOnly.names, ["read", "bash", SERVE_TOOL_NAME]);
  assert.deepEqual([...sandboxOnly.enabled], [SERVE_TOOL_NAME]);

  // アプリ側が止めているツールは許可リストに入れても公開しない (安全側)
  const appOff = sessionToolPlan({
    base: ALL_SANDBOX_TOOLS,
    toolNames: [SERVE_TOOL_NAME, IMAGE_TOOL_NAME],
    availability: { ...OPEN, serve: false, contentGeneration: false },
    investigation: false,
  });
  assert.deepEqual(appOff.names, []);
  assert.deepEqual([...appOff.enabled], []);

  // 一覧に無い保存名 (改名・削除済み) が混ざっても落ちず、その名前だけが無視される
  const unknown = sessionToolPlan({
    base: ALL_SANDBOX_TOOLS,
    toolNames: ["read", "gone"],
    availability: OPEN,
    investigation: false,
  });
  assert.deepEqual(unknown.names, ["read"]);

  // 作業ツールはレジストリで絞らない (PI_AGENT_TOOLS の設定ミスを UnknownRemoteToolError で出すため)
  const platform = sessionToolPlan({
    base: [...ALL_SANDBOX_TOOLS, "powershell"],
    availability: OPEN,
    investigation: false,
  });
  assert.equal(platform.sandbox.includes("powershell"), true);
});

test("子セッションは作業ツールだけを引き継ぎ、親の許可リストとの積で減る", () => {
  const child: SessionToolPlan = sessionToolPlan({
    base: investigationTools(ALL_SANDBOX_TOOLS),
    toolNames: ["read", "bash", "write", SERVE_TOOL_NAME],
    availability: OPEN,
    investigation: true,
  });
  // 読み取り専用の集合 ∩ 親の許可リスト。write とアプリのツールは子へ渡さない
  assert.deepEqual(child.names, ["read", "bash"]);
  assert.deepEqual(child.sandbox, ["read", "bash"]);
  assert.deepEqual([...child.enabled], []);

  // 親が全部 ON なら子は読み取り専用の全部
  const open = sessionToolPlan({
    base: investigationTools(ALL_SANDBOX_TOOLS),
    availability: OPEN,
    investigation: true,
  });
  assert.deepEqual(open.names, ["read", "grep", "find", "ls", "bash"]);
});
