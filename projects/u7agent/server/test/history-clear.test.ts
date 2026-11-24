// 会話履歴のクリアの確定点と片付け (server/src/history-clear.ts) を検証する。
//   - 確定点で保存する meta は、手動タイトルだけを残し、消した履歴の要約の材料と試行を落とし、
//     未使用の参照チップだけを解除する
//   - 確定前の失敗 (保存・組み立ての拒否) では止めた書込みを解き、確定後は解かない
//   - 片付けの削除に失敗したら、実測と片付けの印を消さずに片付け待ちとして返す

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupHistoryClear,
  clearedSessionMeta,
  confirmHistoryClear,
  type HistoryClearPort,
} from "../src/history-clear";
import type { SessionRecord } from "../src/session-record";
import { sessionDirPath, sessionJsonlPath, type SessionMeta } from "../src/session-store";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    version: 1,
    id: "a1b2c3d4e5",
    title: "",
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 3,
    agentId: "default",
    agent: { id: "default", name: "既定", description: "" },
    promptSnapshot: { agent: "<agent_profile />" },
    ...overrides,
  };
}

const record = { clearingHistory: false } as unknown as SessionRecord;

/** 手順が触る口だけを記録する。`saveError` で確定の保存だけを失敗させる */
function fakePort(options: { current?: SessionMeta; saveError?: Error } = {}) {
  const calls: string[] = [];
  const saved: SessionMeta[] = [];
  const port: HistoryClearPort = {
    holdWrites: () => {
      calls.push("hold");
    },
    releaseWrites: () => {
      calls.push("release");
    },
    drainWrites: () => {
      calls.push("drain");
      return Promise.resolve();
    },
    currentMeta: () => options.current,
    saveMeta: (next) => {
      calls.push("save");
      if (options.saveError) return Promise.reject(options.saveError);
      saved.push(next);
      return Promise.resolve();
    },
    releaseRecord: () => {
      calls.push("releaseRecord");
      return Promise.resolve();
    },
    deleteAssistantMetrics: () => {
      calls.push("deleteAssistantMetrics");
    },
  };
  return { port, calls, saved };
}

test("手動タイトルだけを残し、自動のタイトルは空へ戻す", () => {
  const manual = clearedSessionMeta(meta({ title: "直した名前", titleOrigin: "manual" }), {}, "g2");
  assert.equal(manual.title, "直した名前");
  assert.equal(manual.titleOrigin, "manual");

  // AI 要約のタイトルも履歴のクリアで戻す (由来は auto へ揃える)
  const auto = clearedSessionMeta(meta({ title: "AI が付けた名前", titleOrigin: "ai" }), {}, "g2");
  assert.equal(auto.title, "");
  assert.equal(auto.titleOrigin, "auto");

  // 由来が欠落した旧 meta は既存のタイトルを手動として扱う (session-title の titleOriginOf)
  const legacy = clearedSessionMeta(meta({ title: "旧い会話" }), {}, "g2");
  assert.equal(legacy.title, "旧い会話");
  assert.equal(legacy.titleOrigin, "manual");
});

test("消した履歴の要約の材料と試行を落とし、新しい世代と片付け待ちを立てる", () => {
  const updated = clearedSessionMeta(
    meta({
      messageCount: 12,
      historyGeneration: "g1",
      titleRequest: "依頼本文",
      titleAttempt: { runId: "r1", at: 1, state: "pending", trigger: "auto", generation: 3 },
    }),
    {},
    "g2",
  );
  assert.equal(updated.messageCount, 0);
  assert.equal(updated.historyGeneration, "g2");
  assert.equal(updated.historyCleanup, true);
  assert.equal(updated.titleRequest, undefined);
  assert.equal(updated.titleAttempt, undefined);
  assert.equal("titleRequest" in updated, false);
  assert.equal("titleAttempt" in updated, false);
});

test("参照チップは解除し、引き継ぎの記録とメモの有無は残す", () => {
  const handoff = { operationId: "abc12345", at: 10, memo: true, consumed: false };
  const updated = clearedSessionMeta(meta({ handoff }), {}, "g2");
  assert.deepEqual(updated.handoff, { ...handoff, consumed: true });

  // 引き継ぎを受けていない会話に記録を足さない
  assert.equal("handoff" in clearedSessionMeta(meta(), {}, "g2"), false);
});

test("モデルと Effort は渡されたときだけ上書きする", () => {
  const kept = clearedSessionMeta(meta({ model: "p/m1", thinkingLevel: "low" }), {}, "g2");
  assert.equal(kept.model, "p/m1");
  assert.equal(kept.thinkingLevel, "low");

  const replaced = clearedSessionMeta(
    meta({ model: "p/m1", thinkingLevel: "low" }),
    { model: "p/m2", thinkingLevel: "high" },
    "g2",
  );
  assert.equal(replaced.model, "p/m2");
  assert.equal(replaced.thinkingLevel, "high");
});

