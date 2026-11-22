// 会話履歴のクリア (POST /api/sessions/:id/history/clear) を検証する。
//   - 同じ ID / URL のままメッセージ・圧縮要約・未送信・生ログだけを消し、会話の行と作業フォルダ /
//     HANDOFF.md / 設定 / 時刻は残す
//   - 確認時点の履歴世代が古い / busy / 片付け中は 409 にし、二重要求で誤って消さない
//   - 未ロードでも削除のために SDK セッションや作業フォルダを作らず、JSONL の設定記録を復元して保存する
//   - 確定後の片付けに失敗したら 200 + cleanupPending で返し、次に開いたときに削除から再試行する

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionHistoryClearResponseSchema } from "../src/schema";
import {
  parseSessionFile,
  readSessionMeta,
  serializeSession,
  sessionJsonlPath,
  sessionMetaPath,
  sessionSendsPath,
  writeSessionMeta,
} from "../src/session-store";
import { sessionWorkdirRel } from "../src/app-paths";
import type { TitleSummaryGenerate, TitleSummaryGenerateInput, TitleSummaryResult } from "../src/title-summary";
import { asPiBff, createStubPi, STUB_MODEL, waitFor } from "./stub-pi";

const MODEL = `${STUB_MODEL.provider}/${STUB_MODEL.id}`;

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonPatch = (payload: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** 会話ストアありのセッション作成が通る最小のサンドボックス (実ファイルは触らない) */
function stubWorkspace(): SandboxWorkspaceClient {
  return {
    previewFile: async () => ({ text: "" }),
    statFile: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    getGitInfo: async () => ({ branch: null }),
    listSkills: async () => ({ skills: [] }),
    createDir: async (path: string) => ({ path }),
    renameEntry: async (path: string, name: string) => ({ path, name }),
    deleteFile: async () => {},
    deleteDirectory: async () => {},
    uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
    rawFile: async () => ({ status: 200, contentType: "image/png", body: null }),
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
      body: null,
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  };
}

async function withPaths<T>(run: (paths: { root: string; store: string }) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "u7agent-clear-history-"));
  try {
    return await run({ root: join(base, "workspace"), store: join(base, "store") });
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function openBff(
  paths: { root: string; store: string },
  options: {
    pi?: ReturnType<typeof createStubPi>;
    generate?: TitleSummaryGenerate;
  } = {},
) {
  return createBffApp({
    cwd: paths.root,
    sessionStoreDir: paths.store,
    pi: asPiBff(options.pi ?? createStubPi()),
    workspace: stubWorkspace(),
    ...(options.generate ? { titleSummaryGenerate: options.generate } : {}),
  });
}

type Harness = Awaited<ReturnType<typeof openBff>>;

async function createSession(bff: Harness): Promise<string> {
  const response = await bff.app.request("/api/sessions", jsonPost({}));
  assert.equal(response.status, 201);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function payloadOf(bff: Harness, id: string): Promise<any> {
  return jsonBody(bff.app.request(`/api/sessions/${id}`));
}

async function generationOf(bff: Harness, id: string): Promise<string> {
  return (await payloadOf(bff, id)).historyGeneration ?? "";
}

/** 確認時点の世代を payload から取り、クリアを投げる */
async function clearHistory(
  bff: Harness,
  id: string,
  options: { expect?: string; spaceId?: string } = {},
): Promise<Response> {
  const generation = options.expect ?? (await generationOf(bff, id));
  const query = options.spaceId ? `?spaceId=${options.spaceId}` : "";
  return bff.app.request(`/api/sessions/${id}/history/clear${query}`, jsonPost({ historyGeneration: generation }));
}

async function waitCompleted(bff: Harness, id: string): Promise<void> {
  const record = bff.store.get(id);
  assert.ok(record);
  await waitFor(() => bff.store.statusOf(record) !== "running" && bff.store.statusOf(record) !== "queued", 5000, "run");
}

async function readMeta(id: string, store: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(sessionMetaPath(id, store), "utf8")) as Record<string, any>;
}

/** 保存先のファイルをディレクトリへ差し替えて削除を失敗させる (書込みが止まるまで試す) */
async function replaceWithDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await rm(path, { recursive: true, force: true });
    try {
      await mkdir(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`ファイルをディレクトリに差し替えられませんでした: ${path}`);
}

test("クリアは履歴だけを消し、会話の行・設定・時刻・HANDOFF.md を残す", async () => {
  await withPaths(async (paths) => {
    const bff = await openBff(paths);
    try {
      const id = await createSession(bff);
      const posted = await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "消える会話" }));
      assert.equal(posted.status, 202);
      await waitCompleted(bff, id);
      assert.equal((await bff.app.request(`/api/sessions/${id}/pin`, jsonPatch({ pinned: true }))).status, 200);
      assert.equal((await bff.app.request(`/api/sessions/${id}/notify`, jsonPatch({ notify: true }))).status, 200);
      // 応答の実測は履歴と同じくクリアで消す (会話 id は残るため、消さないと孤児行になる)
      await waitFor(() => bff.appDb.loadAssistantMetrics(id).length === 1, 3000, "metrics row");

      const before = await payloadOf(bff, id);
      const beforeMeta = await readMeta(id, paths.store);
      assert.equal(before.title, "消える会話", "自動タイトルが付いている");
      // 作業フォルダの HANDOFF.md は会話の外にあるため、クリアでも残す
      const workdir = join(paths.root, sessionWorkdirRel(id));
      await mkdir(workdir, { recursive: true });
      await writeFile(join(workdir, "HANDOFF.md"), "引き継ぎメモ", "utf8");
      // 確定前の書換えが残した一時ファイルも、旧データを含むため一緒に消す
      const tempFile = join(paths.store, id, ".meta-deadbeef.json");
      await writeFile(tempFile, JSON.stringify({ title: "旧タイトル" }), "utf8");

      const response = await clearHistory(bff, id);
      assert.equal(response.status, 200);
      const result = SessionHistoryClearResponseSchema.parse(await response.json());
      assert.equal(result.sessionId, id);
      assert.equal(result.changed, true);
      assert.equal(result.cleanupPending, false);
      assert.equal(result.title, "無題のセッション", "自動タイトルは空へ戻る");
      assert.notEqual(result.historyGeneration, before.historyGeneration ?? "");

      // 履歴・生ログ・未送信・応答の実測は消え、元に戻せない
      assert.equal(existsSync(sessionJsonlPath(id, paths.store)), false);
      assert.equal(existsSync(sessionSendsPath(id, paths.store)), false);
      assert.deepEqual(bff.appDb.loadAssistantMetrics(id), []);
      assert.equal((await bff.app.request(`/api/sessions/${id}/raw`)).status, 404);
      const history = await jsonBody(bff.app.request(`/api/sessions/${id}/history`));
      assert.deepEqual(history.items, []);
      assert.equal(history.messageCount, 0);
      assert.equal(existsSync(tempFile), false, "旧データを含む一時ファイルも残らない");
      assert.equal((await bff.app.request(`/api/sessions/${id}/diagnostics`)).status, 200);

      // meta は同じ行のまま。messageCount / タイトル / 履歴の派生値だけが初期化される
      const meta = await readMeta(id, paths.store);
      assert.equal(meta.id, id);
      assert.equal(meta.messageCount, 0);
      assert.equal(meta.title, "");
      assert.equal(meta.titleOrigin, "auto");
      assert.equal(meta.titleRequest, undefined);
      assert.equal(meta.titleAttempt, undefined);
      assert.equal(meta.historyCleanup, undefined);
      assert.equal(meta.historyGeneration, result.historyGeneration);
      assert.equal(meta.pinned, true);
      assert.equal(meta.notify, true);
      assert.equal(meta.createdAt, beforeMeta.createdAt);
      assert.equal(meta.lastUsedAt, beforeMeta.lastUsedAt, "最終利用時刻は維持する");
      assert.equal(meta.agentId, beforeMeta.agentId);
      assert.deepEqual(meta.agent, beforeMeta.agent);
      assert.equal(meta.model, beforeMeta.model);
      assert.equal(meta.thinkingLevel, beforeMeta.thinkingLevel);
      assert.deepEqual(meta.promptSnapshot, beforeMeta.promptSnapshot);
      assert.equal(await readFile(join(workdir, "HANDOFF.md"), "utf8"), "引き継ぎメモ");

      // 同じ URL のまま空の履歴で開き直せる。設定とピン / 通知は変わらない
      const after = await payloadOf(bff, id);
      assert.equal(after.sessionId, id);
      assert.deepEqual(after.messages, []);
      assert.deepEqual(after.compactions, []);
      assert.equal(after.title, "");
      assert.equal(after.pinned, true);
      assert.equal(after.notify, true);
      assert.equal(after.model, before.model);
      assert.equal(after.thinkingLevel, before.thinkingLevel);
      assert.equal(after.historyGeneration, result.historyGeneration);

      // 一覧の表示も「無題のセッション」へ戻る
      const list = await jsonBody(bff.app.request("/api/sessions"));
      const summary = list.sessions.find((item: { sessionId: string }) => item.sessionId === id);
      assert.equal(summary.title, "無題のセッション");
      assert.equal(summary.messageCount, 0);
      assert.equal(summary.historyCleanup, undefined);

      // BFF を再起動しても、クリア後の履歴世代と空の履歴が残る
      await bff.close();
      const restarted = await openBff(paths);
      try {
        const restartedPayload = await payloadOf(restarted, id);
        assert.deepEqual(restartedPayload.messages, []);
        assert.equal(restartedPayload.historyGeneration, result.historyGeneration);
        const restartedSummary = (await jsonBody(restarted.app.request("/api/sessions"))).sessions.find(
          (item: { sessionId: string }) => item.sessionId === id,
        );
        assert.equal(restartedSummary.messageCount, 0);
        assert.deepEqual((await jsonBody(restarted.app.request(`/api/sessions/${id}/history`))).items, []);

        // 次の送信は新しい履歴だけを持ち、旧本文はモデルへ渡る文脈にも残らない
        assert.equal(
          (await restarted.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "新しい会話" }))).status,
          202,
        );
        await waitCompleted(restarted, id);
        const record = restarted.store.get(id);
        assert.ok(record);
        const context = JSON.stringify(record.session.messages);
        assert.ok(context.includes("新しい会話"));
        assert.ok(!context.includes("消える会話"), "旧メッセージを実行の文脈へ戻さない");
      } finally {
        await restarted.close();
      }
    } finally {
      await bff.close();
    }
  });
});

