// 会話タイトルの AI 要約の実行タイミング・試行上限・競合を検証する。
//   - 初回の本文あり正常完了の直後に 1 回だけ生成し、成功したときだけ仮タイトルを更新する
//   - 2 ターン目・質問待ち・失敗では再生成しない (失敗は自動再試行しない)
//   - 手動改名・設定変更 (Off / 世代) の後に届いた結果は適用しない
//   - 再起動をまたいでも試行は重複しない (予約は外部呼び出しより先に保存する)
//   - usage は診断にだけ載り、依頼本文と生成タイトルは載らない

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import type { TitleSummaryGenerate, TitleSummaryGenerateInput, TitleSummaryResult } from "../src/title-summary";
import { asPiBff, createStubPi, STUB_MODEL, waitFor } from "./stub-pi";

const MODEL = `${STUB_MODEL.provider}/${STUB_MODEL.id}`;
const PROMPT = "あなたはWebアプリケーションのUX改善を支援するアシスタントです。以下の依頼について提案してください。";

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

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** 会話ストアありのセッション作成が通る最小のサンドボックス */
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

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-title-ai-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 1 回ごとに呼び出しを記録し、結果はテストが明示的に確定させる生成器 */
function createControlledGenerator() {
  const calls: { input: TitleSummaryGenerateInput; settle: (result: TitleSummaryResult) => void }[] = [];
  const generate: TitleSummaryGenerate = (input) =>
    new Promise<TitleSummaryResult>((resolve) => {
      calls.push({ input, settle: resolve });
    });
  return { generate, calls };
}

async function openBff(dir: string, generate: TitleSummaryGenerate, pi = createStubPi()) {
  return createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: dir,
    pi: asPiBff(pi),
    workspace: stubWorkspace(),
    titleSummaryGenerate: generate,
  });
}

async function enableSummary(
  bff: Awaited<ReturnType<typeof openBff>>,
  overrides: { definition?: string } = {},
): Promise<void> {
  const res = await bff.app.request(
    "/api/settings/session-title",
    jsonPut({ enabled: true, model: MODEL, definition: overrides.definition ?? "日本語で短く。" }),
  );
  assert.equal(res.status, 200);
}

async function sendTitleMessage(
  bff: Awaited<ReturnType<typeof openBff>>,
  sessionId: string,
  body: string,
): Promise<void> {
  const res = await bff.app.request(
    `/api/sessions/${sessionId}/messages`,
    jsonPost({ text: `${PROMPT}\n\n${body}`, titleSource: body }),
  );
  assert.equal(res.status, 202);
}

/** 非同期の条件を待つ。waitFor は同期の述語だけを受けるため、取得を挟む確認はここで回す */
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
}

async function waitCompleted(bff: Awaited<ReturnType<typeof openBff>>, sessionId: string): Promise<void> {
  const record = bff.store.records.get(sessionId);
  assert.ok(record);
  await waitFor(() => bff.store.statusOf(record) === "completed", 5000, "run completed");
}

