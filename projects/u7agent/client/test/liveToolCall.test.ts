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
  LIVE_PROGRESS_BODY_LINES,
  LIVE_PROGRESS_BODY_MAX,
  liveToolProgress,
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
  liveIds: string[] = [],
): ReturnType<typeof trackLiveHolds> {
  const state = liveToolState(runTools, runStatus);
  return trackLiveHolds(tracker, { rows: state.rows, allRows: state.allRows, liveIds: new Set(liveIds), now });
}

test("ライブのツールイベントで現れた完了カードは、最短表示時間だけ出してから畳む", () => {
  // React が toolStart / toolEnd を同じ描画にまとめると実行中の行として一度も出ない。run の終了が
  // 同じ描画にまとまっても (status が completed でも) 出さないと、一瞬のツールが本当に見えなくなる
  const done = { t1: call("t1", "bash", "ls", true, { startedAt: 1_000, endedAt: 1_005 }) };
  for (const status of ["running", "completed", "stopped"] as RunStatus[]) {
    const { holds } = track(initialLiveTracker({}), done, status, 2_000, ["t1"]);
    assert.deepEqual(
      holds.map((hold) => [hold.row.id, hold.row.index, hold.row.summary, hold.row.durationMs, hold.holdMs]),
      [["t1", 1, "bash — ls", 5, LIVE_ROW_MIN_VISIBLE_MS]],
      `${status} の描画`,
    );
  }
});

test("実行中として出ていた行は、出ていた時間の残りだけ畳む前に残す", () => {
  const running = { t1: call("t1", "bash", "sleep 3", false, { startedAt: 1_000 }) };
  const first = track(initialLiveTracker({}), running, "running", 1_000, ["t1"]);
  assert.deepEqual(first.holds, [], "実行中の行はまだ畳まない");

  const finished = { t1: call("t1", "bash", "sleep 3", true, { startedAt: 1_000, endedAt: 4_000 }) };
  const short = track(first.tracker, finished, "running", 1_400, ["t1"]);
  assert.deepEqual(
    short.holds.map((hold) => [hold.row.id, hold.row.durationMs, hold.holdMs]),
    [["t1", 3_000, 500]],
    "出てから 400ms で終わったので、残り 500ms を残す",
  );

  const long = track(first.tracker, finished, "running", 3_000, ["t1"]);
  assert.equal(long.holds[0].holdMs, 0, "最短表示時間より長く出ていた行はその場で畳む");
});

test("同じ描画に復元カードとライブのカードが混ざっても、復元カードは抱えない", () => {
  // resync が持ち込んだ完了カード old と、別 ID の toolStart (new) が同じ描画にまとまった場合。
  // ライブ観測の目印は ID ごとに持つので、old を新規のツールとして出さない
  const restored = call("old", "bash", "ls", true, { startedAt: 1_000, endedAt: 1_005 });
  const runningNew = call("new", "read", "a.md", false, { startedAt: 2_000 });
  assert.deepEqual(
    track(initialLiveTracker({}), { old: restored, new: runningNew }, "running", 3_000, ["new"]).holds,
    [],
    "new は実行中の行として出るだけ",
  );

  const doneNew = call("new", "read", "a.md", true, { startedAt: 2_000, endedAt: 2_005 });
  const { holds } = track(initialLiveTracker({}), { old: restored, new: doneNew }, "running", 3_000, ["new"]);
  assert.deepEqual(
    holds.map((hold) => [hold.row.id, hold.row.durationMs]),
    [["new", 5]],
    "ライブで観測した ID だけを保持する",
  );
});

test("mount 時の完了カードと、resync が持ち込んだ完了カードは畳む対象にしない", () => {
  const done = { t1: call("t1", "bash", "ls", true, { startedAt: 1_000, endedAt: 1_005 }) };
  assert.deepEqual(
    track(initialLiveTracker(done), done, "completed", 2_000, ["t1"]).holds,
    [],
    "mount 時からあるカードは観測済みとして扱う",
  );

  // 非実行中の resync が持ち込んだカード。たとえ次の送信で setRun (running) に変わっても、
  // ツールイベントを観測していないので抱えない
  const tracker = track(initialLiveTracker({}), done, "completed", 2_000).tracker;
  assert.deepEqual(track(tracker, done, "running", 2_100, ["t1"]).holds, [], "送信応答の setRun では出さない");
});

