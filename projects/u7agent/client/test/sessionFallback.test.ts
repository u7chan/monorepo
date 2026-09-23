// 開けなかったセッションの移り先。破損が複数あると候補が互いを指して同じ 2 つを往復し、
// 1 回の起動で数百リクエストになっていた (一覧を 1 周したら未作成チャットへ落とす)。

import assert from "node:assert/strict";
import test from "node:test";
import { nextAfterFailure } from "../src/hooks/sessionFallback";

/** selectSession と同じ手順で候補を辿る。壊れていても止まるよう件数で打ち切る */
function follow(sessions: { sessionId: string }[], first: string): string[] {
  const failed = new Set<string>();
  const visited: string[] = [];
  let pending: string | undefined = first;
  while (pending && visited.length <= sessions.length) {
    visited.push(pending);
    failed.add(pending);
    const next = nextAfterFailure(sessions, failed);
    pending = next.kind === "select" ? next.sessionId : undefined;
  }
  return visited;
}

test("moves to the next unopened session in list order", () => {
  const sessions = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];
  assert.deepEqual(nextAfterFailure(sessions, new Set(["a"])), { kind: "select", sessionId: "b" });
  assert.deepEqual(nextAfterFailure(sessions, new Set(["b"])), { kind: "select", sessionId: "a" });
});

test("stops after one pass over the list instead of bouncing between two sessions", () => {
  const sessions = [{ sessionId: "a" }, { sessionId: "b" }];
  assert.deepEqual(follow(sessions, "a"), ["a", "b"], "同じ 2 つを往復しない");
  assert.deepEqual(follow(sessions, "b"), ["b", "a"]);
});

test("falls back to a new chat when every session fails", () => {
  const sessions = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];
  const failed = new Set(["a", "b", "c"]);
  assert.deepEqual(nextAfterFailure(sessions, failed), { kind: "newChat" });
  assert.deepEqual(follow(sessions, "b"), ["b", "a", "c"], "未試行の候補を全部試してから落ちる");
});

test("falls back to a new chat when the list is empty or only has the failed session", () => {
  assert.deepEqual(nextAfterFailure([], new Set(["a"])), { kind: "newChat" });
  assert.deepEqual(nextAfterFailure([{ sessionId: "a" }], new Set(["a"])), { kind: "newChat" });
});
