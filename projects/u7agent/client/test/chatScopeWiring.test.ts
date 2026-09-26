// 作業先の表示と、作業フォルダの導線 (既定オープン / compact のシートの閉じ方) の配線。
// client に DOM テスト基盤が無いため、バーと空状態の描画は react-dom/server、配線はソース走査で固定する。
//   1. 既定オープン (プロジェクト配下なら開) を適用するのは起動時の初期化と App の handleNewChat だけ。
//      派生 state (projects 一覧の到着や root の解決) を契機にしない = sessionFiles を読む Effect を置かない
//   2. サイドバー / ドロワー / エージェント切替の 3 入口は handleNewChat を通り、useSessions の
//      内部フォールバック (newChat の直接呼び出し 6 箇所) は通らない
//   3. compact のシートは Effect ではなく描画中の同期で閉じ、監視キーは compact / mainView / filesRoot
//      (route オブジェクト全体は比べない)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { CompactBar } from "../src/components/CompactBar";
import { Topbar } from "../src/components/Topbar";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";
import type { ChatScope } from "../src/lib/chatScope";

const IDLE: RuntimeStatus = { text: "", error: false };
const PROJECT_SCOPE: ChatScope = { label: "work/hello", project: true, root: "work/hello" };

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const app = read("src/App.tsx");
const sessions = read("src/hooks/useSessions.ts");
const chatArea = read("src/components/ChatArea.tsx");

/** useEffect の呼び出し本体 (括弧の対応で切り出す)。見つけた数も返し、取りこぼしを検出できるようにする */
function effectBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/useEffect\(/g)) {
    const open = source.indexOf("(", match.index);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          bodies.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

test("バーは作業先を出し、空状態の見出しは作業先の有無で分岐する", () => {
  const topbar = renderToStaticMarkup(
    createElement(Topbar, {
      scope: PROJECT_SCOPE,
      runtimeStatus: IDLE,
      notify: { on: false, deliverable: true, onToggle: () => {} },
    }),
  );
  assert.ok(topbar.includes("work/hello"), "作業先チップが出ていない");
  assert.ok(topbar.includes('title="work/hello"'), "チップに作業フォルダが出ていない");
  assert.ok(
    topbar.indexOf("LOCAL WORKSPACE") < topbar.indexOf("work/hello"),
    "チップが eyebrow より左にある (作業先は LOCAL WORKSPACE の右)",
  );

  const compact = renderToStaticMarkup(
    createElement(CompactBar, {
      mode: "portrait",
      title: "会話",
      agentName: "実装担当",
      scope: PROJECT_SCOPE,
      runtimeStatus: IDLE,
      notify: { on: false, deliverable: true, onToggle: () => {} },
      onOpenNav: () => {},
    }),
  );
  assert.ok(compact.includes("work/hello · 実装担当"), "作業先がエージェント名に前置されていない");

  // ChatArea は api.ts (location を読む) を引き込むため node では描画できない。見出しの分岐はソースで固定する
  assert.ok(
    chatArea.includes('{scope.project ? `${scope.label} で作業します` : "プロジェクトの相棒です"}'),
    "空状態の見出しが作業先になっていない",
  );
  assert.ok(
    chatArea.includes("コードを読んだり、ファイルを編集したり、コマンドを実行できます。"),
    "空状態の説明文が変わっている (プロジェクト配下でも同じ行を出す)",
  );
});

test("既定オープンを適用するのは起動時の初期化と handleNewChat だけ", () => {
  const calls = app.match(/sessionFilesDefaultOpen\(/g) ?? [];
  assert.equal(calls.length, 2, "既定オープンの呼び出しが「初期化 + handleNewChat」以外にある");
  assert.ok(
    /useState\(\(\) =>\s*sessionFilesDefaultOpen\(\{\s*compact,\s*projectId: app\.selectedProjectId,?\s*\}\),?\s*\)/.test(
      app,
    ),
    "起動時の初期値が作成先から決まっていない (projects 一覧は見ない)",
  );
  assert.ok(
    app.includes("sessionFilesDefaultOpen({ compact, projectId: projectId ?? app.selectedProjectId })"),
    "新規会話の入口が「そのときの作成先」で既定を決めていない",
  );
  // 派生 state (一覧の到着 / root の解決 / layout) を契機に開閉しない
  const bodies = effectBodies(app);
  assert.equal(bodies.length, (app.match(/useEffect\(/g) ?? []).length, "useEffect の抽出に失敗した");
  assert.ok(
    bodies.every((body) => !body.includes("sessionFiles")),
    "Effect (派生 state) を契機に作業フォルダを開閉している",
  );
});

test("新規会話の 3 入口は handleNewChat を通り、内部フォールバックは通らない", () => {
  assert.ok(app.includes("newChat: handleNewChat,"), "docked の Sidebar が handleNewChat を通っていない");
  assert.ok(app.includes("handleNewChat(agentId, projectId);"), "ドロワーの入口が handleNewChat を通っていない");
  assert.ok(app.includes("handleNewChat(agentId);"), "エージェント切替が handleNewChat を通っていない");
  assert.equal((app.match(/app\.newChat\(/g) ?? []).length, 1, "handleNewChat 以外から newChat を呼んでいる");
  // 内部フォールバック (開けない / 削除 / SSE 閉鎖 / リンク解決失敗) は useSessions が直接呼ぶ
  assert.equal(
    (sessions.match(/newChatRef\.current\(\)/g) ?? []).length,
    6,
    "useSessions の内部フォールバックの数が変わった (配線の前提を見直す)",
  );
  assert.ok(!sessions.includes("sessionFilesDefaultOpen"), "内部フォールバックが既定オープンを適用している");
});

test("compact のシートは描画中の同期で閉じ、監視キーは compact / mainView / filesRoot", () => {
  assert.ok(
    app.includes(
      "if (sheetScope.compact !== compact || sheetScope.view !== mainView || sheetScope.root !== filesRoot) {",
    ),
    "シートを閉じる契機 (compact / mainView / filesRoot) が変わっている",
  );
  assert.ok(app.includes("setSessionFilesSheetOpen(false);"), "シートを閉じていない");
  assert.ok(app.includes("useState(() => ({ compact, view: mainView, root: filesRoot }))"), "監視キーの初期値が違う");
  // route オブジェクト全体を比べない (`/s/<id>` が `/` へ畳まれるだけでは閉じない)
  assert.ok(!app.includes("sheetScope.route") && !app.includes("[route]"), "route オブジェクトを監視している");
  // Effect で閉じると、子の showModal() が先に走って 1 フレーム modal が出る
  const bodies = effectBodies(app);
  assert.ok(
    bodies.every((body) => !body.includes("setSessionFilesSheetOpen")),
    "シートの開閉を Effect で行っている",
  );
  // 開閉は面ごとに分ける (compact で開いたシートが desktop のパネルに出ない)
  assert.ok(app.includes('const filesPanelOpen = !compact && filesRoot !== "" && sessionFilesOpen;'));
  assert.ok(app.includes('const filesSheetOpen = compact && filesRoot !== "" && sessionFilesSheetOpen;'));
  assert.equal((app.match(/\n\s+scope=\{scope\}/g) ?? []).length, 3, "作業先をバーと空状態へ渡していない");
});
