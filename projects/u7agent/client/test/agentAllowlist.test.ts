// エージェント定義の許可リスト (undefined / null / 配列) の判定と一括操作。画面の個別切替・
// グループの「すべて外す」・タブの件数はすべてこの純関数を通す。ここが崩れると、検索中に隠れた行まで
// 外れたり、一括操作で一覧に無い保存名が消えたりする。
import assert from "node:assert/strict";
import test from "node:test";
import {
  allowlistCount,
  allowlistCountLabel,
  allowedNames,
  disableGroup,
  isExplicitAllowlist,
  missingNames,
  toggleAllowed,
  usedCount,
} from "../src/lib/agentAllowlist";

const VISIBLE = ["alpha", "beta", "gamma"];

test("未指定と解除は全可視、明示リストはその配列をそのまま使う", () => {
  assert.equal(isExplicitAllowlist(undefined), false);
  assert.equal(isExplicitAllowlist(null), false);
  assert.equal(isExplicitAllowlist([]), true);
  assert.deepEqual(allowedNames(undefined, VISIBLE), VISIBLE);
  assert.deepEqual(allowedNames(null, VISIBLE), VISIBLE);
  assert.deepEqual(allowedNames([], VISIBLE), []);
  assert.deepEqual(allowedNames(["gone"], VISIBLE), ["gone"], "一覧に無い保存名も残す");
});

test("個別切替は未指定から見えている一覧を固定し、一覧に無い保存名を落とさない", () => {
  // 未指定から 1 件外す → その時点の一覧 − 対象 を明示リストにする
  assert.deepEqual(toggleAllowed(undefined, "alpha", false, VISIBLE), ["beta", "gamma"]);
  assert.deepEqual(toggleAllowed(null, "alpha", false, VISIBLE), ["beta", "gamma"]);
  // 明示リストでは対象の名前だけを増減する
  assert.deepEqual(toggleAllowed(["alpha", "gone"], "beta", true, VISIBLE), ["alpha", "gone", "beta"]);
  assert.deepEqual(toggleAllowed(["alpha", "beta", "gone"], "alpha", false, VISIBLE), ["beta", "gone"]);
  assert.deepEqual(toggleAllowed(["alpha"], "alpha", true, VISIBLE), ["alpha"], "二重に足さない");
});

test("グループの「すべて外す」は未指定ならスコープの全 visible から対象グループだけを除く", () => {
  // ツールは 1 本の toolNames を共有する。作業ツールを全 OFF にしてもアプリのツールは残る
  const tools = ["read", "bash", "web_search"];
  assert.deepEqual(disableGroup(undefined, ["read", "bash"], tools), ["web_search"]);
  assert.deepEqual(disableGroup(null, ["web_search"], tools), ["read", "bash"]);
  // 明示リストのときは、その配列から対象グループだけを除く (他のグループ・一覧に無い保存名は残す)
  assert.deepEqual(disableGroup(["read", "gone", "web_search"], ["read"], tools), ["gone", "web_search"]);
  assert.deepEqual(disableGroup([], ["read"], tools), []);
});

test("件数は検索で絞る前の visible 行から数え、0 件でも表示する", () => {
  assert.deepEqual(allowlistCount(undefined, VISIBLE), { used: 3, total: 3 });
  assert.deepEqual(allowlistCount(["alpha", "beta"], VISIBLE), { used: 2, total: 3 });
  assert.deepEqual(allowlistCount([], VISIBLE), { used: 0, total: 3 });
  assert.equal(allowlistCountLabel({ used: 0, total: 0 }), "使用 0 / 全 0");
  assert.equal(usedCount(["gone"], VISIBLE), 0, "一覧に無い保存名は使用中に数えない");
});

test("一覧に無い保存名は明示リストのときだけ拾う", () => {
  assert.deepEqual(missingNames(undefined, VISIBLE), []);
  assert.deepEqual(missingNames(null, VISIBLE), []);
  assert.deepEqual(missingNames(["alpha", "gone"], VISIBLE), ["gone"]);
});