test("手動タイトルは残し、現世代で消すものが無ければ changed:false を返す", async () => {
  await withPaths(async (paths) => {
    const bff = await openBff(paths);
    try {
      const id = await createSession(bff);
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "手動名の会話" }));
      await waitCompleted(bff, id);
      assert.equal(
        (await bff.app.request(`/api/sessions/${id}/title`, jsonPatch({ title: "手動の名前" }))).status,
        200,
      );
      const generation = await generationOf(bff, id);

      const response = await clearHistory(bff, id, { expect: generation });
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { title: string }).title, "手動の名前");
      const meta = await readMeta(id, paths.store);
      assert.equal(meta.title, "手動の名前");
      assert.equal(meta.titleOrigin, "manual");
      assert.equal(meta.titleRequest, undefined);
      assert.equal(meta.titleAttempt, undefined);

      // 現世代で消すものが無い二重のクリアは変更なし (クライアントは自動再試行しない)
      const again = await clearHistory(bff, id, { expect: meta.historyGeneration });
      assert.equal(again.status, 200);
      const result = SessionHistoryClearResponseSchema.parse(await again.json());
      assert.equal(result.changed, false);
      assert.equal(result.historyGeneration, meta.historyGeneration);

      // 確認時の世代が古い (別タブが先にクリアした) 要求は 409 で、履歴世代も変えない
      const stale = await clearHistory(bff, id, { expect: generation });
      assert.equal(stale.status, 409);
      assert.match(((await stale.json()) as { error: string }).error, /別の操作で変わりました/);
      assert.equal((await readMeta(id, paths.store)).historyGeneration, meta.historyGeneration);
    } finally {
      await bff.close();
    }
  });
});

