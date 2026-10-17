// 共通スキルの GUI 編集 API (BFF) を偽クライアントで検証する。パス・版・SDK 検証はサンドボックス側の
// 契約なので、ここでは要求 / 応答の形・上限・失敗の写像と、既存のカタログ経路を壊さないことだけを見る。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SandboxRequestError, type SandboxSkillFileClient } from "../src/sandbox/client";
import type { SandboxSkillCreateBody, SandboxSkillSaveBody, SandboxSkillSaveResult } from "../src/sandbox/protocol";

const DETAIL = {
  name: "alpha",
  description: "説明",
  body: "本文\n",
  relativePath: ".agents/skills/alpha/SKILL.md",
  fileVersion: "a".repeat(64),
  editable: true,
};

interface Recorder {
  client: SandboxSkillFileClient;
  calls: { method: string; input: unknown }[];
}

/** 共通スキル API が使う 5 つのメソッドだけを持つ偽クライアント (他の stub を広げない) */
function skillClient(overrides: Partial<SandboxSkillFileClient> = {}): Recorder {
  const calls: { method: string; input: unknown }[] = [];
  const client: SandboxSkillFileClient = {
    getSkillFile: async (relativePath) => {
      calls.push({ method: "getSkillFile", input: relativePath });
      return { ...DETAIL, relativePath };
    },
    createSkillFile: async (input: SandboxSkillCreateBody) => {
      calls.push({ method: "createSkillFile", input });
      return { relativePath: `.agents/skills/${input.name}/SKILL.md`, fileVersion: "b".repeat(64) };
    },
    saveSkillFile: async (input: SandboxSkillSaveBody): Promise<SandboxSkillSaveResult> => {
      calls.push({ method: "saveSkillFile", input });
      return { relativePath: input.relativePath, fileVersion: "c".repeat(64) };
    },
    previewSkillDelete: async (relativePath) => {
      calls.push({ method: "previewSkillDelete", input: relativePath });
      return {
        relativePath,
        name: "alpha",
        dir: ".agents/skills/alpha",
        treeVersion: "d".repeat(64),
        entries: 2,
        bytes: 10,
        files: ["SKILL.md", "refs/note.txt"],
      };
    },
    deleteSkillFolder: async (relativePath, treeVersion) => {
      calls.push({ method: "deleteSkillFolder", input: { relativePath, treeVersion } });
    },
    ...overrides,
  };
  return { client, calls };
}