test("同じカードを2度抱えない (別のツールのイベントで古い完了カードを出さない)", () => {
  const first = track(initialLiveTracker({}), { t1: call("t1", "bash", "ls", true) }, "running", 1_000, ["t1"]);
  assert.equal(first.holds.length, 1, "初回は出す");

  const runTools = {
    t1: call("t1", "bash", "ls", true),
    t2: call("t2", "read", "a.md", false, { startedAt: 1_100 }),
  };
  const second = track(first.tracker, runTools, "running", 1_100, ["t1", "t2"]);
  assert.deepEqual(second.holds, [], "観測済みの完了カードを再表示しない");
});

test("run ごと入れ替わって消えた実行中の行も畳む (実行時間は出せない)", () => {
  const first = track(initialLiveTracker({}), { t1: call("t1", "bash", "sleep 5", false) }, "running", 1_000, ["t1"]);
  const replaced = track(first.tracker, { t2: call("t2", "read", "a.md", false) }, "running", 1_300, ["t1", "t2"]);
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
  return renderToStaticMarkup(createElement(LiveToolCall, { runTools, runStatus, liveToolIds: [] }));
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

// --- investigate の進捗 (live 専用) ---

test("進捗の本文は先頭行を活動、残りを子の本文末尾として読む", () => {
  assert.deepEqual(liveToolProgress("bash rg -n foo\n結論: docs にある"), {
    activity: "bash rg -n foo",
    body: "結論: docs にある",
  });
  // 1 行だけの進捗 (活動だけ / 本文だけ) は活動として出す。分けられない以上、1 行として見せれば足りる
  assert.deepEqual(liveToolProgress("生成中です"), { activity: "生成中です", body: "" });
  assert.deepEqual(liveToolProgress("bash ls\n\n本文 1\n本文 2"), { activity: "bash ls", body: "本文 1\n本文 2" });
});

test("子の本文末尾は行数の上限まで残し、末尾を優先する", () => {
  const body = Array.from({ length: LIVE_PROGRESS_BODY_LINES + 2 }, (_, index) => `本文${index + 1}`).join("\n");
  const result = liveToolProgress(`bash ls\n${body}`);

  assert.equal(result.body.split("\n").length, LIVE_PROGRESS_BODY_LINES, "行数の上限まで残す");
  assert.ok(result.body.endsWith(`本文${LIVE_PROGRESS_BODY_LINES + 2}`), "末尾を優先する");
  assert.equal(result.body.includes("本文1"), false, "先頭の行は落とす");

  const long = `bash ls\n${"あ".repeat(LIVE_PROGRESS_BODY_MAX + 20)}`;
  const { body: clipped } = liveToolProgress(long);
  assert.equal(clipped.length, LIVE_PROGRESS_BODY_MAX + 1, "長さの上限まで残す");
  assert.ok(clipped.startsWith("…"), "切ったことを示す");
  assert.ok(clipped.endsWith("あ"));
});

test("ライブ行は investigate の活動と子の本文末尾を出し、進捗が無ければ出さない", () => {
  const running = renderLive(
    { t1: call("t1", "investigate", "docs を調べて", false, { progress: "bash rg -n foo\n結論: docs にある" }) },
    "running",
  );
  assert.match(running, /data-visible="true"/);
  assert.ok(running.includes("investigate — docs を調べて"));
  assert.ok(running.includes("bash rg -n foo"), "現在の活動が出る");
  assert.ok(running.includes("結論: docs にある"), "子の本文末尾が出る");

  const withoutProgress = renderLive({ t1: call("t1", "investigate", "docs を調べて", false) }, "running");
  assert.equal(withoutProgress.includes("結論:"), false);
});
