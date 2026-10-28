// 設定 → エージェント（/settings/agents）の詳細ヘッダの描画契約。一覧を並べて見せている間は
// 切り替えが行でできるのでピッカーを出さず、現在名だけを見出しにする（同じ切り替えを 2 つ持たせない）。
// ピッカーが戻ると、一覧の行とピッカーのどちらでも対象が変わり、ヘッダの幅も名前に食われる。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { AgentDef, CatalogResponse } from "../src/types";

// api.ts (location.origin を読む) と useLayoutMode (viewport を読む) を辿るため、node では最小の shim を置く
globalThis.location ??= { origin: "http://localhost" } as Location;
const viewport = { innerWidth: 1440, innerHeight: 900 };
(globalThis as unknown as { window: unknown }).window = {
  get innerWidth() {
    return viewport.innerWidth;
  },
  get innerHeight() {
    return viewport.innerHeight;
  },
  addEventListener() {},
  removeEventListener() {},
};
const { AgentSettingsPage } = await import("../src/components/AgentSettingsPage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

function agent(id: string, name: string): AgentDef {
  return { id, name, description: `${name} の説明`, systemPrompt: "" };
}

const catalog: CatalogResponse = {
  agents: [agent("a1", "アルファ"), agent("a2", "ベータ")],
  builtinAgent: null,
  builtinSkills: [],
  tools: [],
  prompts: [],
};

function render(agentId: string): string {
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(AgentSettingsPage, {
        catalog,
        agentId,
        refreshCatalog: async () => catalog,
        applyAgentOrder: () => {},
        modelOptions: [],
        onBack: () => {},
        onOpenNav: () => {},
      }),
    ),
  );
}

test("一覧を並べる幅では最初から選ばれたエージェントのピッカーを出さない", () => {
  viewport.innerWidth = 1440;
  const html = render("a1");
  assert.ok(!html.includes("エージェントを切り替える"), "並列表示なのにピッカーが出ている");
  // 見出しは現在名。一覧の行を選べば切り替わるので、切り替えの手段は 1 つで足りる
  assert.ok(html.includes("アルファ"));
});

test("詳細のヘッダは現在名を sr-only の h2 として持つ", () => {
  // 詳細の面は独立した節なので、現在名の h2 を持つ (singleColumn ではページの h2 が畳まれるため、
  // この h2 が画面に残る唯一の見出しになる)
  viewport.innerWidth = 1440;
  const html = render("a1");
  // 見出し移動の起点が消えないよう、現在名を sr-only の h2 として置く
  const heading = html.match(/<h2 class="sr-only">[^<]*<\/h2>/g) ?? [];
  assert.equal(heading.length, 1, "詳細のヘッダに h2 が無い");
  assert.ok(heading[0]?.includes("アルファ"));
});
