import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SingleColumnBar } from "../src/components/SingleColumnBar";
import { Topbar } from "../src/components/Topbar";
import type { ChatScope } from "../src/lib/chatScope";
import { serveProps } from "./serve-fixture";

test("バーはプロジェクトの作業先を表示する", () => {
  const scope: ChatScope = { label: "work/hello", project: true, root: "work/hello" };
  const props = {
    serve: serveProps(),
    scope,
    runtimeStatus: { text: "", error: false },
    notify: { on: false, ring: 0, deliverable: true, onToggle: () => {} },
  };
  const topbar = renderToStaticMarkup(createElement(Topbar, props));
  assert.ok(topbar.includes("work/hello"));
  assert.ok(topbar.includes('title="work/hello"'));
  const singleColumn = renderToStaticMarkup(
    createElement(SingleColumnBar, {
      ...props,
      mode: "portrait",
      title: "会話",
      agentName: "実装担当",
      onOpenNav: () => {},
    }),
  );
  assert.ok(singleColumn.includes("work/hello · 実装担当"));
});
