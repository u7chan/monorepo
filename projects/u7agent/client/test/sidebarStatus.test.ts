// 左バーのセッション行の状態表示の導出。
//
// 入力は BFF の SessionSummary の status と awaitingAnswer にして、live (実行中 / 圧縮中) /
// waiting (回答待ち) / idle の別と表示ラベルを返す。queued は実行中へ畳み、終端と idle は無表示に
// する。回答待ちは実行中より優先し、圧縮中だけが先に立つ (規則の正は docs/ui-layout.md)。
import assert from "node:assert/strict";
import test from "node:test";
import { sidebarStatus, type SidebarStatus } from "../src/lib/sidebarStatus";
import type { SessionSummary } from "../src/types";

type Status = SessionSummary["status"];

/** satisfies で全状態の網羅を typecheck に検査させる (状態が増えたらここで落ちる) */
const EXPECTED = {
  idle: { label: "", tone: "idle" },
  running: { label: "実行中", tone: "live" },
  queued: { label: "実行中", tone: "live" },
  compacting: { label: "圧縮中", tone: "live" },
  completed: { label: "", tone: "idle" },
  stopped: { label: "", tone: "idle" },
  error: { label: "", tone: "idle" },
} satisfies Record<Status, SidebarStatus>;

const STATUSES = Object.keys(EXPECTED) as Status[];

test("SessionSummary.status の全分岐を網羅する", () => {
  assert.equal(STATUSES.length, 7, "状態が増減したら期待表も更新する");
  for (const status of STATUSES) {
    assert.deepEqual(sidebarStatus(status, false), EXPECTED[status], status);
  }
});

test("実行中とキュー待ちは実行中へ畳む", () => {
  assert.deepEqual(sidebarStatus("running", false), { label: "実行中", tone: "live" });
  assert.deepEqual(sidebarStatus("queued", false), { label: "実行中", tone: "live" });
});

test("回答待ちは実行中より優先し、圧縮中だけが先に立つ", () => {
  const waiting = { label: "回答待ち", tone: "waiting" };
  for (const status of STATUSES) {
    assert.deepEqual(sidebarStatus(status, true), status === "compacting" ? EXPECTED.compacting : waiting, status);
  }
  assert.notEqual(waiting.tone, sidebarStatus("running", false).tone, "実行中と同じ tone にしない");
  assert.notEqual(waiting.tone, sidebarStatus("idle", false).tone, "無表示と同じ tone にしない");
});

test("圧縮中も live にして、実行中と同じ点で示す", () => {
  assert.deepEqual(sidebarStatus("compacting", false), { label: "圧縮中", tone: "live" });
  assert.equal(sidebarStatus("compacting", false).tone, sidebarStatus("running", false).tone, "実行中と tone が違う");
});

test("終端 3 種は無表示にする", () => {
  for (const status of ["completed", "stopped", "error"] as Status[]) {
    assert.deepEqual(sidebarStatus(status, false), { label: "", tone: "idle" }, status);
  }
});

test("idle は無表示にする", () => {
  assert.deepEqual(sidebarStatus("idle", false), { label: "", tone: "idle" });
});
