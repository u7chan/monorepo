// 入力欄の上のライブ表示 (実行中のツール) の表示条件と、ツール履歴のコピーを完了まで出さない契約。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolHistoryView } from "../src/components/chat/ToolHistory";
import { LiveToolCall } from "../src/components/composer/LiveToolCall";
import type { ToolCard } from "../src/lib/chatTypes";
import {
  initialLiveTracker,
  liveToolState,
  LIVE_ROW_MIN_VISIBLE_MS,
  trackLiveHolds,
  type LiveToolTracker,
} from "../src/lib/liveToolCall";
import type { RunStatus, ToolCall } from "../src/types";

function call(id: string, name: string, args: string, done: boolean, extra: Partial<ToolCall> = {}): ToolCall {
  return { id, name, args, done, isError: false, output: done ? "ok" : "", ...extra };
}

function card(id: string, name: string, phase: ToolCard["phase"], timing: Partial<ToolCard> = {}): ToolCard {
  return { id, name, args: "", phase, output: "", ...timing };
}

test("ライブは実行中のカードだけを走査順に返し、番号は完了分も含めて数える", () => {
  const runTools = {
    t1: call("t1", "bash", "curl -fsSL https://example.test/a.json", true),
    t2: call("t2", "bash", "jq -r '.areas[0]' a.json", false),
    t3: call("t3", "read", "/work/a.json", true),
    t4: call("t4", "grep", "-n osaka /work/a.json", false),
  };

  const state = liveToolState(runTools, "running");
  assert.equal(state.visible, true);
  assert.deepEqual(
    state.rows.map((row) => [row.id, row.index]),
    [
      ["t2", 2],
      ["t4", 4],
    ],
  );
  assert.equal(state.rows[0].summary, "bash — jq -r '.areas[0]' a.json");
});

test("スキル読み込みと ask_user はライブに出さない (ツール履歴と同じ除外)", () => {
  const skill = { id: "s1", name: "a", path: "skills/a/SKILL.md" };
  const runTools = {
    t1: call("t1", "read", "skills/a/SKILL.md", false, { skill }),
    t2: call("t2", "ask_user", "{}", false, { questions: [{ question: "どこの地域?" }] }),
    t3: call("t3", "bash", "ls", false),
  };

  const state = liveToolState(runTools, "running");
  assert.deepEqual(
    state.rows.map((row) => row.id),
    ["t3"],
  );
  // 外した分は番号を詰める (履歴の行番号と同じ数え方)
  assert.equal(state.rows[0].index, 1);
});

test("run が実行中でなければ出さない (停止で done が来なかったカードを残さない)", () => {
  const runTools = { t1: call("t1", "bash", "sleep 100", false) };
  // queued は run が動いていない状態 (次の run のツールは run_start まで runTools に入らない)
  for (const status of ["idle", "queued", "compacting", "completed", "stopped", "error"] as RunStatus[]) {
    const state = liveToolState(runTools, status);
    assert.equal(state.visible, false, `${status} の表示`);
    assert.deepEqual(
      state.allRows.map((row) => row.id),
      ["t1"],
      `${status} でも全行は返す (畳む判定と本文に使う)`,
    );
  }
  const empty = liveToolState({}, "running");
  assert.equal(empty.visible, false, "実行中でもツールが無ければ出さない");
  assert.deepEqual(empty.allRows, [], "実行中でもツールが無ければ全行も空");
});

test("全行には完了した行も入り、実行時間と履歴と同じ番号を持つ", () => {
  const skill = { id: "t3", name: "a", path: "skills/a/SKILL.md" };
  const runTools = {
    t1: call("t1", "bash", "ls", true, { startedAt: 1_000, endedAt: 2_200 }),
    t2: call("t2", "read", "a.md", false, { startedAt: 2_300 }),
    t3: call("t3", "read", "skills/a/SKILL.md", false, { skill }),
  };

  const state = liveToolState(runTools, "running");
  assert.deepEqual(
    state.allRows.map((row) => [row.id, row.index, row.done, row.durationMs]),
    [
      ["t1", 1, true, 1_200],
      ["t2", 2, false, undefined],
    ],
  );
  assert.deepEqual(
    state.rows.map((row) => row.id),
    ["t2"],
  );
});

/** liveToolState と tracker を続けて呼ぶ (コンポーネントの 1 描画ぶん) */
function track(
  tracker: LiveToolTracker,
  runTools: Record<string, ToolCall>,
  runStatus: RunStatus,
  now: number,
): ReturnType<typeof trackLiveHolds> {
  const state = liveToolState(runTools, runStatus);
  return trackLiveHolds(tracker, { rows: state.rows, allRows: state.allRows, runStatus, now });
}

test("開始と終了が同じ描画にまとまった行も、最短表示時間だけ出してから畳む", () => {
  // React が toolStart / toolEnd を同じ描画にまとめると、実行中の行として一度も出ない。
  // ここで出さないと一瞬のツールが本当に見えなくなる
  const runTools = { t1: call("t1", "bash", "ls", true, { startedAt: 1_000, endedAt: 1_005 }) };

  const { holds } = track(initialLiveTracker({}), runTools, "running", 2_000);
  assert.deepEqual(
    holds.map((hold) => [hold.row.id, hold.row.index, hold.row.summary, hold.row.durationMs, hold.holdMs]),
    [["t1", 1, "bash — ls", 5, LIVE_ROW_MIN_VISIBLE_MS]],
  );
});