test("未使用の引き継ぎチップをクリアで解除し、記録と HANDOFF.md は残す", async () => {
  await withPaths(async (paths) => {
    const bff = await openBff(paths);
    try {
      const id = await createSession(bff);
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "引き継ぎ前" }));
      await waitCompleted(bff, id);
      // 未使用のチップを持つ状態を直接作る (move の副作用は sessions-move.test.ts が見る)
      const live = bff.store.get(id);
      assert.ok(live);
      const withHandoff = {
        ...live.meta,
        handoff: { operationId: "abcd1234", at: Date.now(), memo: true, consumed: false },
      };
      live.meta = withHandoff;
      bff.store.descriptors.set(id, withHandoff);
      await writeSessionMeta(paths.store, withHandoff);
      const handoffBefore = (await payloadOf(bff, id)).handoff;
      assert.equal(handoffBefore.consumed, false);
      const workdir = join(paths.root, sessionWorkdirRel(id));
      await mkdir(workdir, { recursive: true });
      await writeFile(join(workdir, "HANDOFF.md"), "既存のメモ", "utf8");

      const response = await clearHistory(bff, id);
      assert.equal(response.status, 200);
      const meta = await readMeta(id, paths.store);
      assert.equal(meta.handoff.operationId, handoffBefore.operationId);
      assert.equal(meta.handoff.at, handoffBefore.at);
      assert.equal(meta.handoff.memo, handoffBefore.memo);
      assert.equal(meta.handoff.consumed, true, "クリアでチップを解除する");

      // チップの表示条件 (memo かつ未消費) が満たされず、既存のメモは残る
      const payload = await payloadOf(bff, id);
      assert.equal(payload.handoff.consumed, true);
      assert.equal(await readFile(join(workdir, "HANDOFF.md"), "utf8"), "既存のメモ");
    } finally {
      await bff.close();
    }
  });
});

