// 左バーの未見表示の配線。client に DOM テスト基盤が無いため、mark の 3 経路と run_start の
// 一覧取り直しをソース走査で、行の描画 (状態ラベルが truncate の外に出ること) を
// react-dom/server で固定する。分岐の組み合わせは client/test/sidebarStatus.test.ts が
// 純関数側で網羅する。
//   1. mark: 会話を選択したとき (一覧の lastRun と、payload が終端のときだけ run) /
//      選択中の会話で run_end / 選択中に一覧が届いたとき
//   2. run_start は一覧を取り直す (行が次のポーリング (4 秒) まで古いままにならない)
//   3. Sidebar は singleton の store を購読し、SSR 用の getServerSnapshot も渡す。行へは
//      ProjectRow 経由でそのまま渡す
//   4. 状態ラベルは truncate する部分の外の shrink-0 に出し、長いエージェント名でも切れない
//   5. 待機n件 は行に出さない (Composer が受け持つ)。queued は実行中へ畳む
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SessionRow } from "../src/components/sidebar/SessionRow";
import type { SeenRuns } from "../src/lib/sidebarStatus";
import type { SessionSummary } from "../src/types";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/** フック内の宣言 (`const x = useCallback(...)`) の本体。次のトップレベル宣言までを切り出す。
 *  改行とインデントに左右されないよう、空白は 1 つに畳んでから照合する */
function declarationBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} が無い`);
  const end = source.indexOf("\n  const ", start + 1);
  return source.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

const ITEM: SessionSummary = {
  sessionId: "s-1",
  title: "テスト",
  agentId: "agent-general",
  agentName: "とても長い名前のエージェントで行の幅を埋める",
  status: "idle",
  queueDepth: 0,
  messageCount: 2,
  createdAt: 0,
  lastUsedAt: 0,
};

function renderSessionRow(overrides: Partial<SessionSummary> = {}, seenRuns: SeenRuns = new Map()): string {
  return renderToStaticMarkup(
    createElement(SessionRow, {
      item: { ...ITEM, ...overrides },
      agents: [],
      active: false,
      seenRuns,
      onSelect: () => {},
      onRename: () => {},
      onDelete: () => {},
    }),
  );
}

/** meta 行 (エージェント名 + 時刻 + 状態ラベル) の中身 */
function metaRow(html: string): string {
  const match = /<small[^>]*>([\s\S]*?)<\/small>/.exec(html);
  assert.ok(match, "meta 行が無い");
  return match[1];
}

const UNSEEN_COMPLETED = { id: "run-1", status: "completed" as const, endedAt: 1 };

test("mark の 3 経路: 会話を選択したとき / 選択中の run_end / 選択中に一覧が届いたとき", () => {
  const sessions = read("src/hooks/useSessions.ts");
  const stream = read("src/hooks/sessionStream.ts");

  // 1. 選択 (GET /api/sessions/:id の適用): 一覧の lastRun と、payload の run が終端のときだけ mark する
  const select = declarationBody(sessions, "applySelectedSession");
  assert.ok(
    select.includes("seenRunsStore.mark( payload.sessionId, sessionsRef.current.find"),
    "会話を開いたときに一覧の lastRun を既読にしていない",
  );
  assert.ok(
    select.includes("seenRunsStore.mark(payload.sessionId, endedRunId(payload.run))"),
    "会話を開いたときに終端した run を既読にしていない",
  );
  // running は mark しない (判断は純関数側。ここでは status を直接見ていないことを固定する)
  assert.ok(!select.includes('payload.status === "running"'), "status から未見を推測している");

  // 2. 選択中の run_end: sessionStream が runId を渡し、useSessions が選択中の会話へ mark する
  assert.ok(stream.includes("markRunSeen(entry.data.runId)"), "run_end で既読にしていない");
  const onEvent = declarationBody(sessions, "onEvent");
  assert.ok(onEvent.includes("markRunSeen: (runId)"), "run_end の mark を配線していない");
  assert.ok(onEvent.includes("seenRunsStore.mark(current, runId)"), "run_end の runId を既読にしていない");
  assert.ok(onEvent.includes("const current = sessionIdRef.current"), "選択中の会話以外を既読にする可能性がある");

  // 3. 選択中に一覧が届いたとき: その会話の lastRun を mark する (通知リンクの取りこぼしを塞ぐ)
  const refresh = declarationBody(sessions, "refreshSessions");
  assert.ok(
    refresh.includes("seenRunsStore.mark(current, list.find((item) => item.sessionId === current)?.lastRun?.id)"),
    "一覧の到着で選択中の会話の lastRun を既読にしていない",
  );
});

test("run_start は一覧を取り直す (次のポーリングを待たない)", () => {
  const stream = read("src/hooks/sessionStream.ts");
  const start = stream.slice(stream.indexOf('case "run_start":'), stream.indexOf('case "text":'));
  assert.ok(start.includes("void refreshSessions()"), "run_start で一覧を取り直していない");
  // 4 秒のポーリングは useU7Agent が持つ (ここでは触らない)
  assert.ok(read("src/hooks/useU7Agent.ts").includes("}, 4000);"), "ポーリングが消えている");
});

test("Sidebar は store を購読して行へ渡す (SSR 用の snapshot も渡す)", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.ok(
    sidebar.includes("useSyncExternalStore(seenRunsStore.subscribe, seenRunsStore.snapshot, seenRunsStore.snapshot)"),
    "Sidebar が store を購読していない (storage イベントと mark が再描画へ届かない)",
  );
  assert.ok(!sidebar.includes("createSeenRunsStore"), "Sidebar が store を組み立てている (singleton を共有しない)");
  const projectRow = read("src/components/sidebar/ProjectRow.tsx");
  for (const [label, source] of [
    ["Sidebar (未所属)", sidebar],
    ["ProjectRow (配下)", projectRow],
  ] as const) {
    assert.ok(source.includes("seenRuns={seenRuns}"), `${label} が seenRuns を渡していない`);
  }
});

test("未見の状態ラベルは truncate の外の shrink-0 に出し、長い名前でも切らない", () => {
  const unseen = renderSessionRow({ status: "completed", lastRun: UNSEEN_COMPLETED });
  const meta = metaRow(unseen);
  // 状態ラベルは truncate する部分 (エージェント名 + 時刻) の後ろに置く
  assert.match(
    meta,
    /<span class="truncate">[^<]*<\/span><span class="shrink-0">完了<\/span>/,
    "状態ラベルが truncate の中にある",
  );
  // 色だけで伝えない: ラベルはテキストとして出す (読み上げでも読める)
  assert.ok(unseen.includes(">完了<"), "状態ラベルがテキストで出ていない");
  assert.ok(unseen.includes("dot-ok"), "完了が ok の点でない");

  // 見た後はラベルも点も出さない (idle)
  const seen = renderSessionRow({ status: "completed", lastRun: UNSEEN_COMPLETED }, new Map([["s-1", ["run-1"]]]));
  assert.ok(!/<span class="shrink-0">/.test(metaRow(seen)), "既読なのに状態ラベルを出している");
  assert.ok(seen.includes("dot-idle"), "既読の点が idle でない");
  assert.ok(!seen.includes("完了"), "既読なのに状態ラベルが残っている");
});

test("終端の 3 種は色とラベルを組で出し、lastRun から出す (再起動後も同じ)", () => {
  const cases = [
    ["completed", "完了", "dot-ok"],
    ["stopped", "停止", "dot-warn"],
    ["error", "エラー", "dot-danger"],
  ] as const;
  for (const [status, label, dot] of cases) {
    // 再起動後は status: "idle" + meta.lastRun で届く
    const html = renderSessionRow({ status: "idle", lastRun: { id: "run-1", status, endedAt: 1 } });
    assert.ok(html.includes(`>${label}<`), `${label} のラベルが無い`);
    assert.ok(html.includes(dot), `${label} の点が ${dot} でない`);
  }
});

test("live は kind を畳み、queued と待機n件 は行に出さない", () => {
  const running = renderSessionRow({ status: "running", queueDepth: 3 });
  assert.ok(running.includes(">実行中<"), "実行中のラベルが無い");
  assert.ok(!running.includes("待機"), "待機n件 を行に出している (Composer が受け持つ)");
  assert.ok(running.includes("dot-pulse"), "実行中の点が動かない");

  const queued = renderSessionRow({ status: "queued", queueDepth: 2 });
  assert.ok(queued.includes(">実行中<"), "queued を実行中へ畳んでいない");
  assert.ok(!queued.includes("キュー待ち"), "queued のラベルが残っている");
  assert.ok(!queued.includes("待機"), "待機n件 を行に出している");

  const compacting = renderSessionRow({ status: "compacting" });
  assert.ok(compacting.includes(">圧縮中<"), "圧縮中のラベルが無い");
  assert.ok(compacting.includes("dot-pulse"), "圧縮中が実行中と同じ動きの点でない");
});
