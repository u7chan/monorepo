// 左バーのセッション行の状態表示の導出。
//
// 入力は BFF の SessionSummary.status だけにして、live (実行中 / 圧縮中) と idle の別、
// 表示ラベルを返す。queued は実行中へ畳み、終端と idle は無表示にする (規則の正は docs/ui-layout.md)。
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

test("SessionSummary.status の全分岐を網羅する", () => {
  const statuses = Object.keys(EXPECTED) as Status[];
  assert.equal(statuses.length, 7, "状態が増減したら期待表も更新する");
  for (const status of statuses) {
    assert.deepEqual(sidebarStatus(status), EXPECTED[status], status);
  }
});

test("実行中とキュー待ちは実行中へ畳む", () => {
  assert.deepEqual(sidebarStatus("running"), { label: "実行中", tone: "live" });
  assert.deepEqual(sidebarStatus("queued"), { label: "実行中", tone: "live" });
});

test("圧縮中も live にして、実行中と同じ点で示す", () => {
  assert.deepEqual(sidebarStatus("compacting"), { label: "圧縮中", tone: "live" });
  assert.equal(sidebarStatus("compacting").tone, sidebarStatus("running").tone, "実行中と tone が違う");
});

test("終端 3 種は無表示にする", () => {
  for (const status of ["completed", "stopped", "error"] as Status[]) {
    assert.deepEqual(sidebarStatus(status), { label: "", tone: "idle" }, status);
  }
});

test("idle は無表示にする", () => {
  assert.deepEqual(sidebarStatus("idle"), { label: "", tone: "idle" });
});