test("実行中・キュー待ち・片付け中・別スペース・二重要求は 409 / 404 で断る", async () => {
  await withPaths(async (paths) => {
    const pi = createStubPi({ chunkDelayMs: 300 });
    const bff = await openBff(paths, { pi });
    try {
      const space = (await jsonBody(bff.app.request("/api/spaces", jsonPost({ name: "別スペース" })))).space
        .id as string;
      const id = await createSession(bff);
      const generation = await generationOf(bff, id);

      // 実行中
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "時間のかかる会話" }));
      assert.equal((await clearHistory(bff, id, { expect: generation })).status, 409);
      // キュー待ち
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "待機する会話" }));
      assert.equal((await clearHistory(bff, id, { expect: generation })).status, 409);
      await bff.app.request(`/api/sessions/${id}/stop`, { method: "POST" });
      await waitCompleted(bff, id);

      // 要求元スペースの不一致と未知の会話
      const otherSpace = await bff.app.request(
        `/api/sessions/${id}/history/clear?spaceId=${space}`,
        jsonPost({ historyGeneration: generation }),
      );
      assert.equal(otherSpace.status, 404);
      const unknown = await bff.app.request(
        "/api/sessions/deadbeef00/history/clear",
        jsonPost({ historyGeneration: "" }),
      );
      assert.equal(unknown.status, 404);

      // 引き継ぎの片付け待ち / 履歴の片付け待ちは、それぞれの文言で 409
      const live = bff.store.get(id);
      assert.ok(live);
      live.meta = { ...live.meta, handoffCleanup: true };
      bff.store.descriptors.set(id, live.meta);
      const handoffBlocked = await clearHistory(bff, id, { expect: generation });
      assert.equal(handoffBlocked.status, 409);
      assert.match(((await handoffBlocked.json()) as { error: string }).error, /引き継ぎの片付け/);
      live.meta = { ...live.meta, handoffCleanup: false, historyCleanup: true };
      bff.store.descriptors.set(id, live.meta);
      const cleanupBlocked = await clearHistory(bff, id, { expect: generation });
      assert.equal(cleanupBlocked.status, 409);
      assert.match(((await cleanupBlocked.json()) as { error: string }).error, /会話履歴の片付け/);
      live.meta = { ...live.meta, historyCleanup: false };
      bff.store.descriptors.set(id, live.meta);

      // 二重要求は先に受理した方だけが成立し、もう片方は 409 になる
      const [first, second] = await Promise.all([
        clearHistory(bff, id, { expect: generation }),
        clearHistory(bff, id, { expect: generation }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [200, 409]);
      assert.equal((await readMeta(id, paths.store)).messageCount, 0);
    } finally {
      await bff.close();
    }
  });
});

