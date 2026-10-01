// セッション中のエージェント欄 (読み取り専用のラベル) を固定する。
// エージェント定義はセッション作成時に promptSnapshot へ固定されるため、会話の途中では変えられない。
// 選べるのは未作成チャットだけで、セッションを開いている間はプルダウンの位置にラベルを出す。
//   1. ラベルは名前とアイコンだけを出し、button / listbox / popover を持たない
//   2. 欄の枠と箱は AgentPicker のトリガーと同じクラスで、sizer も全候補を重ねる
//      (最初の送信でプルダウンから入れ替わるときに行の幅と高さを動かさない)
//   3. AgentField は sessionAgent の有無だけでラベルとプルダウンを切り替える
//   4. App はセッションを開いているときだけラベルを渡し、名前はセッションのスナップショットを使う
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentField } from "../src/components/composer/AgentField";
import { AgentLabel } from "../src/components/composer/AgentLabel";
import { AgentPicker } from "../src/components/composer/AgentPicker";
import type { AgentDef } from "../src/types";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function agent(id: string, name: string): AgentDef {
  return { id, name, description: "", systemPrompt: "", skillIds: [] };
}

const agents = [agent("a", "ずんだもん"), agent("b", "コードレビュー"), agent("c", "汎用アシスタント")];

/** `<tag ... class="...">` の class を語の集合にする (属性の並びに依存しない) */
function classesOf(tag: string, html: string): string[] {
  const match = new RegExp(`<${tag}[^>]*class="([^"]*)"`).exec(html);
  assert.ok(match, `${tag} の class を切り出せない`);
  return match[1].split(/\s+/).sort();
}

/** 出現順の span の class 一覧 */
function spanClasses(html: string): string[][] {
  return [...html.matchAll(/<span[^>]*class="([^"]*)"/g)].map((match) => match[1].split(/\s+/).sort());
}

test("描画: ラベルは名前とアイコンだけで、選べる見た目を持たない", () => {
  const html = renderToStaticMarkup(
    createElement(AgentLabel, { agents, name: "コードレビュー", icon: undefined, compact: false }),
  );
  assert.ok(html.includes("コードレビュー"), "エージェント名が出ていない");
  assert.ok(html.includes("<svg"), "アイコンのフォールバック (SparkleIcon) が出ていない");
  for (const interactive of ["<button", "popover=", "aria-haspopup", "role=", "tabindex"]) {
    assert.ok(!html.includes(interactive), `ラベルが選べる見た目を持っている: ${interactive}`);
  }
});

test("描画: 欄の枠と箱は AgentPicker のトリガーと同じで、sizer も同じ", () => {
  const label = renderToStaticMarkup(
    createElement(AgentLabel, { agents, name: "コードレビュー", icon: undefined, compact: false }),
  );
  const picker = renderToStaticMarkup(
    createElement(AgentPicker, { agents, agentId: "b", compact: false, onChangeAgent: () => {} }),
  );
  // 枠は先頭の span (相対配置と幅の決め方)、箱はプルダウンの trigger (button) と比べる
  assert.deepEqual(spanClasses(label)[0], classesOf("span", picker), "欄の枠のクラスが違う");
  const labelBox = spanClasses(label).find((classes) => classes.includes("field"));
  assert.ok(labelBox, "ラベルの箱の span が見つからない");
  const pickerBox = classesOf("button", picker).filter(
    (name) => !["peer", "cursor-pointer", "disabled:cursor-not-allowed", "disabled:opacity-55"].includes(name),
  );
  assert.deepEqual(labelBox, pickerBox, "欄の箱のクラスが違う (入れ替わりで行が動く)");
  // 幅は最長の候補名で決める (sizer を同じ数だけ重ねる)
  const sizers = [...label.matchAll(/<span aria-hidden="true"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(
    sizers,
    agents.map((item) => item.name),
    "全候補が sizer として重なっていない",
  );
});

test("配線: AgentField は sessionAgent の有無だけでラベルとプルダウンを切り替える", () => {
  const inSession = renderToStaticMarkup(
    createElement(AgentField, {
      agents,
      agentId: "b",
      compact: false,
      sessionAgent: { name: "コードレビュー" },
      onChangeAgent: () => {},
    }),
  );
  assert.ok(inSession.includes("コードレビュー"), "セッション中の名前が出ていない");
  assert.ok(!inSession.includes('aria-haspopup="listbox"'), "セッション中もプルダウンを出している");

  const newChat = renderToStaticMarkup(
    createElement(AgentField, { agents, agentId: "b", compact: false, onChangeAgent: () => {} }),
  );
  assert.ok(newChat.includes('aria-haspopup="listbox"'), "未作成チャットで選べない");
});

test("配線: App はセッションを開いているときだけラベルを渡し、名前はスナップショットを使う", () => {
  const app = read("src/App.tsx");
  assert.ok(
    app.includes(
      'const composerAgent = app.sessionId ? { name: barAgentName ?? "", icon: chatAgentIcon } : undefined;',
    ),
    "未作成チャットでもラベルを出している (またはセッション中にプルダウンを出している)",
  );
  assert.ok(app.includes("sessionAgent={composerAgent}"), "Composer へラベルを渡していない");
  // 定義が消えたセッションでも壊れないよう、名前はセッションのスナップショットを正にする
  assert.ok(
    app.includes("const barAgentName = activeSession?.agentName || app.selectedAgent?.name;"),
    "ラベルの名前がセッションのスナップショットではない",
  );
  assert.ok(
    app.includes("const chatAgentIcon = agentIconOf(app.agents, app.chat.sessionAgentId ?? app.agentId);"),
    "ラベルのアイコンがセッションのエージェントを見ていない",
  );
  // セッション中の選択操作は残さない (入口は未作成チャットの選択だけで、作成先も動かさない)
  assert.ok(app.includes("handleNewChat(agentId, app.selectedProjectId)"), "エージェント選択の入口が違う");
  assert.ok(!app.includes("activeSession?.projectId"), "セッションの所属を作成先へ引き継いでいる");
});
