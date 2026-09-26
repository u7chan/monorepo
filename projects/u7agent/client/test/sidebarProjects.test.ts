// サイドバーのプロジェクト開閉 (開いている cwd の集合) の保存 schema と配線。client に DOM
// テスト基盤が無いため、保存値の扱いは純関数と MemoryStorage、Sidebar の配線はソース走査、
// 行の描画は react-dom/server で固定する。
//   1. 既定は畳み。保存するのは「開いたプロジェクト」の cwd だけで、未操作のプロジェクトは
//      エントリを作らない (id ではなく cwd をキーにするのは、削除 → 再登録を跨ぐため)
//   2. 壊れた JSON / 未知 version は全体を捨て、配列の非文字列・空文字・重複は 1 件ずつ落とす。
//      上限 20 件を超えた分は先に書かれた cwd から落とす (末尾 = 今回書いた cwd)
//   3. 保存領域の例外は握り、メモリ側を正にして同一セッション内の往復を保つ
//   4. 書き込みはクリックハンドラで行う (compact のドロワーの ＋ は Sidebar ごと unmount するため
//      Effect では落ちる)。＋ はその行も開いてから newChat する
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ProjectRow } from "../src/components/sidebar/ProjectRow";
import {
  createSidebarProjectsStore,
  decodeExpandedProjects,
  encodeExpandedProjects,
  SIDEBAR_PROJECTS_KEY,
  SIDEBAR_PROJECTS_LIMIT,
  SIDEBAR_PROJECTS_VERSION,
  type SidebarProjectsStorage,
} from "../src/lib/sidebarProjects";
import type { Project, SessionSummary } from "../src/types";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

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

const stored = (expanded: unknown, version: unknown = SIDEBAR_PROJECTS_VERSION): string =>
  JSON.stringify({ version, expanded });

class MemoryStorage implements SidebarProjectsStorage {
  value: string | null = null;
  removals = 0;
  lastKey: string | null = null;

  getItem(key: string): string | null {
    this.lastKey = key;
    return this.value;
  }

  setItem(key: string, next: string): void {
    this.lastKey = key;
    this.value = next;
  }

  removeItem(key: string): void {
    this.lastKey = key;
    this.value = null;
    this.removals += 1;
  }
}

test("保存キー・version・上限は export 定数で固定する", () => {
  assert.equal(SIDEBAR_PROJECTS_KEY, "u7agent-expanded-projects");
  assert.equal(SIDEBAR_PROJECTS_VERSION, 1);
  assert.equal(SIDEBAR_PROJECTS_LIMIT, 20);
});

test("encode / decode は開いている cwd を往復する", () => {
  const expanded = ["work/hello", "projects/app"];
  assert.deepEqual(decodeExpandedProjects(encodeExpandedProjects(expanded)), expanded);
  assert.equal(
    encodeExpandedProjects(expanded),
    JSON.stringify({ version: SIDEBAR_PROJECTS_VERSION, expanded }),
    "保存する形 (version 付き) が変わっている",
  );
  // 保存値が無い / 空 / JSON が壊れている / object でない
  assert.deepEqual(decodeExpandedProjects(null), []);
  assert.deepEqual(decodeExpandedProjects(""), []);
  assert.deepEqual(decodeExpandedProjects("{"), []);
  assert.deepEqual(decodeExpandedProjects(JSON.stringify(expanded)), []);
  // version が違う / 無い (未知 version は全体を捨てる)
  assert.deepEqual(decodeExpandedProjects(stored(expanded, SIDEBAR_PROJECTS_VERSION + 1)), []);
  assert.deepEqual(decodeExpandedProjects(JSON.stringify({ expanded })), []);
  // 配列でない
  assert.deepEqual(decodeExpandedProjects(JSON.stringify({ version: SIDEBAR_PROJECTS_VERSION, expanded: {} })), []);
});

test("配列の非文字列・空文字・重複は落とし、上限を超えた分は先に書かれた cwd から落とす", () => {
  assert.deepEqual(decodeExpandedProjects(stored(["a", 1, "", null, "a", "b", {}, "b"])), ["a", "b"]);
  // 上限ちょうどは全部残り、超えた分だけ先頭から落ちる (末尾 = 今回書いた cwd)
  const many = Array.from({ length: SIDEBAR_PROJECTS_LIMIT + 3 }, (_, index) => `p/${index}`);
  const decoded = decodeExpandedProjects(stored(many));
  assert.equal(decoded.length, SIDEBAR_PROJECTS_LIMIT);
  assert.deepEqual(decoded, many.slice(-SIDEBAR_PROJECTS_LIMIT));
  assert.equal(decoded.at(-1), `p/${SIDEBAR_PROJECTS_LIMIT + 2}`);
});

test("store は 1 キーを読み書きし、空になったらキーごと消す", () => {
  const storage = new MemoryStorage();
  const store = createSidebarProjectsStore(storage);
  assert.deepEqual(store.read(), []);
  store.write(["work/hello"]);
  assert.equal(storage.lastKey, SIDEBAR_PROJECTS_KEY, "別のキーへ書いている");
  assert.deepEqual(JSON.parse(storage.value ?? ""), {
    version: SIDEBAR_PROJECTS_VERSION,
    expanded: ["work/hello"],
  });
  assert.deepEqual(store.read(), ["work/hello"]);
  // 保存値が壊れていれば読まない (undefined でない空配列として扱う)
  storage.value = "{";
  assert.deepEqual(createSidebarProjectsStore(storage).read(), []);
  store.write([]);
  assert.equal(storage.value, null, "畳み切ったのにキーが残っている");
  assert.equal(storage.removals, 1);
  assert.deepEqual(store.read(), []);
});