test("待機中に引っ越しが確定したら、移動先の会話へクリアを効かせない", async () => {
  await withPaths(async (paths) => {
    const bff = await openBff(paths);
    try {
      const space = (await jsonBody(bff.app.request("/api/spaces", jsonPost({ name: "移動先" })))).space.id as string;
      const id = await createSession(bff);
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "引っ越す前の会話" }));
      await waitCompleted(bff, id);
      const generation = await generationOf(bff, id);
      // 保存待ちの最終 meta ではなく、live の現在値 (クリアが読む値) を基準にする
      const liveBefore = bff.store.get(id);
      assert.ok(liveBefore);
      const before = {
        title: liveBefore.title,
        messageCount: liveBefore.meta.messageCount,
        historyGeneration: liveBefore.meta.historyGeneration,
        handoff: liveBefore.meta.handoff,
      };

      // 先行する引っ越しが lifecycle を握っている状態を作り、クリアを待たせる
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      bff.store.lifecycle.set(id, held);
      const pending = clearHistory(bff, id, { expect: generation });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // 待機中に引っ越しが確定した状態 (所属だけ移動先へ変わる) を再現する
      const live = bff.store.get(id);
      assert.ok(live);
      const movedMeta = { ...live.meta, spaceId: space };
      live.meta = movedMeta;
      bff.store.descriptors.set(id, movedMeta);
      await writeSessionMeta(paths.store, movedMeta);
      release();

      // 要求元 (default) のクリアは 404 になり、移動先の会話は何も変わらない
      const response = await pending;
      assert.equal(response.status, 404);
      const after = await readMeta(id, paths.store);
      assert.equal(after.spaceId, space);
      assert.equal(after.title, before.title);
      assert.equal(after.messageCount, before.messageCount);
      assert.equal(after.historyGeneration, before.historyGeneration);
      assert.equal(after.handoff, before.handoff);
      assert.equal(existsSync(sessionJsonlPath(id, paths.store)), true);
      assert.deepEqual((await bff.store.payload(live)).messages.length, 2);

      // 移動先のスペースからは通常どおりクリアできる
      const retry = await bff.app.request(
        `/api/sessions/${id}/history/clear?spaceId=${space}`,
        jsonPost({ historyGeneration: generation }),
      );
      assert.equal(retry.status, 200);
      assert.equal(((await retry.json()) as { changed: boolean }).changed, true);
    } finally {
      await bff.close();
    }
  });
});

test("クリアの後に古い record を掴んだ送信・設定変更は始まらない", async () => {
  await withPaths(async (paths) => {
    const bff = await openBff(paths);
    try {
      const id = await createSession(bff);
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "古い会話" }));
      await waitCompleted(bff, id);
      const stale = await bff.store.resolve(id);
      assert.ok(stale);
      assert.equal((await clearHistory(bff, id)).status, 200);
      // await を挟む route が古い record を持っていても、確定後は副作用を起こさない
      assert.throws(() => bff.store.postMessage(stale, "古い record からの送信"), /会話の状態が変わった/);
      await assert.rejects(() => bff.store.updateSettings(stale, { thinkingLevel: "high" }), /会話の状態が変わった/);
      const record = bff.store.get(id);
      assert.equal(record, undefined, "クリア後は別の load で開き直す");
      const payload = await payloadOf(bff, id);
      assert.deepEqual(payload.messages, []);
      assert.equal((await readMeta(id, paths.store)).messageCount, 0);
    } finally {
      await bff.close();
    }
  });
});