test("初回の本文あり正常完了後に 1 回だけ生成し、成功したときだけタイトルを更新する", async () => {
  await withStoreDir(async (dir) => {
    const generator = createControlledGenerator();
    const bff = await openBff(dir, generator.generate);
    try {
      await enableSummary(bff, { definition: "日本語20文字程度で。" });
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const sessionId = created.sessionId as string;

      await sendTitleMessage(bff, sessionId, "ログイン画面のエラー表示を改善したい");
      await waitCompleted(bff, sessionId);
      await waitFor(() => generator.calls.length === 1, 3000, "generate called");

      // 仮タイトルは固定プロンプトではなく個別の依頼から作られている
      const provisional = await jsonBody(bff.app.request(`/api/sessions/${sessionId}`));
      assert.equal(provisional.title, "ログイン画面のエラー表示を改善したい");

      const call = generator.calls[0]!;
      assert.equal(call.input.model.provider, STUB_MODEL.provider);
      assert.equal(call.input.model.id, STUB_MODEL.id);
      assert.equal(call.input.definition, "日本語20文字程度で。");
      assert.equal(call.input.request, "ログイン画面のエラー表示を改善したい");
      assert.equal(call.input.response, "スタブの返答です");

      call.settle({
        ok: true,
        title: "ログイン画面のエラー表示改善",
        usage: { inputTokens: 120, outputTokens: 12, costTotal: 0.0001 },
      });
      await waitUntil(
        async () =>
          (await jsonBody(bff.app.request(`/api/sessions`))).sessions[0].title === "ログイン画面のエラー表示改善",
        3000,
        "ai title applied",
      );

      // 2 ターン目では再生成しない (自動試行は会話ごとに 1 回)
      await sendTitleMessage(bff, sessionId, "商品検索の絞り込み操作も改善したい");
      await waitCompleted(bff, sessionId);
      await new Promise((resolveTick) => setTimeout(resolveTick, 100));
      assert.equal(generator.calls.length, 1);
      assert.equal(
        (await jsonBody(bff.app.request(`/api/sessions/${sessionId}`))).title,
        "ログイン画面のエラー表示改善",
      );

      // usage は診断で確認でき、依頼本文と生成タイトルは載らない
      const diagnostics = await jsonBody(bff.app.request(`/api/sessions/${sessionId}/diagnostics`));
      assert.equal(diagnostics.title.origin, "ai");
      assert.equal(diagnostics.title.attempt.state, "done");
      assert.equal(diagnostics.title.attempt.inputTokens, 120);
      assert.equal(diagnostics.title.attempt.outputTokens, 12);
      assert.equal(diagnostics.title.attempt.model, MODEL);
      const text = JSON.stringify(diagnostics);
      assert.ok(!text.includes("ログイン画面のエラー表示改善"), "生成タイトルを診断へ載せない");
      assert.ok(!text.includes("ログイン画面のエラー表示を改善したい"), "依頼本文を診断へ載せない");

      // meta.json にも由来と試行が保存されている
      const meta = bff.store.descriptors.get(sessionId);
      assert.equal(meta?.titleOrigin, "ai");
      assert.equal(meta?.titleAttempt?.state, "done");
    } finally {
      await bff.close();
    }
  });
});

test("Off ではタイトル用の AI 呼び出しを行わず、判定だけを残す", async () => {
  await withStoreDir(async (dir) => {
    const generator = createControlledGenerator();
    const bff = await openBff(dir, generator.generate);
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const sessionId = created.sessionId as string;
      await sendTitleMessage(bff, sessionId, "商品検索の絞り込み操作を改善したい");
      await waitCompleted(bff, sessionId);
      await new Promise((resolveTick) => setTimeout(resolveTick, 100));

      assert.equal(generator.calls.length, 0);
      const record = bff.store.records.get(sessionId)!;
      assert.equal(record.title, "商品検索の絞り込み操作を改善したい");
      assert.equal(record.meta.titleAttempt?.state, "skipped");
    } finally {
      await bff.close();
    }
  });
});

test("生成に失敗したら仮タイトルを維持し、自動再試行しない", async () => {
  await withStoreDir(async (dir) => {
    const generator = createControlledGenerator();
    const bff = await openBff(dir, generator.generate);
    try {
      await enableSummary(bff);
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const sessionId = created.sessionId as string;
      await sendTitleMessage(bff, sessionId, "請求書のPDF出力を追加したい");
      await waitCompleted(bff, sessionId);
      await waitFor(() => generator.calls.length === 1, 3000, "generate called");

      generator.calls[0]!.settle({ ok: false, error: "rate limited" });
      const record = bff.store.records.get(sessionId)!;
      await waitFor(() => record.meta.titleAttempt?.state === "failed", 3000, "failed attempt");
      assert.equal(record.title, "請求書のPDF出力を追加したい");

      // 後続のターンでも再試行しない (失敗は自動で繰り返さない)
      await sendTitleMessage(bff, sessionId, "つづけて");
      await waitCompleted(bff, sessionId);
      await new Promise((resolveTick) => setTimeout(resolveTick, 100));
      assert.equal(generator.calls.length, 1);
      assert.equal(record.title, "請求書のPDF出力を追加したい");
    } finally {
      await bff.close();
    }
  });
});

