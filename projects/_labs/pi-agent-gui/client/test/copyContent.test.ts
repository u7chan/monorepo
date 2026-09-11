// ツールコールのコピーテキスト整形のテスト。
import assert from "node:assert/strict";
import test from "node:test";
import { toolCallCopyText } from "../src/lib/copy-content";

test("name のみの場合は tool 行のみ", () => {
  assert.equal(toolCallCopyText({ name: "read", args: "", output: "" }), "tool: read");
});

test("args / output を含めて整形する", () => {
  const text = toolCallCopyText({ name: "bash", args: "ls -la", output: "total 0" });
  assert.equal(text, "tool: bash\nargs: ls -la\noutput:\ntotal 0");
});

test("output が複数行でもそのまま保持する", () => {
  const text = toolCallCopyText({ name: "read", args: "", output: "line1\nline2" });
  assert.equal(text, "tool: read\noutput:\nline1\nline2");
});