test("確定は書込みを止めて drain し、組み直した meta を保存する", async () => {
  const current = meta({ title: "依頼の会話" });
  const { port, calls, saved } = fakePort({ current });
  const updated = meta({ title: "", historyGeneration: "g2", historyCleanup: true });
  const result = await confirmHistoryClear(port, {
    live: record,
    buildMeta: (given) => {
      calls.push(`build:${given.title}`);
      return updated;
    },
  });
  assert.deepEqual(calls, ["hold", "drain", "build:依頼の会話", "save"]);
  assert.deepEqual(result, { kind: "confirmed", meta: updated });
  assert.deepEqual(saved, [updated]);
});

test("未ロードの会話では record を触らずに保存する", async () => {
  const updated = meta({ historyGeneration: "g2" });
  const { port, calls } = fakePort({ current: meta() });
  await confirmHistoryClear(port, { live: undefined, buildMeta: () => updated });
  assert.deepEqual(calls, ["save"]);
});

test("確定前の保存の失敗は、止めた書込みを解いて投げ直す", async () => {
  const { port, calls } = fakePort({ current: meta(), saveError: new Error("ENOSPC") });
  await assert.rejects(confirmHistoryClear(port, { live: record, buildMeta: () => meta() }), /ENOSPC/);
  assert.deepEqual(calls, ["hold", "drain", "save", "release"]);
});

test("確定前の組み立ての拒否 (409 相当) でも、止めた書込みを解く", async () => {
  const { port, calls } = fakePort({ current: meta() });
  await assert.rejects(
    confirmHistoryClear(port, {
      live: record,
      buildMeta: () => {
        throw new Error("会話履歴が別の操作で変わりました");
      },
    }),
    /会話履歴が別の操作で変わりました/,
  );
  assert.deepEqual(calls, ["hold", "drain", "release"]);
});

test("消すものが無ければ書かずに止めた書込みを解き、確定前の meta を返す", async () => {
  const current = meta({ title: "自動", historyGeneration: "g1" });
  const { port, calls } = fakePort({ current });
  const result = await confirmHistoryClear(port, { live: record, buildMeta: () => undefined });
  assert.deepEqual(calls, ["hold", "drain", "release"]);
  assert.deepEqual(result, { kind: "unchanged", meta: current });
});

test("待機の後に meta が消えていれば、書かずに missing を返す", async () => {
  const { port, calls } = fakePort();
  const result = await confirmHistoryClear(port, { live: record, buildMeta: () => meta() });
  // 対象が消えている record にはもう書かないため、止めた書込みは解かない
  assert.deepEqual(calls, ["hold", "drain"]);
  assert.deepEqual(result, { kind: "missing" });
});

test("片付けは履歴を消し、実測を消してから片付けの印を落として保存する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "history-clear-"));
  const id = "a1b2c3d4e5";
  try {
    await mkdir(sessionDirPath(storeDir, id), { recursive: true });
    await writeFile(sessionJsonlPath(id, storeDir), "{}\n");
    const { port, calls, saved } = fakePort();
    const cleanupPending = await cleanupHistoryClear({ storeDir }, port, {
      id,
      live: record,
      meta: meta({ historyGeneration: "g2", historyCleanup: true }),
    });
    assert.equal(cleanupPending, false);
    assert.equal(existsSync(sessionJsonlPath(id, storeDir)), false);
    assert.deepEqual(calls, ["releaseRecord", "deleteAssistantMetrics", "save"]);
    assert.equal(saved.at(-1)?.historyCleanup, undefined);
    assert.equal(saved.at(-1)?.historyGeneration, "g2");
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("履歴を消せなければ片付け待ちにし、実測と片付けの印を消さない", async () => {
  const base = await mkdtemp(join(tmpdir(), "history-clear-"));
  // 保存先がディレクトリでないときの削除失敗 (ENOTDIR) を、一時ファイルで再現する
  const storeDir = join(base, "not-a-dir");
  try {
    await writeFile(storeDir, "");
    const { port, calls } = fakePort();
    const cleanupPending = await cleanupHistoryClear({ storeDir }, port, {
      id: "a1b2c3d4e5",
      live: record,
      meta: meta({ historyGeneration: "g2", historyCleanup: true }),
    });
    assert.equal(cleanupPending, true);
    assert.deepEqual(calls, ["releaseRecord"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
