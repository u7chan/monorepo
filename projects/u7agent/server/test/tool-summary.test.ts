// ツール履歴 (引数 / 出力) の表示文字列。cwd 配下の絶対パスは `./` 付きの cwd 相対へ畳み、cwd の外は
// 絶対のまま残す (root 相対へ寄せると基準が 2 つになり、`lib/x.js` がどちらの基準か読めなくなる)。
// 表示文字列はコピーにもそのまま使われるため、畳む条件 (トークン / 値の境界) とマスクとの順序が
// そのままコピーした値の正しさになる。
import assert from "node:assert/strict";
import test from "node:test";
import { createSecretMasker, REDACTED } from "../src/redact";
import { createRunEventBridge } from "../src/run-events";
import {
  cwdRelativePath,
  cwdRelativeText,
  projectMessages,
  toolArgsSummary,
  toolResultSummary,
} from "../src/session-projection";
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

test("cwdRelativeText はトークン全体が cwd 配下のパスのときだけ畳む", () => {
  assert.equal(cwdRelativeText(`saved ${CWD}/a.js`, CWD), "saved ./a.js");
  assert.equal(cwdRelativeText(`ls "${CWD}/lib"`, CWD), 'ls "./lib"');
  assert.equal(cwdRelativeText(`${CWD}/a.js -> ${CWD}/b.js`, CWD), "./a.js -> ./b.js");
  assert.equal(cwdRelativeText(`${CWD}/lib/x.js, ok`, CWD), "./lib/x.js, ok");
  // 本文では cwd 自身を畳まない (後ろに何が続くかを字種だけでは決められない)
  assert.equal(cwdRelativeText(`ls ${CWD}`, CWD), `ls ${CWD}`);
  // cwd の直前の文字は区切りとは限らない (ファイル名に使える文字) ため、位置ではなくトークンの先頭で見る
  for (const body of [
    `cat "(${CWD}/a.txt)"`,
    `cat (${CWD}/a.txt)`,
    `${CWD}+backup/a.txt`,
    `${CWD} copy/a.txt`,
    `${CWD}#old/a.txt`,
    `/mnt${CWD}/a.txt`,
    `assets@${CWD}/a.txt`,
    `sqlite:${CWD}/private.db`,
    `foo${CWD}/a.txt`,
  ]) {
    assert.equal(cwdRelativeText(body, CWD), body);
  }
  // cwd 未確定 ("") は root と同義なので畳まない
  assert.equal(cwdRelativeText("/a/b.js", ""), "/a/b.js");
});

test("toolArgsSummary は引数の形ごとに cwd 相対へ畳む", () => {
  assert.equal(toolArgsSummary({ path: `${CWD}/lib/engine/physics2d.js` }, masker, CWD), "./lib/engine/physics2d.js");
  assert.equal(toolArgsSummary({ file_path: CWD }, masker, CWD), ".");
  assert.equal(toolArgsSummary({ file_path: `${CWD}/lib/x.js`, offset: 3 }, masker, CWD), "./lib/x.js");
  assert.equal(toolArgsSummary({ file_path: "lib/engine/physics2d.js" }, masker, CWD), "lib/engine/physics2d.js");
  assert.equal(toolArgsSummary({ path: `${CWD}+backup/a.txt` }, masker, CWD), `${CWD}+backup/a.txt`);
  assert.equal(
    toolArgsSummary({ command: `cd "${CWD}/lib" && rg -n fix .` }, masker, CWD),
    '$ cd "./lib" && rg -n fix .',
  );
  assert.equal(toolArgsSummary({ command: `cat "(${CWD}/a.txt)"` }, masker, CWD), `$ cat "(${CWD}/a.txt)"`);
  assert.equal(toolArgsSummary({ command: `ls ${CWD}` }, masker, CWD), `$ ls ${CWD}`);
  // JSON フォールバックは値だけを畳む
  assert.equal(toolArgsSummary({ unknown: `${CWD}/x.js` }, masker, CWD), '{"unknown":"./x.js"}');
  assert.equal(
    toolArgsSummary({ unknown: `x ${CWD}/x.js` }, masker, CWD),
    '{"unknown":"x /workspace/.u7agent/sessions/364cfbf2c1/x.js"}',
  );
});

test("toolResultSummary は出力本文中の絶対パスも畳む", () => {
  const body = `Successfully replaced 1 block(s) in ${CWD}/lib/engine/physics2d.js`;
  assert.equal(
    toolResultSummary({ content: [text(body)] }, masker, CWD),
    "Successfully replaced 1 block(s) in ./lib/engine/physics2d.js",
  );
});

test("相対化はマスクの後に当て、cwd をまたぐ秘密値も漏らさない", () => {
  const secret = `sqlite:${CWD}/private.db?key=dummy-password-12345678`;
  const masking = createSecretMasker([secret]);
  // 完全一致マスクの後に畳むため、cwd をまたぐ秘密値はそのまま [REDACTED] になる
  assert.equal(toolArgsSummary({ command: `connect "${secret}"` }, masking, CWD), '$ connect "[REDACTED]"');
  assert.equal(toolResultSummary({ content: [text(`dsn ${secret}`)] }, masking, CWD), "dsn [REDACTED]");
  // 秘密値がパスの内側にあるときは、畳んだ後の文字列にもマスクが掛かる
  const key = "sk-display-dummy-0123456789";
  const withKey = createSecretMasker([key]);
  assert.equal(toolArgsSummary({ path: `${CWD}/keys/${key}.txt` }, withKey, CWD), `./keys/${REDACTED}.txt`);
  assert.equal(
    toolResultSummary({ content: [text(`saved ${CWD}/out.json with ${key}`)] }, withKey, CWD),
    `saved ./out.json with ${REDACTED}`,
  );
  // JSON フォールバックは値ごとにマスクするため、秘密値の `"` が JSON エスケープで一致しなくなっても落ちる
  const quoted = 'sk-"quoted"-0123456789';
  assert.equal(
    toolArgsSummary({ unknown: `note ${quoted}` }, createSecretMasker([quoted]), CWD),
    '{"unknown":"note [REDACTED]"}',
  );
  // キーに現れた秘密値は文字列化した後のマスクが落とす
  assert.equal(toolArgsSummary({ [key]: 1 }, withKey, CWD), '{"[REDACTED]":1}');
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
