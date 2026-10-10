// 設定 → ランタイムの「起動元の会話」の通常クリック。所属が分かる別スペースは会話を URL に載せてから
// スペースを選び直し、同じ / 不明 / 一覧に無い所属は現在のスペースで開く。

import assert from "node:assert/strict";
import test from "node:test";
import type { Space } from "server";
import { openOwnerSession } from "../src/lib/ownerLink";
import type { Route } from "../src/lib/route";

const normal: Space = { id: "default", name: "通常", createdAt: 0 };
const demo: Space = { id: "space-1111111111111111", name: "デモ", createdAt: 1 };

/** 実行した操作の列。載せた会話と、切り替え先 / 開いた会話の ID だけを見る */
function run(ownerSpaceId: string | undefined, spaces: Space[] = [normal, demo]): string[] {
  const calls: string[] = [];
  openOwnerSession("session-1", ownerSpaceId, {
    spaces,
    currentSpaceId: "default",
    navigate: (route: Route) => calls.push(`navigate:${route.view === "chat" ? route.sessionId : route.section}`),
    selectSpace: (spaceId) => calls.push(`select:${spaceId}`),
    openInPlace: (sessionId) => calls.push(`open:${sessionId}`),
  });
  return calls;
}

test("所属が分かる別スペースは、会話を URL に載せてからスペースを選び直す", () => {
  assert.deepEqual(run(demo.id), ["navigate:session-1", `select:${demo.id}`]);
});

test("現在のスペース・所属不明・一覧に無い所属は現在のスペースで開く", () => {
  assert.deepEqual(run(normal.id), ["open:session-1"]);
  assert.deepEqual(run(undefined), ["open:session-1"]);
  assert.deepEqual(run("unknown"), ["open:session-1"]);
});
