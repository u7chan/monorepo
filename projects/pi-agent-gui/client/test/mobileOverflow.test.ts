// compact の単一列 Grid が内容の max-content 幅に引っ張られると、画面全体が横へはみ出す。
// jsdom を使わない方針のため、横幅を拘束するクラスがシェル境界に残っていることをソースで固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const app = source("../src/App.tsx");
const compactBar = source("../src/components/CompactBar.tsx");
const chatArea = source("../src/components/ChatArea.tsx");
const messageView = source("../src/components/chat/MessageView.tsx");

test("compact の単一列 Grid は minmax(0, 1fr) 相当の grid-cols-1 で幅を拘束する", () => {
  assert.ok(app.includes('compact ? "grid-cols-1 grid-rows-1"'));
  assert.ok(app.includes('filesPanelOpen ? "grid-cols-[minmax(0,1fr)_min(360px,30vw)]" : "grid-cols-1"'));
  assert.ok(app.includes('grid min-h-0 min-w-0 grid-cols-1 grid-rows-1 overflow-hidden'));
  assert.ok(
    app.includes('grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden'),
  );
});

test("compact bar と chat の直接子は intrinsic width より狭く縮められる", () => {
  assert.ok(compactBar.includes('grid min-w-0 grid-cols-1 border-b'));
  assert.ok(compactBar.includes('flex min-w-0 items-center'));
  assert.ok(chatArea.includes('min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto'));
  assert.ok(chatArea.includes('grid min-w-0 grid-cols-1 pt-2'));
  assert.ok(messageView.includes('group/bubble flex min-w-0 animate-rise'));
});