async function makeApp(
  client: SandboxSkillFileClient | null,
  root = mkdtempSync(join(tmpdir(), "u7agent-skill-api-")),
) {
  return createBffApp({ cwd: root, sessionStoreDir: null, pi: null, workspace: null, skillSandbox: client });
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

test("編集内容の取得は query をそのまま渡し、応答を検証して返す", async () => {
  const { client, calls } = skillClient();
  const bff = await makeApp(client);
  try {
    const response = await bff.app.request(
      `/api/skills/files/detail?relativePath=${encodeURIComponent(DETAIL.relativePath)}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), DETAIL);
    assert.deepEqual(calls, [{ method: "getSkillFile", input: DETAIL.relativePath }]);

    assert.equal((await bff.app.request("/api/skills/files/detail")).status, 400);
    // 読み取り専用 (保存できない) 応答も 200 で返し、理由を UI へ渡す
    const locked = skillClient({
      getSkillFile: async () => ({
        ...DETAIL,
        editable: false,
        reason: "frontmatter (---) が無い SKILL.md は保存できません",
      }),
    });
    const lockedApp = await makeApp(locked.client);
    try {
      const lockedResponse = await lockedApp.app.request(
        `/api/skills/files/detail?relativePath=${encodeURIComponent(DETAIL.relativePath)}`,
      );
      assert.equal(lockedResponse.status, 200);
      assert.equal(((await lockedResponse.json()) as { editable: boolean }).editable, false);
    } finally {
      await lockedApp.close();
    }
  } finally {
    await bff.close();
  }
});

test("作成は body をそのまま渡して 201 を返し、同名の 409 は文言ごと透過する", async () => {
  const { client, calls } = skillClient();
  const bff = await makeApp(client);
  try {
    const created = await bff.app.request(
      "/api/skills/files",
      jsonInit("POST", { name: "new-skill", description: "d", body: "b" }),
    );
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      relativePath: ".agents/skills/new-skill/SKILL.md",
      fileVersion: "b".repeat(64),
    });
    assert.deepEqual(calls, [{ method: "createSkillFile", input: { name: "new-skill", description: "d", body: "b" } }]);

    // 形の違う body はサンドボックスへ渡さない
    assert.equal((await bff.app.request("/api/skills/files", jsonInit("POST", { description: "d" }))).status, 400);
    assert.equal(
      (await bff.app.request("/api/skills/files", jsonInit("POST", { name: "", description: "d", body: "b" }))).status,
      400,
    );
    assert.equal(calls.length, 1);

    const conflict = skillClient({
      createSkillFile: async () => {
        throw new SandboxRequestError("同名の共通スキルが既にあります: new-skill", 409);
      },
    });
    const conflictApp = await makeApp(conflict.client);
    try {
      const response = await conflictApp.app.request(
        "/api/skills/files",
        jsonInit("POST", { name: "new-skill", description: "d", body: "b" }),
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "同名の共通スキルが既にあります: new-skill" });
    } finally {
      await conflictApp.close();
    }
  } finally {
    await bff.close();
  }
});

test("保存は relativePath / fileVersion / description / body だけを渡し、name の変更要求は受け付けない", async () => {
  const { client, calls } = skillClient();
  const bff = await makeApp(client);
  try {
    const response = await bff.app.request(
      "/api/skills/files",
      jsonInit("PATCH", {
        relativePath: DETAIL.relativePath,
        fileVersion: DETAIL.fileVersion,
        name: "renamed",
        description: "新しい説明",
        body: "\n新しい本文\n",
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { relativePath: DETAIL.relativePath, fileVersion: "c".repeat(64) });
    assert.deepEqual(calls, [
      {
        method: "saveSkillFile",
        input: {
          relativePath: DETAIL.relativePath,
          fileVersion: DETAIL.fileVersion,
          description: "新しい説明",
          body: "\n新しい本文\n",
        },
      },
    ]);

    // 版の不一致や編集できないファイルは 409 / 400 の文言をそのまま返す
    const stale = skillClient({
      saveSkillFile: async () => {
        throw new SandboxRequestError("スキルが他の変更と競合しました。再読み込みしてから保存してください", 409);
      },
    });
    const staleApp = await makeApp(stale.client);
    try {
      const response2 = await staleApp.app.request(
        "/api/skills/files",
        jsonInit("PATCH", {
          relativePath: DETAIL.relativePath,
          fileVersion: DETAIL.fileVersion,
          description: "d",
          body: "b",
        }),
      );
      assert.equal(response2.status, 409);
      assert.match(String(((await response2.json()) as { error: string }).error), /競合/);
    } finally {
      await staleApp.close();
    }
  } finally {
    await bff.close();
  }
});

test("削除確認と削除は query だけを使い、削除の body は読まない", async () => {
  const { client, calls } = skillClient();
  const bff = await makeApp(client);
  try {
    const preview = await bff.app.request(
      `/api/skills/files/delete-preview?relativePath=${encodeURIComponent(DETAIL.relativePath)}`,
    );
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()) as { treeVersion: string; files: string[] };
    assert.equal(previewBody.treeVersion, "d".repeat(64));
    assert.deepEqual(previewBody.files, ["SKILL.md", "refs/note.txt"]);

    const removed = await bff.app.request(
      `/api/skills/files?relativePath=${encodeURIComponent(DETAIL.relativePath)}&treeVersion=${previewBody.treeVersion}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relativePath: "ignored" }),
      },
    );
    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), "");
    assert.deepEqual(calls, [
      { method: "previewSkillDelete", input: DETAIL.relativePath },
      {
        method: "deleteSkillFolder",
        input: { relativePath: DETAIL.relativePath, treeVersion: previewBody.treeVersion },
      },
    ]);

    assert.equal((await bff.app.request("/api/skills/files/delete-preview")).status, 400);
    assert.equal((await bff.app.request("/api/skills/files", { method: "DELETE" })).status, 400);
  } finally {
    await bff.close();
  }
});

