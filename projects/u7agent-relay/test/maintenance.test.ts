// クライアントの返信取得に依存しない履歴更新と、稼働中の保持期限を固定する。
import { describe, expect, test } from "bun:test";
import { createRunReconciler } from "../src/server/run-reconciler";
import { bearer, createHarness, jsonResponse, NOW, RUN_ID, SESSION_ID, seedConnection, SPACE_ID } from "./harness";

const DAY = 24 * 60 * 60 * 1000;

describe("実行履歴の維持", () => {
  test("返信取得がなくても上流の完了状態と本文を履歴へ反映する", async () => {
    let session: Record<string, unknown> = {
      sessionId: SESSION_ID,
      spaceId: SPACE_ID,
      status: "idle",
      queueDepth: 0,
    };
    const harness = createHarness({
      fetchImpl: async (_input, init) =>
        (init?.method ?? "GET") === "POST"
          ? jsonResponse({ sessionId: SESSION_ID, queued: false, runId: RUN_ID }, 202)
          : jsonResponse(session),
    });

    try {
      const { token } = seedConnection(harness);
      const posted = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "調べて" }),
      });

      expect(posted.status).toBe(202);
      expect(harness.store.getRun(RUN_ID)?.status).toBe("running");

      session = {
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "completed",
        queueDepth: 0,
        run: { id: RUN_ID, status: "completed" },
        messages: [{ role: "assistant", assistantId: `${RUN_ID}:0`, text: "完了しました" }],
      };

      const reconciler = createRunReconciler({
        store: harness.store,
        upstream: harness.upstream,
        now: () => NOW,
        retentionMs: 90 * DAY,
      });

      await reconciler.reconcile();

      expect(harness.store.getRun(RUN_ID)).toMatchObject({
        status: "completed",
        text: "完了しました",
      });
    } finally {
      harness.cleanup();
    }
  });

  test("上流が失敗しても実行中のまま残す", async () => {
    const harness = createHarness({
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? "GET") === "POST") {
          return jsonResponse({ sessionId: SESSION_ID, queued: false, runId: RUN_ID }, 202);
        }

        throw new TypeError("fetch failed");
      },
    });

    try {
      const { connectionId, keyId } = seedConnection(harness);

      harness.store.insertRun({
        runId: RUN_ID,
        connectionId,
        keyId,
        status: "running",
        sessionUrl: "https://agent.example.com/s/0123456789?space=default",
        createdAt: NOW,
        updatedAt: NOW,
      });

      const reconciler = createRunReconciler({
        store: harness.store,
        upstream: harness.upstream,
        now: () => NOW,
        retentionMs: 90 * DAY,
      });

      await reconciler.reconcile();

      expect(harness.store.getRun(RUN_ID)?.status).toBe("running");
    } finally {
      harness.cleanup();
    }
  });

  test("上流で見つからない古い実行は error に確定する", async () => {
    const harness = createHarness({
      fetchImpl: async () =>
        jsonResponse({ sessionId: SESSION_ID, spaceId: SPACE_ID, status: "idle", queueDepth: 0, run: null }),
    });

    try {
      const { connectionId, keyId } = seedConnection(harness);
      const runId = "3333333333333333";

      harness.store.insertRun({
        runId,
        connectionId,
        keyId,
        status: "running",
        sessionUrl: "https://agent.example.com/s/0123456789?space=default",
        createdAt: NOW - 2 * DAY,
        updatedAt: NOW - 2 * DAY,
      });

      const reconciler = createRunReconciler({
        store: harness.store,
        upstream: harness.upstream,
        now: () => NOW,
        retentionMs: 90 * DAY,
      });

      await reconciler.reconcile();

      expect(harness.store.getRun(runId)).toMatchObject({ status: "error", error: "run_missing" });
    } finally {
      harness.cleanup();
    }
  });

  test("90 日を過ぎた履歴は再起動しなくても削除する", async () => {
    const harness = createHarness();

    try {
      const { connectionId, keyId } = seedConnection(harness);
      const insert = (runId: string, createdAt: number) =>
        harness.store.insertRun({
          runId,
          connectionId,
          keyId,
          status: "completed",
          sessionUrl: "https://agent.example.com/s/0123456789?space=default",
          createdAt,
          updatedAt: createdAt,
        });

      insert("1111111111111111", NOW - 91 * DAY);
      insert("2222222222222222", NOW - 89 * DAY);

      const reconciler = createRunReconciler({
        store: harness.store,
        upstream: harness.upstream,
        now: () => NOW,
        retentionMs: 90 * DAY,
      });

      await reconciler.reconcile();

      expect(harness.store.getRun("1111111111111111")).toBeNull();
      expect(harness.store.getRun("2222222222222222")).not.toBeNull();
    } finally {
      harness.cleanup();
    }
  });
});