test("未ロードの会話でも SDK / 作業フォルダを作らず、JSONL の設定記録を復元して保存する", async () => {
  await withPaths(async (paths) => {
    const bff1 = await openBff(paths);
    const created = await bff1.app.request("/api/sessions", jsonPost({}));
    const id = ((await created.json()) as { sessionId: string }).sessionId;
    await bff1.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "未ロードで消す会話" }));
    await waitCompleted(bff1, id);
    await bff1.close();

    // meta の設定を別の値にし、JSONL の model_change / thinking_level_change を現行の復元規則で選ばせる
    const meta = await readSessionMeta(paths.store, id);
    assert.ok(meta);
    await writeSessionMeta(paths.store, { ...meta, model: "stub/stub-plain", thinkingLevel: "off" });
    const file = sessionJsonlPath(id, paths.store);
    const parsed = parseSessionFile(await readFile(file, "utf8"), id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const lastId = (parsed.entries[parsed.entries.length - 1]?.id as string) ?? null;
    const modelChange = {
      type: "model_change",
      id: "entry-model",
      parentId: lastId,
      timestamp: new Date().toISOString(),
      provider: STUB_MODEL.provider,
      modelId: STUB_MODEL.id,
    };
    const thinking = {
      type: "thinking_level_change",
      id: "entry-thinking",
      parentId: "entry-model",
      timestamp: new Date().toISOString(),
      thinkingLevel: "high",
    };
    await writeFile(file, serializeSession(parsed.header, [...parsed.entries, modelChange, thinking]));

    // 作業フォルダを消しておき、クリアが削除のために作り直さないことを見る
    const workdir = join(paths.root, sessionWorkdirRel(id));
    await rm(workdir, { recursive: true, force: true });

    const pi2 = createStubPi();
    const bff2 = await openBff(paths, { pi: pi2 });
    try {
      const response = await bff2.app.request(`/api/sessions/${id}/history/clear`, jsonPost({ historyGeneration: "" }));
      assert.equal(response.status, 200);
      assert.equal(pi2.createInputs.length, 0, "クリアのために SDK セッションを開かない");
      assert.equal(existsSync(workdir), false, "クリアのために作業フォルダを作らない");

      const updated = await readMeta(id, paths.store);
      assert.equal(updated.model, MODEL, "JSONL の model_change を保存する");
      assert.equal(updated.thinkingLevel, "high", "JSONL の thinking_level_change を保存する");
      assert.equal(updated.messageCount, 0);

      // 開き直すと、復元された設定で空の履歴から始まる
      const payload = await payloadOf(bff2, id);
      assert.equal(payload.model, MODEL);
      assert.equal(payload.thinkingLevel, "high");
      assert.deepEqual(payload.messages, []);
    } finally {
      await bff2.close();
    }
  });
});

test("JSONL が破損している未ロードの会話は 409 で変更しない", async () => {
  await withPaths(async (paths) => {
    const bff1 = await openBff(paths);
    const created = await bff1.app.request("/api/sessions", jsonPost({}));
    const id = ((await created.json()) as { sessionId: string }).sessionId;
    await bff1.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "壊れた履歴の会話" }));
    await waitCompleted(bff1, id);
    await bff1.close();
    const before = await readMeta(id, paths.store);
    await writeFile(sessionJsonlPath(id, paths.store), '{"type":\n', "utf8");

    const bff2 = await openBff(paths);
    try {
      const response = await bff2.app.request(`/api/sessions/${id}/history/clear`, jsonPost({ historyGeneration: "" }));
      assert.equal(response.status, 409);
      assert.match(((await response.json()) as { error: string }).error, /保存された会話を読めない/);
      const after = await readMeta(id, paths.store);
      assert.equal(after.messageCount, before.messageCount);
      assert.equal(after.historyGeneration, undefined);
      assert.equal(after.title, before.title);
      assert.equal(existsSync(sessionJsonlPath(id, paths.store)), true, "壊れた履歴も変更しない");
    } finally {
      await bff2.close();
    }
  });
});