test("実行中として出ていた行は、出ていた時間の残りだけ畳む前に残す", () => {
  const running = { t1: call("t1", "bash", "sleep 3", false, { startedAt: 1_000 }) };
  const first = track(initialLiveTracker({}), running, "running", 1_000);
  assert.deepEqual(first.holds, [], "実行中の行はまだ畳まない");

  const finished = { t1: call("t1", "bash", "sleep 3", true, { startedAt: 1_000, endedAt: 4_000 }) };
  const short = track(first.tracker, finished, "running", 1_400);
  assert.deepEqual(
    short.holds.map((hold) => [hold.row.id, hold.row.durationMs, hold.holdMs]),
    [["t1", 3_000, 500]],
    "出てから 400ms で終わったので、残り 500ms を残す",
  );

  const long = track(first.tracker, finished, "running", 3_000);
  assert.equal(long.holds[0].holdMs, 0, "最短表示時間より長く出ていた行はその場で畳む");
});

test("mount 時点の完了カードと、run が動いていない復元の完了カードは畳む対象にしない", () => {
  const done = { t1: call("t1", "bash", "ls", true, { startedAt: 1_000, endedAt: 1_005 }) };
  assert.deepEqual(
    track(initialLiveTracker(done), done, "running", 2_000).holds,
    [],
    "復元直後に前の run の完了カードを光らせない",
  );
  assert.deepEqual(
    track(initialLiveTracker({}), done, "completed", 2_000).holds,
    [],
    "payload が持ち込んだ完了カードを走っていない run で出さない",
  );
});

test("run ごと入れ替わって消えた実行中の行も畳む (実行時間は出せない)", () => {
  const first = track(initialLiveTracker({}), { t1: call("t1", "bash", "sleep 5", false) }, "running", 1_000);
  const replaced = track(first.tracker, { t2: call("t2", "read", "a.md", false) }, "running", 1_300);
  assert.deepEqual(
    replaced.holds.map((hold) => [hold.row.id, hold.row.index, hold.row.durationMs, hold.holdMs]),
    [["t1", 1, undefined, 600]],
  );
});

function renderHistory(cards: ToolCard[], live: boolean): string {
  return renderToStaticMarkup(
    createElement(ToolHistoryView, {
      cards,
      hasResponse: false,
      live,
      copiedId: "",
      copiedAll: false,
      onCopyAll: () => {},
      compact: false,
      onCopyTool: () => {},
    }),
  );
}

test("ツール履歴の「すべてコピー」は進行中のターンでは出さず、完了で出す", () => {
  const cards = [card("t1", "bash", "done")];
  assert.equal(renderHistory(cards, true).includes("ツール履歴をすべてコピー"), false);
  assert.equal(renderHistory(cards, false).includes("ツール履歴をすべてコピー"), true);
});

test("進行中のターンでは実行中のカードを履歴に出さず、ターンが終われば並べる", () => {
  const cards = [card("t1", "bash", "done"), card("t2", "bash", "running")];

  const live = renderHistory(cards, true);
  assert.ok(live.includes("1件"), "実行中のカードは件数に数えない");
  assert.equal(live.includes("実行中"), false, "実行中はライブ表示が受け持つ");

  // 停止・中断で tool_end が来なかったカードは、ターンを抜けた後もここに残す
  const finished = renderHistory(cards, false);
  assert.ok(finished.includes("2件"));
  assert.ok(finished.includes("実行中"));
});

test("ツール履歴の行は実行時間を出し、見出しは重なりを除いた合計を出す", () => {
  const cards = [
    card("t1", "bash", "done", { startedAt: 0, endedAt: 1_000 }),
    card("t2", "grep", "done", { startedAt: 500, endedAt: 1_500 }),
  ];
  const html = renderHistory(cards, false);
  assert.ok(html.includes("1.0s"), "行ごとの実行時間が出る");
  assert.ok(html.includes("計 1.5s"), "重なった 1 秒を二重に数えない合計を出す");
});

test("実行時間の控えが無いカード (旧サーバー / 停止) では合計を出さない", () => {
  const missing = renderHistory([card("t1", "bash", "done")], false);
  assert.equal(missing.includes("計 "), false, "1 枚でも区間が閉じていなければ出さない");

  // 停止・中断で tool_end が来なかったカードは終了時刻を持たない
  const stopped = renderHistory(
    [card("t1", "bash", "done", { startedAt: 0, endedAt: 1_000 }), card("t2", "bash", "running", { startedAt: 2_000 })],
    false,
  );
  assert.equal(stopped.includes("計 "), false);
});

function renderLive(runTools: Record<string, ToolCall>, runStatus: RunStatus): string {
  return renderToStaticMarkup(createElement(LiveToolCall, { runTools, runStatus }));
}

test("ライブ表示は実行中のツールを行サマリーで出し、行が無ければ畳む", () => {
  const running = renderLive({ t1: call("t1", "bash", "ls -la", false) }, "running");
  assert.match(running, /data-visible="true"/);
  assert.ok(running.includes("bash — ls -la"), "引数まで見える (名前だけでは何をしているか分からない)");

  const finished = renderLive({ t1: call("t1", "bash", "ls -la", true) }, "running");
  assert.match(finished, /data-visible="false"/);
  assert.equal(finished.includes("ls -la"), false, "完了した行は履歴へ移る");

  const stopped = renderLive({ t1: call("t1", "bash", "sleep 100", false) }, "stopped");
  assert.match(stopped, /data-visible="false"/, "停止で done が来なかったカードは出さない");
});
