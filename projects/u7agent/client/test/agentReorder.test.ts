// 設定 → エージェントの並べ替えの計算（client/src/lib/agentReorder.ts）。DOM も api も読み込まない純関数だけを固定する。
// ここが崩れると、ドラッグの挿入先・追従量・行の並びがずれ、確定した順がカタログへ反映されない。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_DRAG_SCROLL_STEP,
  applyAgentOrder,
  dropIndexFor,
  dropTargetFor,
  edgeScrollStep,
  moveAgentId,
  reorderRows,
  scrollableAncestor,
} from "../src/lib/agentReorder";

test("dropIndexFor は中心線を越えた行の数を挿入先にする", () => {
  const centers = [10, 30, 50];
  assert.equal(dropIndexFor(centers, 0), 0);
  // 中心線と同じ位置は越えていない (上の行の直前に入る)
  assert.equal(dropIndexFor(centers, 10), 0);
  assert.equal(dropIndexFor(centers, 11), 1);
  assert.equal(dropIndexFor(centers, 40), 2);
  assert.equal(dropIndexFor(centers, 999), 3);
  assert.equal(dropIndexFor([], 50), 0);
});

test("dropTargetFor は掴んだ行を除いた中心線から挿入先を求める", () => {
  // [a, b, c] で a (from=0) を掴んでいる。他は b(130) と c(160) が見えている
  const down = (pointerY: number) => moveAgentId(["a", "b", "c"], 0, dropTargetFor([130, 160], pointerY, 0));
  assert.deepEqual(down(100), ["a", "b", "c"], "b の中心線より上では動かない");
  assert.deepEqual(down(140), ["b", "a", "c"]);
  assert.deepEqual(down(165), ["b", "c", "a"]);
  // c (from=2) を上へ: 自分の中心線より下では動かない
  const up = (pointerY: number) => moveAgentId(["a", "b", "c"], 2, dropTargetFor([100, 130], pointerY, 2));
  assert.deepEqual(up(140), ["a", "b", "c"], "自分の位置のまま");
  assert.deepEqual(up(125), ["a", "c", "b"]);
  assert.deepEqual(up(90), ["c", "a", "b"]);
});

test("moveAgentId は前後のどちらへ動かしても 1 件だけ動かす", () => {
  const ids = ["a", "b", "c", "d"];
  // 前へ動かす: 挿入先の添字がそのまま位置になる
  assert.deepEqual(moveAgentId(ids, 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(moveAgentId(ids, 2, 0), ["c", "a", "b", "d"]);
  // 後ろへ動かす: 挿入先は移動前の添字で数えるので 1 つ手前になる
  assert.deepEqual(moveAgentId(ids, 0, 3), ["b", "c", "a", "d"]);
  assert.deepEqual(moveAgentId(ids, 1, 4), ["a", "c", "d", "b"]);
  // 動かさない位置 (自分の直前 / 直後) と範囲外は同じ並びを返す
  assert.deepEqual(moveAgentId(ids, 1, 1), ids);
  assert.deepEqual(moveAgentId(ids, 1, 2), ids);
  assert.deepEqual(moveAgentId(ids, 9, 0), ids);
  assert.notEqual(moveAgentId(ids, 0, 1), ids, "元の配列を書き換えない");
});

test("reorderRows は渡した id だけを並べ替え、ビルトインなど他の行は位置を保つ", () => {
  const rows = [{ id: "agent-general" }, { id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    reorderRows(rows, ["c", "a", "b"]).map((row) => row.id),
    ["agent-general", "c", "a", "b"],
  );
  // 渡した id は、それらが元々占めていた位置へ順に入る (欠けた id でビルトインを動かさない)
  assert.deepEqual(
    reorderRows(rows, ["c"]).map((row) => row.id),
    ["agent-general", "a", "b", "c"],
  );
  assert.deepEqual(
    reorderRows(rows, ["b", "a"]).map((row) => row.id),
    ["agent-general", "b", "a", "c"],
  );
  assert.deepEqual(
    reorderRows(rows, []).map((row) => row.id),
    ["agent-general", "a", "b", "c"],
  );
});

test("reorderRows は渡した id を、スペース一覧でも既定の先頭と新しい行の位置を保って並べ替える", () => {
  // 既定スペースは先頭固定、`d` は保存待ちの間に作られた行。どちらも渡さなければ位置を変えない
  const rows = [{ id: "default" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(
    reorderRows(rows, ["default", "c", "a", "b"]).map((row) => row.id),
    ["default", "c", "a", "b", "d"],
  );
  // 応答から消えた行 (削除済み) は現れない
  assert.deepEqual(
    reorderRows(
      rows.filter((row) => row.id !== "b"),
      ["default", "c", "a", "b"],
    ).map((row) => row.id),
    ["default", "c", "a", "d"],
  );
});

test("applyAgentOrder はサーバーの順に並べ、渡されなかった行を末尾へ回す", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    applyAgentOrder(agents, ["c", "a", "b"]).map((agent) => agent.id),
    ["c", "a", "b"],
  );
  // 未知の id は捨て、渡されなかった行は元の相対順のまま末尾
  assert.deepEqual(
    applyAgentOrder(agents, ["b", "missing"]).map((agent) => agent.id),
    ["b", "a", "c"],
  );
  // 定義オブジェクトはそのまま使う (順序だけを差し替える)
  assert.equal(applyAgentOrder(agents, ["b", "a", "c"])[0], agents[1]);
});

test("edgeScrollStep は帯の外では 0、端に近いほど大きい", () => {
  // 100..200 の枠で帯 48。上の帯 (100..148) / 下の帯 (152..200) の内側だけ動く
  assert.equal(edgeScrollStep(150, 100, 200), 0);
  assert.ok(edgeScrollStep(101, 100, 200) < 0, "上端では上へ回す");
  assert.ok(edgeScrollStep(199, 100, 200) > 0, "下端では下へ回す");
  assert.equal(edgeScrollStep(100, 100, 200), -AGENT_DRAG_SCROLL_STEP);
  assert.equal(edgeScrollStep(200, 100, 200), AGENT_DRAG_SCROLL_STEP);
  // 端から離れるほど小さい
  assert.ok(Math.abs(edgeScrollStep(140, 100, 200)) < AGENT_DRAG_SCROLL_STEP);
  // 低い一覧では帯を容器の半分までに抑える (常に最大で回さない)
  assert.equal(edgeScrollStep(40, 40, 50), -AGENT_DRAG_SCROLL_STEP);
  assert.equal(edgeScrollStep(45, 40, 50), 0);
});

test("scrollableAncestor は実際にスクロールしている祖先を返し、無ければ null", () => {
  const page = { parentElement: null, scrollHeight: 2000, clientHeight: 800 };
  const shortList = { parentElement: page, scrollHeight: 300, clientHeight: 300 };
  const longList = { parentElement: page, scrollHeight: 900, clientHeight: 300 };
  const row = { parentElement: longList, scrollHeight: 30, clientHeight: 30 };

  assert.equal(scrollableAncestor(row), longList);
  // 一覧が短く内部スクロールが起きていないときはページ側 (呼び出し側のフォールバック) になる
  assert.equal(scrollableAncestor(shortList), page);
  assert.equal(scrollableAncestor(page), page);
  assert.equal(scrollableAncestor(null), null);
  // 1px の端数ではスクロール扱いにしない (行の translate を毎フレームの対象にしない)
  assert.equal(scrollableAncestor({ parentElement: null, scrollHeight: 301, clientHeight: 300 }), null);
});
