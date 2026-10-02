import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPicker } from "../src/components/composer/AgentPicker";
import {
  AGENT_PICKER_GAP,
  AGENT_PICKER_MARGIN,
  agentPickerPlacement,
  nextAgentOptionIndex,
} from "../src/lib/agentPicker";
import type { AgentDef } from "../src/types";

const viewport = { width: 1000, height: 800 };
const anchor = { top: 100, left: 50, right: 250, bottom: 130 };

test("位置: 既定は欄の左下で、左端をそろえる", () => {
  const { left, top } = agentPickerPlacement(anchor, { width: 120, height: 90 }, viewport);
  assert.equal(left, anchor.left);
  assert.equal(top, anchor.bottom + AGENT_PICKER_GAP);
});

test("位置: 下に入らなければ上へ倒す", () => {
  const low = { top: 250, left: 50, right: 250, bottom: 280 };
  const { top } = agentPickerPlacement(low, { width: 120, height: 100 }, { width: 1000, height: 300 });
  assert.equal(top, low.top - AGENT_PICKER_GAP - 100);
});

test("位置: 左右と上下を viewport の内側へ clamp する", () => {
  const left = agentPickerPlacement({ ...anchor, left: -30, right: 170 }, { width: 120, height: 90 }, viewport);
  assert.equal(left.left, AGENT_PICKER_MARGIN);
  const right = agentPickerPlacement({ ...anchor, left: 950, right: 990 }, { width: 120, height: 90 }, viewport);
  assert.equal(right.left, viewport.width - 120 - AGENT_PICKER_MARGIN);
  // 上下どちらにも入らない (リストが viewport より大きい) ときは下のままで内側へ寄せる
  const tall = agentPickerPlacement(
    { top: 30, left: 50, right: 250, bottom: 60 },
    { width: 120, height: 150 },
    { width: 1000, height: 200 },
  );
  assert.equal(tall.top, 200 - 150 - AGENT_PICKER_MARGIN);
});

test("キーボード: ↑↓ は端で止まり、Home / End は先頭 / 末尾へ入る", () => {
  assert.equal(nextAgentOptionIndex(0, 3, "next"), 1);
  assert.equal(nextAgentOptionIndex(2, 3, "next"), 2);
  assert.equal(nextAgentOptionIndex(2, 3, "previous"), 1);
  assert.equal(nextAgentOptionIndex(0, 3, "previous"), 0);
  assert.equal(nextAgentOptionIndex(1, 3, "first"), 0);
  assert.equal(nextAgentOptionIndex(1, 3, "last"), 2);
  // フォーカスが項目の外 (-1) なら端へ入る。空のリストは移動先が無い
  assert.equal(nextAgentOptionIndex(-1, 3, "next"), 0);
  assert.equal(nextAgentOptionIndex(-1, 3, "previous"), 2);
  assert.equal(nextAgentOptionIndex(-1, 3, "first"), 0);
  assert.equal(nextAgentOptionIndex(-1, 3, "last"), 2);
  assert.equal(nextAgentOptionIndex(0, 0, "next"), -1);
  assert.equal(nextAgentOptionIndex(0, 0, "last"), -1);
});

function agent(id: string, name: string): AgentDef {
  return { id, name, description: "", systemPrompt: "", skillIds: [] };
}

const agents = [agent("a", "ずんだもん"), agent("b", "コードレビュー"), agent("c", "汎用アシスタント")];

test("描画: トリガーが選択中の名前入りの aria-label と listbox の参照を持つ", () => {
  const html = renderToStaticMarkup(
    createElement(AgentPicker, { agents, agentId: "b", compact: false, onChangeAgent: () => {} }),
  );
  assert.match(html, /type="button"/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="エージェントを選択（コードレビュー）"/);
  assert.match(html, /popover="auto"/);
  const pickerId = html.match(/id="([^"]+)-trigger"/)?.[1];
  assert.ok(pickerId, "トリガーの id を切り出せない");
  assert.ok(html.includes(`aria-controls="${pickerId}"`), "トリガーがリストを参照していない");
  assert.ok(html.includes(`id="${pickerId}"`), "リストがトリガーの参照先に無い");
  assert.ok(html.includes(`aria-labelledby="${pickerId}-trigger"`), "リストの読み上げ名がトリガーの id でない");
});

test("描画: 行は候補の順に並び、選択中の行だけ aria-selected=true になる", () => {
  const html = renderToStaticMarkup(
    createElement(AgentPicker, { agents, agentId: "b", compact: false, onChangeAgent: () => {} }),
  );
  const options = html.slice(html.indexOf('role="listbox"')).split("<button").slice(1);
  assert.equal(options.length, agents.length, "行数が候補数と違う");
  options.forEach((option, index) => {
    assert.ok(option.includes('role="option"'), "行が option でない");
    assert.ok(option.includes('tabindex="-1"'), "行がタブストップに入っている");
    assert.equal(option.includes('aria-selected="true"'), agents[index].id === "b", "選択の印が違う");
    assert.ok(option.includes(agents[index].name), "行の並び順が候補の順と違う");
    assert.ok(!option.includes("aria-current"), "option に aria-current を出している");
  });
});

test("描画: 候補が無いとトリガーが無効になり、名前入りの読み上げ名を出さない", () => {
  const html = renderToStaticMarkup(
    createElement(AgentPicker, { agents: [], agentId: "", compact: true, onChangeAgent: () => {} }),
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-label="エージェントを選択"/);
  assert.ok(!html.includes("（"), "選択中の名前が無いのに名前入りの読み上げ名を出している");
});
