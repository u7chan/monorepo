// ツール履歴の表示文字列。畳むのはツール契約で値がパスと決まっている引数 (path / file_path / filePath)
// だけで、本文 (command / output / JSON) は書き換えない。本文の `<cwd>/…` に見える語はパスとは限らず
// (grep の検索語、case / [ ] の照合語)、書き換えるとコピーしたコマンドの挙動が変わるため。
// 表示文字列はコピーにもそのまま使われるので、畳む条件とマスクとの順序がそのまま値の正しさになる。
import assert from "node:assert/strict";
import test from "node:test";
import { createSecretMasker, REDACTED } from "../src/redact";
import { createRunEventBridge } from "../src/run-events";
import { cwdRelativePath, projectMessages, toolArgsSummary, toolResultSummary } from "../src/session-projection";
import type { MessageMetrics, ToolCall } from "../src/schema";
import type { PiSessionEvent, PiSessionLike } from "../src/sessions";

const CWD = "/workspace/.u7agent/sessions/364cfbf2c1";
const masker = createSecretMasker([]);

function text(value: string): unknown {
  return { type: "text", text: value };
}

test("cwdRelativePath は値全体が 1 つのパスの引数だけを前置きの一致で畳む", () => {
  assert.equal(cwdRelativePath(`${CWD}/lib/engine/physics2d.js`, CWD), "./lib/engine/physics2d.js");
  assert.equal(cwdRelativePath(CWD, CWD), ".");
  assert.equal(cwdRelativePath(`${CWD}/`, CWD), "./");
  assert.equal(cwdRelativePath(`${CWD}//lib/x.js`, CWD), "./lib/x.js");
  // 末尾スラッシュ付きの cwd でも同じ
  assert.equal(cwdRelativePath(`${CWD}/lib/x.js`, `${CWD}/`), "./lib/x.js");
  for (const path of [
    // 接頭辞が同じだけの兄弟ディレクトリ / ファイル
    `${CWD}+backup/a.txt`,
    `${CWD}-old/a.txt`,
    `${CWD}.bak`,
    // cwd の外と、元から相対の引数
    "/workspace/projects/u7agent/README.md",
    "lib/engine/physics2d.js",
    "~/x.js",
    "",
  ]) {
    assert.equal(cwdRelativePath(path, CWD), path);
  }
  // cwd 未確定 ("") は root と同義なので畳まない
  assert.equal(cwdRelativePath("/a/b.js", ""), "/a/b.js");
});

test("toolArgsSummary はパスの引数だけを畳み、本文は書き換えない", () => {
  assert.equal(toolArgsSummary({ path: `${CWD}/lib/engine/physics2d.js` }, masker, CWD), "./lib/engine/physics2d.js");
  assert.equal(toolArgsSummary({ file_path: CWD }, masker, CWD), ".");
  assert.equal(toolArgsSummary({ file_path: `${CWD}/lib/x.js`, offset: 3 }, masker, CWD), "./lib/x.js");
  assert.equal(toolArgsSummary({ file_path: "lib/engine/physics2d.js" }, masker, CWD), "lib/engine/physics2d.js");
  assert.equal(toolArgsSummary({ path: `${CWD}+backup/a.txt` }, masker, CWD), `${CWD}+backup/a.txt`);
  // command も JSON フォールバックも畳まない
  assert.equal(toolArgsSummary({ command: `cd ${CWD}/lib && npm test` }, masker, CWD), `$ cd ${CWD}/lib && npm test`);
  assert.equal(toolArgsSummary({ unknown: `${CWD}/x.js` }, masker, CWD), `{"unknown":"${CWD}/x.js"}`);
  assert.equal(toolArgsSummary({ glob: `${CWD}/**/*.ts` }, masker, CWD), `{"glob":"${CWD}/**/*.ts"}`);
});

test("toolResultSummary は出力を書き換えずマスクだけを掛ける", () => {
  const body = `Successfully replaced 1 block(s) in ${CWD}/lib/engine/physics2d.js`;
  assert.equal(toolResultSummary({ content: [text(body)] }, masker), body);
  // 本文の `<cwd>/…` はパスとは限らない (grep の検索語 / case のパターン / 文字列比較)
  for (const body of [
    `$ grep -n -F ${CWD}/lib/a.txt ${CWD}/haystack.txt`,
    `f=${CWD}/lib/a.txt; case $f in ${CWD}/*) echo inside;; esac`,
    `f=${CWD}/lib/a.txt; [ $f = ${CWD}/lib/a.txt ] && echo equal`,
  ]) {
    assert.equal(toolArgsSummary({ command: body }, masker, CWD), `$ ${body}`);
    assert.equal(toolResultSummary({ content: [text(body)] }, masker), body);
  }
});

test("マスクは畳む前後どちらでも秘密値を落とす", () => {
  const secret = `sqlite:${CWD}/private.db?key=dummy-password-12345678`;
  const masking = createSecretMasker([secret]);
  // cwd をまたぐ秘密値は、畳む前にマスクされるので [REDACTED] のまま残る
  assert.equal(toolArgsSummary({ command: `connect "${secret}"` }, masking, CWD), '$ connect "[REDACTED]"');
  assert.equal(toolResultSummary({ content: [text(`dsn ${secret}`)] }, masking), "dsn [REDACTED]");
  // 秘密値がパスの引数の内側にあるときは、畳んだ後の値もマスクされる
  const key = "sk-display-dummy-0123456789";
  const withKey = createSecretMasker([key]);
  assert.equal(toolArgsSummary({ path: `${CWD}/keys/${key}.txt` }, withKey, CWD), `./keys/${REDACTED}.txt`);
  // JSON フォールバックの文書全体が秘密値のときも、畳まないので完全一致マスクがそのまま効く
  const document = `{"glob":"${CWD}/**/*.ts","pattern":"dummy-password-12345678"}`;
  assert.equal(toolArgsSummary(JSON.parse(document), createSecretMasker([document]), CWD), REDACTED);
  // キーに現れた秘密値は文字列化した後のマスクが落とす
  assert.equal(toolArgsSummary({ [key]: 1 }, withKey, CWD), '{"[REDACTED]":1}');
});

test("履歴のツールカードはセッション cwd で相対化した引数を持つ", () => {
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
  assert.equal(
    projected.at(-1)?.tools?.[0]?.output,
    `Successfully replaced 1 block(s) in ${CWD}/lib/engine/physics2d.js`,
  );
});

test("ライブの tool_start / tool_end も履歴と同じ文字列を配る", () => {
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
  assert.equal(ended?.output, `Successfully replaced 1 block(s) in ${CWD}/lib/engine/physics2d.js`);
});
