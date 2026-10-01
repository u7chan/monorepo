// ツール履歴 (引数 / 出力) の表示文字列。cwd 配下の絶対パスは `./` 付きの cwd 相対へ畳み、cwd の外は
// 絶対のまま残す (root 相対へ寄せると基準が 2 つになり、`lib/x.js` がどちらの基準か読めなくなる)。
// 境界の判定と、ライブ / 履歴の両方が同じ cwd で畳むことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createSecretMasker, REDACTED } from "../src/redact";
import { createRunEventBridge } from "../src/run-events";
import { cwdRelativeText, projectMessages, toolArgsSummary, toolResultSummary } from "../src/session-projection";
import type { MessageMetrics, ToolCall } from "../src/schema";
import type { PiSessionEvent, PiSessionLike } from "../src/sessions";

const CWD = "/workspace/.u7agent/sessions/364cfbf2c1";
const masker = createSecretMasker([]);

function text(value: string): unknown {
  return { type: "text", text: value };
}

test("cwdRelativeText は cwd 配下を ./ 付きの相対へ畳み、cwd 自身は . にする", () => {
  assert.equal(cwdRelativeText(`${CWD}/lib/engine/physics2d.js`, CWD), "./lib/engine/physics2d.js");
  assert.equal(cwdRelativeText(CWD, CWD), ".");
  assert.equal(cwdRelativeText(`ls "${CWD}"`, CWD), 'ls "."');
  assert.equal(cwdRelativeText(`cd ${CWD}/lib && npm test`, CWD), "cd ./lib && npm test");
  // 末尾スラッシュ付きの cwd でも同じ結果にする
  assert.equal(cwdRelativeText(`${CWD}/lib/x.js`, `${CWD}/`), "./lib/x.js");
  // 同じ本文に複数あってもすべて畳む
  assert.equal(cwdRelativeText(`${CWD}/a.js -> ${CWD}/b.js`, CWD), "./a.js -> ./b.js");
  // JSON フォールバックの引数にも当たる
  assert.equal(cwdRelativeText(JSON.stringify({ file_path: `${CWD}/a b.js` }), CWD), '{"file_path":"./a b.js"}');
  // cwd 未確定 ("") は root と同義なので畳まない
  assert.equal(cwdRelativeText("/a/b.js", ""), "/a/b.js");
});

test("cwdRelativeText は cwd を接頭辞 / 接尾に含むだけの別のパスを畳まない", () => {
  for (const path of [
    // 兄弟ディレクトリと、名前が伸びただけのファイル
    `${CWD}-old/lib/x.js`,
    `${CWD}.bak`,
    `/tmp/${CWD}/lib/x.js`,
    // セグメントとして cwd を末尾に含む長いパス
    "/a/b/c/d",
    // cwd の外 (プロジェクトや共通スキル)
    "/workspace/projects/u7agent/README.md",
  ]) {
    const cwd = path === "/a/b/c/d" ? "/b/c" : CWD;
    assert.equal(cwdRelativeText(path, cwd), path);
  }
});

test("toolArgsSummary は path の絶対パスだけを畳み、元から相対の引数はそのまま残す", () => {
  assert.equal(toolArgsSummary({ path: `${CWD}/lib/engine/physics2d.js` }, masker, CWD), "./lib/engine/physics2d.js");
  assert.equal(toolArgsSummary({ file_path: `${CWD}/lib/x.js`, offset: 3 }, masker, CWD), "./lib/x.js");
  assert.equal(toolArgsSummary({ file_path: "lib/engine/physics2d.js" }, masker, CWD), "lib/engine/physics2d.js");
  assert.equal(toolArgsSummary({ file_path: "~/x.js" }, masker, CWD), "~/x.js");
  assert.equal(toolArgsSummary({ command: `cd ${CWD} && rg -n fix lib` }, masker, CWD), "$ cd . && rg -n fix lib");
  assert.equal(toolArgsSummary({ unknown: `${CWD}/x.js` }, masker, CWD), `{"unknown":"./x.js"}`);
});

test("toolResultSummary は出力本文中の絶対パスも畳む", () => {
  const body = `Successfully replaced 1 block(s) in ${CWD}/lib/engine/physics2d.js`;
  assert.equal(
    toolResultSummary({ content: [text(body)] }, masker, CWD),
    "Successfully replaced 1 block(s) in ./lib/engine/physics2d.js",
  );
});

test("相対化はマスクより先に当て、畳んだ後の文字列にもマスクを掛ける", () => {
  const secret = "sk-display-dummy-0123456789";
  const masking = createSecretMasker([secret]);
  assert.equal(toolArgsSummary({ path: `${CWD}/keys/${secret}.txt` }, masking, CWD), `./keys/${REDACTED}.txt`);
  assert.equal(
    toolResultSummary({ content: [text(`saved ${CWD}/out.json with ${secret}`)] }, masking, CWD),
    `saved ./out.json with ${REDACTED}`,
  );
});

test("履歴のツールカードはセッション cwd で相対化した引数と出力を持つ", () => {
  const messages = [
    { role: "user", content: "直して", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "edit", arguments: { file_path: `${CWD}/lib/engine/physics2d.js` } },
        text("直しました"),
      ],
      stopReason: "stop",
      timestamp: 2,
    },
    {
      role: "toolResult",
      content: [text(`Successfully replaced 1 block(s) in ${CWD}/lib/engine/physics2d.js`)],
      toolCallId: "call-1",
      isError: false,
      timestamp: 3,
    },
  ];
  const session = { messages } as unknown as PiSessionLike;
  const projected = projectMessages(session, new WeakMap<object, MessageMetrics>(), masker, CWD);
  assert.deepEqual(projected.at(-1)?.tools?.[0]?.args, "./lib/engine/physics2d.js");
  assert.equal(projected.at(-1)?.tools?.[0]?.output, "Successfully replaced 1 block(s) in ./lib/engine/physics2d.js");
});

test("ライブの tool_start / tool_end も履歴と同じ cwd 相対の文字列を配る", () => {
  const events: Array<{ type: string; data: unknown }> = [];
  const bridge = createRunEventBridge({
    session: { messages: [] } as unknown as PiSessionLike,
    masker,
    cwd: CWD,
    tools: new Map<string, ToolCall>(),
    messageMetrics: new WeakMap<object, MessageMetrics>(),
    compactionMeta: new Map(),
    emit: (type, data) => events.push({ type, data }),
    emitResync: () => {},
    onRetryScheduled: () => {},
    onRetryAttemptStart: () => {},
    onRetryEnd: () => {},
    onSettled: () => {},
  });
  const toolEvent = (event: PiSessionEvent) => bridge.listener(event);
  toolEvent({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "edit",
    args: { file_path: `${CWD}/lib/engine/physics2d.js` },
  });
  toolEvent({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "edit",
    isError: false,
    result: { content: [text(`Successfully replaced 1 block(s) in ${CWD}/lib/engine/physics2d.js`)] },
  });
  const started = events.find((event) => event.type === "tool_start")?.data as { args: string } | undefined;
  const ended = events.find((event) => event.type === "tool_end")?.data as { output: string } | undefined;
  assert.equal(started?.args, "./lib/engine/physics2d.js");
  assert.equal(ended?.output, "Successfully replaced 1 block(s) in ./lib/engine/physics2d.js");
});
