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
const composer = source("../src/components/Composer.tsx");
const messageView = source("../src/components/chat/MessageView.tsx");
const toolHistory = source("../src/components/chat/ToolHistory.tsx");

test("compact と overlay の左バーは単一列 Grid を grid-cols-1 で幅を拘束する", () => {
  assert.ok(
    app.includes(
      'sidebarDocked ? "grid-cols-[var(--sidebar-width)_minmax(0,1fr)] grid-rows-1" : "grid-cols-1 grid-rows-1"',
    ),
  );
  assert.ok(app.includes('filesPanelOpen ? "grid-cols-[minmax(0,1fr)_var(--session-files-width)]" : "grid-cols-1"'));
  assert.ok(app.includes("grid min-h-0 min-w-0 grid-cols-1 grid-rows-1 overflow-hidden"));
  assert.ok(app.includes("grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"));
});

test("compact bar と chat の直接子は intrinsic width より狭く縮められる", () => {
  assert.ok(compactBar.includes("grid min-w-0 grid-cols-1 border-b"));
  assert.ok(compactBar.includes("flex min-w-0 items-center"));
  assert.ok(chatArea.includes("min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto"));
  assert.ok(chatArea.includes("mx-auto w-full min-w-0"));
  assert.ok(chatArea.includes('"virtual-canvas relative mt-2 w-full"'));
  assert.ok(chatArea.includes('"virtual-item"'));
  assert.ok(messageView.includes('"group/bubble flex min-w-0"'));
  assert.ok(messageView.includes('animate ? "animate-rise" : ""'));
});

// Firefox と iOS Safari の select は、選択肢の幅 (= intrinsic width) を auto 列の item の
// 最小サイズとして使う。入力欄も cols 既定値の intrinsic 幅を下限に持つため、どちらも
// minmax(0, 1fr) と min-w-0 で拘束しないと form とボタンが viewport の外へ出る
test("composer の form と中身は intrinsic width で広がらない", () => {
  assert.ok(composer.includes('"grid grid-cols-1 rounded-xl border bg-panel/90 shadow-panel"'));
  assert.ok(composer.includes('landscape ? "grid-cols-2" : "grid-cols-1"'));
  assert.ok(composer.includes("min-w-0 flex-1 resize-none"));
});

// Grid item の min-width: auto が残ると、break-words は intrinsic 幅を縮めないため折り返さず、
// カードの外まで広がって ChatArea の overflow-x-hidden で切れる (横スクロールもできない)
test("ツール履歴の引数と出力はカード幅で折り返す", () => {
  assert.ok(toolHistory.includes('<code className="min-w-0 break-words whitespace-pre-wrap">{card.args}</code>'));
  assert.ok(
    toolHistory.includes('<pre className="m-0 min-w-0 font-mono break-words whitespace-pre-wrap">{card.output}</pre>'),
  );
});