test("確定後の片付けに失敗したら cleanupPending を返し、次に開いたときに削除から再試行する", async () => {
  await withPaths(async (paths) => {
    const bff = await openBff(paths);
    try {
      const id = await createSession(bff);
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "片付けが残る会話" }));
      await waitCompleted(bff, id);
      const generation = await generationOf(bff, id);
      // 削除だけを失敗させる (ディレクトリは rm できない)
      await replaceWithDirectory(sessionJsonlPath(id, paths.store));

      const response = await clearHistory(bff, id, { expect: generation });
      assert.equal(response.status, 200);
      const result = SessionHistoryClearResponseSchema.parse(await response.json());
      assert.equal(result.changed, true);
      assert.equal(result.cleanupPending, true);
      const meta = await readMeta(id, paths.store);
      assert.equal(meta.historyCleanup, true);
      assert.equal(meta.historyGeneration, result.historyGeneration);
      // 古い履歴を一瞬でも返さない (開く要求は 409)
      const blocked = await bff.app.request(`/api/sessions/${id}`);
      assert.equal(blocked.status, 409);
      assert.match(((await blocked.json()) as { error: string }).error, /会話履歴の片付け/);
      const list = await jsonBody(bff.app.request("/api/sessions"));
      const summary = list.sessions.find((item: { sessionId: string }) => item.sessionId === id);
      assert.equal(summary.historyCleanup, true);

      // 邪魔なものを取り除けば、次に開いたときに削除から再試行して空の履歴で開ける
      await rm(sessionJsonlPath(id, paths.store), { recursive: true, force: true });
      const payload = await payloadOf(bff, id);
      assert.deepEqual(payload.messages, []);
      assert.equal(payload.historyGeneration, result.historyGeneration);
      const cleared = await readMeta(id, paths.store);
      assert.equal(cleared.historyCleanup, undefined, "片付けの印を落とす");
    } finally {
      await bff.close();
    }
  });
});

test("確定中に返った旧世代の AI 要約の結果を使量ごと適用しない", async () => {
  await withPaths(async (paths) => {
    const calls: { input: TitleSummaryGenerateInput; settle: (result: TitleSummaryResult) => void }[] = [];
    const generate: TitleSummaryGenerate = (input) =>
      new Promise<TitleSummaryResult>((resolve) => {
        calls.push({ input, settle: resolve });
      });
    const bff = await openBff(paths, { generate });
    try {
      const settings = { enabled: true, model: MODEL, definition: "日本語で短く。" };
      assert.equal(
        (
          await bff.app.request("/api/settings/session-title", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
          })
        ).status,
        200,
      );
      const id = await createSession(bff);
      await bff.app.request(
        `/api/sessions/${id}/messages`,
        jsonPost({ text: "要約と競合する会話", titleSource: "要約と競合する会話" }),
      );
      await waitCompleted(bff, id);
      await waitFor(() => calls.length === 1, 3000, "title summary started");

      // 要約が返る前にクリアを確定する
      const response = await clearHistory(bff, id);
      assert.equal(response.status, 200);
      calls[0]!.settle({
        ok: true,
        title: "遅れて届いたタイトル",
        usage: { inputTokens: 120, outputTokens: 12, costTotal: 0.0001 },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const payload = await payloadOf(bff, id);
      assert.equal(payload.title, "");
      assert.equal(payload.titleSummary?.attempt, undefined, "旧世代の試行も使用量も書き戻さない");
      const meta = await readMeta(id, paths.store);
      assert.equal(meta.title, "");
      assert.equal(meta.titleAttempt, undefined);
      assert.equal(meta.titleRequest, undefined);
    } finally {
      await bff.close();
    }
  });
});