test("store は読み手が捨てる形を書かず、上限を超えたら先頭から落とす", () => {
  const storage = new MemoryStorage();
  const store = createSidebarProjectsStore(storage);
  const expanded = Array.from({ length: SIDEBAR_PROJECTS_LIMIT }, (_, index) => `p/${index}`);
  store.write([...expanded, "p/20"]);
  const saved = JSON.parse(storage.value ?? "");
  assert.deepEqual(saved.expanded, [...expanded.slice(1), "p/20"]);
  assert.deepEqual(store.read(), saved.expanded);
  // 非文字列・空文字・重複も書かない (次の mount で開閉が変わらない)
  store.write(["", "a", "a", "b"]);
  assert.deepEqual(JSON.parse(storage.value ?? ""), { version: SIDEBAR_PROJECTS_VERSION, expanded: ["a", "b"] });
  assert.deepEqual(store.read(), ["a", "b"]);
});

test("保存領域が使えない環境でも操作を止めない (session 内のメモリで保つ)", () => {
  const throwing: SidebarProjectsStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  const store = createSidebarProjectsStore(throwing);
  assert.deepEqual(store.read(), []);
  store.write(["work/hello"]);
  assert.deepEqual(store.read(), ["work/hello"]);
  // 畳み切ると空に戻る (書き込みが失敗してもメモリ側が正)
  store.write([]);
  assert.deepEqual(store.read(), []);
  // storage が無い (window が無い) ときも同じ
  const none = createSidebarProjectsStore(null);
  none.write(["work/hello"]);
  assert.deepEqual(none.read(), ["work/hello"]);
});

test("Sidebar は既定 closed で、開閉を singleton の store へ write-through する", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  // 既定は畳み (保存値が無ければ空 = 全行 closed)。旧 collapsed の Record は持たない
  assert.ok(
    sidebar.includes("useState<string[]>(() => sidebarProjectsStore.read())"),
    "保存値からの lazy 初期化でない (既定が畳みでない)",
  );
  assert.ok(!sidebar.includes("collapsed"), "旧 collapsed state が残っている");
  assert.ok(sidebar.includes("open={expanded.includes(group.project.cwd)}"), "open が保存集合から決まっていない");
  // store は singleton を使う (Sidebar が自分で組み立てると、同じキーに複数のメモリが並ぶ)
  assert.ok(
    sidebar.includes('import { sidebarProjectsStore } from "../lib/sidebarProjects";'),
    "lib/sidebarProjects を import していない",
  );
  assert.ok(!sidebar.includes("createSidebarProjectsStore"), "Sidebar が store を組み立てている");
  assert.ok(sidebar.includes("sidebarProjectsStore.write(next)"), "store へ書いていない");
  // ＋ はその行を開いてから newChat する (開く前に newChat すると、ドロワーでは先に閉じて書けない)
  const newChat = sidebar.slice(sidebar.indexOf("onNewChat={() =>"), sidebar.indexOf("onDelete={() =>"));
  assert.ok(newChat.includes("setProjectOpen(group.project.cwd, true)"), "＋ がその行を開いていない");
  assert.ok(
    newChat.indexOf("setProjectOpen(group.project.cwd, true)") <
      newChat.indexOf("newChat(undefined, group.project.id)"),
    "＋ がその行を開く前に newChat している",
  );
  // Effect では書かない (Effect 本文だけを見る。useEffect が無いことを断定はしない)
  const bodies = effectBodies(sidebar);
  assert.equal(bodies.length, (sidebar.match(/useEffect\(/g) ?? []).length, "useEffect の抽出に失敗した");
  assert.ok(
    bodies.every((body) => !body.includes("sidebarProjectsStore")),
    "Effect で store を書いている",
  );
});

const project: Project = { id: "p-1", name: "hello", cwd: "work/hello", createdAt: 0 };
const session: SessionSummary = {
  sessionId: "s-1",
  title: "既存の会話",
  agentId: "agent-general",
  agentName: "汎用アシスタント",
  status: "idle",
  queueDepth: 0,
  messageCount: 1,
  createdAt: 0,
  lastUsedAt: 0,
  projectId: "p-1",
};

function renderProjectRow(open: boolean): string {
  return renderToStaticMarkup(
    createElement(ProjectRow, {
      project,
      sessions: [session],
      agents: [],
      sessionId: "s-1",
      open,
      onToggle: () => {},
      onNewChat: () => {},
      onDelete: () => {},
      onSelectSession: () => {},
      onDeleteSession: () => {},
    }),
  );
}

test("ProjectRow は畳みで aria-expanded=false になり、配下セッションを出さない", () => {
  const closed = renderProjectRow(false);
  assert.ok(closed.includes('aria-expanded="false"'), "畳みで aria-expanded が false でない");
  assert.ok(!closed.includes("既存の会話"), "畳みで配下セッションを出している");
  assert.ok(!closed.includes("セッションはありません"), "畳みで空の案内を出している");
  assert.ok(closed.includes('aria-label="展開する"'), "畳みの操作が展開になっていない");

  const opened = renderProjectRow(true);
  assert.ok(opened.includes('aria-expanded="true"'), "展開で aria-expanded が true でない");
  assert.ok(opened.includes("既存の会話"), "展開で配下セッションが出ない");
});