test("手動改名の後に届いた生成結果は適用しない", async () => {
  await withStoreDir(async (dir) => {
    const generator = createControlledGenerator();
    const bff = await openBff(dir, generator.generate);
    try {
      await enableSummary(bff);
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const sessionId = created.sessionId as string;
      await sendTitleMessage(bff, sessionId, "ログイン画面のエラー表示を改善したい");
      await waitCompleted(bff, sessionId);
      await waitFor(() => generator.calls.length === 1, 3000, "generate called");

      const renamed = await bff.app.request(`/api/sessions/${sessionId}/title`, jsonPatch({ title: "手動の名前" }));
      assert.equal(renamed.status, 200);
      generator.calls[0]!.settle({ ok: true, title: "AIの名前", usage: undefined });
      const record = bff.store.records.get(sessionId)!;
      await waitFor(() => record.meta.titleAttempt?.state === "skipped", 3000, "skipped attempt");
      assert.equal(record.title, "手動の名前");
    } finally {
      await bff.close();
    }
  });
});

test("Off への変更は進行中の生成を取り消し、後から届いた結果を適用しない", async () => {
  await withStoreDir(async (dir) => {
    const generator = createControlledGenerator();
    const bff = await openBff(dir, generator.generate);
    try {
      await enableSummary(bff);
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const sessionId = created.sessionId as string;
      await sendTitleMessage(bff, sessionId, "商品検索の絞り込み操作を改善したい");
      await waitCompleted(bff, sessionId);
      await waitFor(() => generator.calls.length === 1, 3000, "generate called");
      assert.equal(generator.calls[0]!.input.signal.aborted, false);

      const off = await bff.app.request("/api/settings/session-title", jsonPut({ enabled: false }));
      assert.equal(off.status, 200);
      // 進行中の外部呼び出しは中断され、結果は捨てられる
      assert.equal(generator.calls[0]!.input.signal.aborted, true);

      generator.calls[0]!.settle({ ok: true, title: "AIの名前", usage: undefined });
      const record = bff.store.records.get(sessionId)!;
      await waitFor(() => record.meta.titleAttempt?.state === "skipped", 3000, "skipped attempt");
      assert.equal(record.title, "商品検索の絞り込み操作を改善したい");
      assert.equal(record.meta.titleOrigin, "auto");
    } finally {
      await bff.close();
    }
  });
});

test("定型プロンプトのみ・スキル参照のみ・展開済みブロックでもタイトルが固定文で埋まらない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir, createControlledGenerator().generate);
    try {
      const createSession = async (): Promise<string> =>
        (await jsonBody(bff.app.request("/api/sessions", jsonPost({})))).sessionId as string;

      // 個別依頼が無い定型プロンプトのみは、従来どおりその本文をタイトルにする
      const promptOnly = await createSession();
      await bff.app.request(`/api/sessions/${promptOnly}/messages`, jsonPost({ text: PROMPT }));
      const promptTitle = (await jsonBody(bff.app.request(`/api/sessions/${promptOnly}`))).title as string;
      assert.ok(PROMPT.startsWith(promptTitle));

      // スキル参照のみはスキル名をタイトルにする (空タイトルにしない)
      const skillOnly = await createSession();
      await bff.app.request(`/api/sessions/${skillOnly}/messages`, jsonPost({ text: "/skill:writer" }));
      assert.equal((await jsonBody(bff.app.request(`/api/sessions/${skillOnly}`))).title, "writer");

      // 展開済みのブロックをそのまま送る従来形式でも、後ろの依頼をタイトルにする
      const expanded = await createSession();
      const block = [
        '<skill name="writer" location="/skills/writer/SKILL.md">',
        "スキルの本文です。",
        "</skill>",
        "",
        "商品検索画面の説明文を改善したい",
      ].join("\n");
      await bff.app.request(`/api/sessions/${expanded}/messages`, jsonPost({ text: block }));
      assert.equal(
        (await jsonBody(bff.app.request(`/api/sessions/${expanded}`))).title,
        "商品検索画面の説明文を改善したい",
      );
    } finally {
      await bff.close();
    }
  });
});

