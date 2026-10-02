import assert from "node:assert/strict";
import test from "node:test";

import { servedAppView } from "../src/lib/servedApp";
import { canApplyServeAction, canApplyStatus } from "../src/lib/serveStatus";
import type { ServeStatus } from "../src/types";
import { serveStatus } from "./serve-fixture";

test("canApplyServeAction は発行時と同じ会話選択のときだけ適用する", () => {
  const issued = { sessionId: "A", generation: 1 };
  // 切替なし (同じ選択) は適用する
  assert.equal(canApplyServeAction(issued, { sessionId: "A", generation: 1 }), true);
  // A → B → A で世代が進んでいれば、同じ会話 id でも適用しない
  assert.equal(canApplyServeAction(issued, { sessionId: "A", generation: 2 }), false);
  // 他会話へ切り替わった応答も適用しない
  assert.equal(canApplyServeAction(issued, { sessionId: "B", generation: 2 }), false);
  // 切替後の操作 (新しい世代で発行したもの) は適用する
  assert.equal(canApplyServeAction({ sessionId: "A", generation: 2 }, { sessionId: "A", generation: 2 }), true);
});

test("保留中の start 応答は、A → B → A と切り替えたあとの状態を上書きしない", () => {
  // フックと同じ規則 (発行時の選択を捕捉し、応答の適用前に照合する) を並べたシミュレーション。
  // 会話 id だけの照合だと、同じ A に戻っているため古い start 応答が適用され、
  // 「サービスを開く」が復活してしまう (その間に B が公開先を置き換えていれば B のアプリを開く)
  let selection = 1;
  let status: ServeStatus | null = null;
  const issued = { sessionId: "A", generation: selection };
  const applyAction = (next: ServeStatus, currentSelection: number) => {
    if (!canApplyServeAction(issued, { sessionId: "A", generation: currentSelection })) return;
    status = next;
  };

  selection += 1; // A → B
  status = null;
  selection += 1; // B → A
  status = serveStatus({ reachable: true, owner: { kind: "other", title: "検証B" }, generation: "g2" });
  applyAction(serveStatus({ reachable: true, owner: { kind: "mine", title: "検証A" }, generation: "g1" }), selection);
  assert.equal(status?.owner.kind, "other", "古い start 応答で上書きしない");
  assert.equal(servedAppView(status).canOpen, false, "「サービスを開く」が復活しない");
});

test("canApplyStatus は新しい応答を適用し、操作で無効化された応答は適用しない", () => {
  // ポーリング間隔より遅い応答が続いても、返ってきた順に適用される (4 秒ごとに捨て合わない)
  let applied = 0;
  for (const seq of [1, 2, 3]) {
    if (canApplyStatus(seq, 0, applied)) applied = seq;
  }
  assert.equal(applied, 3);
  // 操作が無効化した番号以前の取得は適用しない (操作の結果が残る)
  assert.equal(canApplyStatus(5, 5, 4), false, "操作前の取得は捨てる");
  assert.equal(canApplyStatus(6, 5, 4), true, "操作後に始まった取得は適用する");
  // 後から届いた古い応答も適用しない
  assert.equal(canApplyStatus(4, 0, 5), false);
});

test("会話切替 (A → B → A) で切替前の取得結果を適用しない", () => {
  // 切替で番号を無効化しないと、最初の A の応答が戻ってきたときに適用され、
  // reset 後の状態へ「稼働中」とサービスリンクが復活する (その間に B へ置き換わっていれば B を開く)
  let requestSeq = 0;
  let invalidatedUpTo = 0;
  let appliedSeq = 0;
  const apply = (seq: number): boolean => {
    if (!canApplyStatus(seq, invalidatedUpTo, appliedSeq)) return false;
    appliedSeq = seq;
    return true;
  };
  const switchSession = () => {
    invalidatedUpTo = requestSeq;
  };
  const a1 = (requestSeq += 1);
  switchSession();
  const b2 = (requestSeq += 1);
  switchSession();
  const a3 = (requestSeq += 1);
  assert.equal(apply(a1), false, "切替前の A の応答は捨てる");
  assert.equal(apply(b2), false, "他会話 (B) の応答は捨てる");
  assert.equal(apply(a3), true, "切替後に始まった A の応答は適用する");
});
