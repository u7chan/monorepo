import assert from "node:assert/strict";

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
  projectDeleteConfirmRequest,
  type SidebarProjectsStorage,
} from "../src/lib/sidebarProjects";
import type { Project, SessionSummary } from "../src/types";

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
  pinned: false,
  projectId: "p-1",
};

function renderProjectRow(open: boolean, sessions: SessionSummary[] = [session]): string {
  return renderToStaticMarkup(
    createElement(ProjectRow, {
      project,
      sessions,
      agents: [],
      sessionId: "s-1",
      open,
      onToggle: () => {},
      onNewChat: () => {},
      onDelete: () => {},
      onSelectSession: () => {},
      onRenameSession: () => {},
      onDeleteSession: () => {},
      onTogglePinnedSession: () => {},
    }),
  );
}

test("ProjectRow は畳みで aria-expanded=false になり、配下セッションを操作させない", () => {
  const closed = renderProjectRow(false);
  assert.ok(closed.includes('aria-expanded="false"'), "畳みで aria-expanded が false でない");
  assert.ok(closed.includes('data-open="false"'), "畳みで高さの遷移が閉じていない");
  // 閉じている間も行は DOM に残す (高さの遷移の前の値が要る)。見えない行をフォーカスと読み上げの
  // 対象に残さないことは inert が担う (FileBrowser の枝と同じ契約)
  assert.match(closed, /data-open="false"[^>]*inert/, "畳みで配下セッションが inert でない");
  assert.ok(closed.includes('aria-label="hello の操作"'), "畳みの行に ⋯ (操作メニュー) が出ていない");

  const opened = renderProjectRow(true);
  assert.ok(opened.includes('aria-expanded="true"'), "展開で aria-expanded が true でない");
  assert.ok(opened.includes('data-open="true"'), "展開で高さの遷移が開いていない");
  assert.ok(!opened.includes("inert"), "展開でも inert が残っている");
  assert.ok(opened.includes("既存の会話"), "展開で配下セッションが出ない");

  // 配下が空でも案内は入れ物に残し、開いたときに同じ遷移で出す
  assert.ok(renderProjectRow(false, []).includes("セッションはありません"), "畳みで空の案内を落としている");
  assert.ok(renderProjectRow(true, []).includes("セッションはありません"), "展開で空の案内が出ない");
});

test("登録解除の確認はプロジェクト名を独立した行へ出し、配下の停止を先に伝える", () => {
  const request = projectDeleteConfirmRequest({ name: "決済画面の検証" }, 3);
  assert.equal(request.kind, "confirm");
  assert.equal(request.title, "プロジェクトの登録を解除");
  assert.deepEqual(request.subject, { label: "登録を解除するプロジェクト", value: "決済画面の検証" });
  assert.deepEqual(request.body, ["配下の 3 件のセッションを停止します（履歴とファイルは残ります）。"]);
  assert.equal(request.confirmLabel, "登録を解除する");
  assert.ok(request.danger, "配下のセッションを止める操作は danger にする");

  // 一覧が古くて名前を引けないときも件数だけで確認を出す
  assert.equal(projectDeleteConfirmRequest(undefined, 0).subject, undefined);
});