test("AI で更新したタイトルは再起動後の一覧・payload でも一致する", async () => {
  await withStoreDir(async (dir) => {
    const generator = createControlledGenerator();
    const first = await openBff(dir, generator.generate);
    let sessionId: string;
    try {
      await enableSummary(first);
      const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
      sessionId = created.sessionId as string;
      await sendTitleMessage(first, sessionId, "ログイン画面のエラー表示を改善したい");
      await waitCompleted(first, sessionId);
      await waitFor(() => generator.calls.length === 1, 3000, "generate called");
      generator.calls[0]!.settle({ ok: true, title: "ログイン画面のエラー表示改善", usage: undefined });
      const record = first.store.records.get(sessionId)!;
      await waitFor(() => record.title === "ログイン画面のエラー表示改善", 3000, "ai title applied");
    } finally {
      await first.close();
    }

    const restarted = await openBff(dir, createControlledGenerator().generate);
    try {
      const listed = await jsonBody(restarted.app.request("/api/sessions"));
      assert.equal(listed.sessions[0].title, "ログイン画面のエラー表示改善");
      const payload = await jsonBody(restarted.app.request(`/api/sessions/${sessionId}`));
      assert.equal(payload.title, "ログイン画面のエラー表示改善");
    } finally {
      await restarted.close();
    }
  });
});

test("既知の秘密値は仮タイトルにも AI 要約の入力にも残さない", async () => {
  const KEY = "sk-ant-dummy-key-0123456789abcdef";
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    pi.retainSecret(KEY);
    const generator = createControlledGenerator();
    const bff = await openBff(dir, generator.generate, pi);
    try {
      await enableSummary(bff);
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const sessionId = created.sessionId as string;
      await sendTitleMessage(bff, sessionId, `鍵 ${KEY} の設定を見直したい`);
      await waitCompleted(bff, sessionId);
      await waitFor(() => generator.calls.length === 1, 3000, "generate called");

      const request = generator.calls[0]!.input.request;
      assert.ok(!request.includes(KEY), request);
      assert.match(request, /\[REDACTED\]/);
      assert.ok(!(bff.store.records.get(sessionId)!.title ?? "").includes(KEY));
    } finally {
      await bff.close();
    }
  });
});

test("予約後に定義が変わったら、古い定義で生成した結果を適用しない", async () => {
  await withStoreDir(async (dir) => {
    const generator = createControlledGenerator();
    const bff = await openBff(dir, generator.generate);
    try {
      await enableSummary(bff, { definition: "最初の定義。" });
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const sessionId = created.sessionId as string;
      await sendTitleMessage(bff, sessionId, "商品検索の絞り込み操作を改善したい");
      await waitCompleted(bff, sessionId);
      await waitFor(() => generator.calls.length === 1, 3000, "generate called");

      // Off ではなく定義の変更でも、予約時の世代と食い違う結果は捨てる
      const resaved = await bff.app.request(
        "/api/settings/session-title",
        jsonPut({ enabled: true, model: MODEL, definition: "新しい定義。" }),
      );
      assert.equal(resaved.status, 200);
      generator.calls[0]!.settle({ ok: true, title: "AIの名前", usage: undefined });
      const record = bff.store.records.get(sessionId)!;
      await waitFor(() => record.meta.titleAttempt?.state === "skipped", 3000, "skipped attempt");
      assert.equal(record.title, "商品検索の絞り込み操作を改善したい");
    } finally {
      await bff.close();
    }
  });
});

test("再起動をまたいでも試行を重複させない", async () => {
  await withStoreDir(async (dir) => {
    const firstGenerator = createControlledGenerator();
    const first = await openBff(dir, firstGenerator.generate);
    let sessionId: string;
    try {
      await enableSummary(first);
      const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
      sessionId = created.sessionId as string;
      await sendTitleMessage(first, sessionId, "ログイン画面のエラー表示を改善したい");
      await waitCompleted(first, sessionId);
      await waitFor(() => firstGenerator.calls.length === 1, 3000, "generate called");
      // 再起動前に予約が保存されている (クラッシュ時も自動再送しない)
      await waitFor(
        () => first.store.descriptors.get(sessionId)?.titleAttempt?.state === "pending",
        3000,
        "attempt persisted",
      );
    } finally {
      await first.close();
    }

    const secondGenerator = createControlledGenerator();
    const second = await openBff(dir, secondGenerator.generate);
    try {
      const opened = await jsonBody(second.app.request(`/api/sessions/${sessionId}`));
      assert.equal(opened.title, "ログイン画面のエラー表示を改善したい");
      await sendTitleMessage(second, sessionId, "続きをお願いします");
      await waitCompleted(second, sessionId);
      await new Promise((resolveTick) => setTimeout(resolveTick, 100));
      assert.equal(secondGenerator.calls.length, 0);
    } finally {
      await second.close();
    }
  });
});