test("要求上限 (64 KiB) はサンドボックスへ渡す前に 413 で拒否し、本文を切り詰めない", async () => {
  const { client, calls } = skillClient();
  const bff = await makeApp(client);
  try {
    const response = await bff.app.request(
      "/api/skills/files",
      jsonInit("POST", { name: "big", description: "d", body: "x".repeat(70 * 1024) }),
    );
    assert.equal(response.status, 413);
    assert.equal(calls.length, 0);
    // 逆に上限内の大きめの本文は通す (保存できる / できないの境界を UI が説明できる)
    const allowed = await bff.app.request(
      "/api/skills/files",
      jsonInit("POST", { name: "ok", description: "d", body: "x".repeat(60 * 1024) }),
    );
    assert.equal(allowed.status, 201);
    assert.equal(calls.length, 1);
  } finally {
    await bff.close();
  }
});

test("未設定は 503、接続不能と不正応答は 502 にする", async () => {
  const unset = await makeApp(null);
  try {
    assert.equal((await unset.app.request("/api/skills/files/detail?relativePath=x")).status, 503);
    assert.equal(
      (await unset.app.request("/api/skills/files", jsonInit("POST", { name: "a", description: "d", body: "b" })))
        .status,
      503,
    );
    assert.equal((await unset.app.request("/api/skills/files", { method: "DELETE" })).status, 503);
  } finally {
    await unset.close();
  }

  const down = skillClient({
    getSkillFile: async () => {
      throw new SandboxRequestError("サンドボックスに接続できません", 502);
    },
  });
  const downApp = await makeApp(down.client);
  try {
    const response = await downApp.app.request("/api/skills/files/detail?relativePath=x");
    assert.equal(response.status, 502);
  } finally {
    await downApp.close();
  }

  const broken = skillClient({
    getSkillFile: async () => ({ name: "only-name" }) as unknown as typeof DETAIL,
  });
  const brokenApp = await makeApp(broken.client);
  try {
    const response = await brokenApp.app.request("/api/skills/files/detail?relativePath=x");
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "サンドボックスのスキル応答が不正です" });
  } finally {
    await brokenApp.close();
  }
});

test("新しい静的ルートは /api/skills/session を壊さず、旧カタログ CRUD は存在しない", async () => {
  const { client } = skillClient();
  const bff = await makeApp(client);
  try {
    // 旧 DB カタログの一覧は撤去済みで、新しい API へも転送しない (通常の未対応 API として 404)
    assert.equal((await bff.app.request("/api/skills")).status, 404);
    // 新ルートは :id に捕捉されない (detail が 200 を返す)
    assert.equal(
      (await bff.app.request(`/api/skills/files/detail?relativePath=${encodeURIComponent(DETAIL.relativePath)}`))
        .status,
      200,
    );
    // 旧 CRUD の動的ルートも無い
    assert.equal((await bff.app.request("/api/skills/missing", { method: "DELETE" })).status, 404);
    assert.equal((await bff.app.request("/api/skills/missing", { method: "PATCH" })).status, 404);
    // セッション未確定のスキル一覧のルートも残っている (未設定 / 未登録の状態は 4xx / 503 のまま。
    // どちらでも「ルートが無い」404 とは区別できる)
    const sessionSkills = await bff.app.request("/api/skills/session?projectId=&agentId=default");
    assert.notEqual(sessionSkills.status, 404);
  } finally {
    await bff.close();
  }
});
