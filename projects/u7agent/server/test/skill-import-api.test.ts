// スキルの持ち出し / 取り込み API (BFF)。偽のサンドボックスクライアントで、raw 中継 (bodyGuard を通らないこと)、
// content-length の事前 413、query の素通し、応答スキーマ検証、失敗の写像、503 だけを見る。
// パス・版・ZIP の検証はサンドボックス側の契約なのでここでは扱わない。

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SandboxRequestError, type SandboxSkillArchiveClient } from "../src/sandbox/client";
import {
  SANDBOX_MAX_UPLOAD_BYTES,
  type SandboxDownloadCheck,
  type SandboxSkillsImportApply,
  type SandboxSkillsImportPlan,
} from "../src/sandbox/protocol";

const PLAN: SandboxSkillsImportPlan = {
  skills: [
    { name: "fresh", status: "new" },
    { name: "broken", status: "invalid", reason: "スキルとして読み込めません" },
  ],
  entries: 3,
  bytes: 10,
};

const APPLY: SandboxSkillsImportApply = {
  applied: [
    { name: "fresh", relativePath: ".agents/skills/fresh/SKILL.md", fileVersion: "a".repeat(64), replaced: false },
  ],
  skipped: [{ name: "same", reason: "内容が同一" }],
  entries: 3,
  bytes: 10,
};

const CHECK: SandboxDownloadCheck = { kind: "archive", name: "skills.zip", bytes: 9, entries: 2, skipped: [".git"] };

interface Recorder {
  client: SandboxSkillArchiveClient;
  calls: { method: string; input: unknown }[];
  /** importSkills が受信した本文のバイト数 (raw 中継の確認) */
  sizes: number[];
}

/** 持ち出し / 取り込みが使う 3 つのメソッドだけを持つ偽クライアント (他の stub を広げない) */
function archiveClient(overrides: Partial<SandboxSkillArchiveClient> = {}): Recorder {
  const calls: { method: string; input: unknown }[] = [];
  const sizes: number[] = [];
  const client: SandboxSkillArchiveClient = {
    exportSkills: async () => {
      calls.push({ method: "exportSkills", input: undefined });
      return {
        contentType: "application/zip",
        contentDisposition: "attachment; filename*=UTF-8''skills.zip",
        body: new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]).stream(),
      };
    },
    checkSkillsExport: async () => {
      calls.push({ method: "checkSkillsExport", input: undefined });
      return CHECK;
    },
    importSkills: async (input) => {
      calls.push({ method: "importSkills", input: { dryRun: [...input.dryRun], replace: [...input.replace] } });
      const bytes = await new Response(input.body).arrayBuffer();
      sizes.push(bytes.byteLength);
      return input.dryRun.length > 0 ? PLAN : APPLY;
    },
    ...overrides,
  };
  return { client, calls, sizes };
}

async function makeApp(client: SandboxSkillArchiveClient | null) {
  return createBffApp({
    cwd: mkdtempSync(join(tmpdir(), "u7agent-skill-archive-api-")),
    sessionStoreDir: null,
    pi: null,
    workspace: null,
    skillArchiveSandbox: client,
  });
}

test("GET /api/skills/files/export は本文を中継し、保存名と no-store / nosniff を付ける", async () => {
  const { client } = archiveClient();
  const bff = await makeApp(client);
  try {
    const response = await bff.app.request("/api/skills/files/export");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/zip");
    assert.equal(response.headers.get("Content-Disposition"), "attachment; filename*=UTF-8''skills.zip");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    // zip は長さが確定しないため Content-Length を付けない
    assert.equal(response.headers.get("Content-Length"), null);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
  } finally {
    await bff.close();
  }
});

test("GET /api/skills/files/export/check は download と同じ形を検証して返す", async () => {
  const { client } = archiveClient();
  const bff = await makeApp(client);
  try {
    const response = await bff.app.request("/api/skills/files/export/check");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), CHECK);

    // 契約外の応答 (件数が負 / 除外名が文字列) は 502 に寄せる
    client.checkSkillsExport = async () => ({ ...CHECK, entries: -1 }) as never;
    assert.equal((await bff.app.request("/api/skills/files/export/check")).status, 502);
    client.checkSkillsExport = async () => ({ ...CHECK, skipped: ".git" }) as never;
    assert.equal((await bff.app.request("/api/skills/files/export/check")).status, 502);
  } finally {
    await bff.close();
  }
});

test("export / export-check はサンドボックス未設定で 503", async () => {
  const bff = await makeApp(null);
  try {
    for (const url of ["/api/skills/files/export", "/api/skills/files/export/check"]) {
      assert.equal((await bff.app.request(url)).status, 503, url);
    }
  } finally {
    await bff.close();
  }
});

test("export はサンドボックス失敗を写す (接続失敗は 502、404 は文言ごと透過)", async () => {
  for (const [expected, error] of [
    [404, new SandboxRequestError("Path not found: /workspace/.agents/skills", 404)],
    [413, new SandboxRequestError("Download has too many entries (max 10000)", 413)],
    [502, new SandboxRequestError("サンドボックス (http://sandbox) に接続できません", 502)],
  ] as const) {
    const { client } = archiveClient({
      exportSkills: async () => {
        throw error;
      },
    });
    const bff = await makeApp(client);
    try {
      const response = await bff.app.request("/api/skills/files/export");
      assert.equal(response.status, expected, error.message);
      assert.deepEqual(await response.json(), { error: error.message });
    } finally {
      await bff.close();
    }
  }

  const { client } = archiveClient({
    exportSkills: async () => ({ contentType: "application/zip", contentDisposition: "attachment", body: null }),
  });
  const bff = await makeApp(client);
  try {
    const response = await bff.app.request("/api/skills/files/export");
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "サンドボックスが本文を返しませんでした" });
  } finally {
    await bff.close();
  }
});

test("POST /api/skills/files/import は bodyGuard を通さず raw を中継し、plan / apply の形を検証する", async () => {
  const { client, calls, sizes } = archiveClient();
  const bff = await makeApp(client);
  try {
    // 70 KiB は bodyGuard (64 KiB / text 化) の上限を超える
    const body = new Uint8Array(70 * 1024).fill(7);
    const applied = await bff.app.request("/api/skills/files/import", { method: "POST", body });
    assert.equal(applied.status, 200, "bodyGuard (64 KiB / text 化) を通さない");
    assert.deepEqual(await applied.json(), APPLY);
    assert.deepEqual(sizes, [body.byteLength]);

    const plan = await bff.app.request("/api/skills/files/import?dryRun=true", { method: "POST", body });
    assert.equal(plan.status, 200);
    assert.deepEqual(await plan.json(), PLAN);
    assert.deepEqual(
      calls.map((call) => call.input),
      [
        { dryRun: [], replace: [] },
        { dryRun: ["true"], replace: [] },
      ],
    );

    // dryRun / replace は解釈せず、繰り返しを含めて query のまま渡す
    await bff.app.request("/api/skills/files/import?dryRun=1&replace=alpha&replace=alpha", {
      method: "POST",
      body,
    });
    assert.deepEqual(calls[2]?.input, { dryRun: ["1"], replace: ["alpha", "alpha"] });
  } finally {
    await bff.close();
  }
});

test("POST /api/skills/files/import は申告された content-length で本文を送らずに 413", async () => {
  const { client, calls } = archiveClient();
  const bff = await makeApp(client);
  try {
    const response = await bff.app.request("/api/skills/files/import", {
      method: "POST",
      headers: { "content-length": String(SANDBOX_MAX_UPLOAD_BYTES + 1) },
      body: "x",
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: `Import archive is too large (max ${SANDBOX_MAX_UPLOAD_BYTES} bytes)`,
    });
    assert.deepEqual(calls, [], "413 のときはサンドボックスへ送らない");
  } finally {
    await bff.close();
  }
});

test("POST /api/skills/files/import は応答の検証と失敗の写像 (400 / 413 / 502 / 503) を行う", async () => {
  // 契約外の応答は 502
  const invalid = archiveClient({ importSkills: async () => ({ skills: "nope" }) as never });
  const invalidApp = await makeApp(invalid.client);
  try {
    assert.equal((await invalidApp.app.request("/api/skills/files/import", { method: "POST", body: "x" })).status, 502);
  } finally {
    await invalidApp.close();
  }

  for (const [expected, error] of [
    [400, new SandboxRequestError("Invalid ZIP archive: the archive is truncated", 400)],
    [413, new SandboxRequestError("Import archive is too large (max 104857600 bytes)", 413)],
    [502, new SandboxRequestError("サンドボックス (http://sandbox) に接続できません", 502)],
  ] as const) {
    const { client } = archiveClient({
      importSkills: async () => {
        throw error;
      },
    });
    const bff = await makeApp(client);
    try {
      const response = await bff.app.request("/api/skills/files/import", { method: "POST", body: "x" });
      assert.equal(response.status, expected, error.message);
      assert.deepEqual(await response.json(), { error: error.message });
    } finally {
      await bff.close();
    }
  }

  const unconfigured = await makeApp(null);
  try {
    assert.equal(
      (await unconfigured.app.request("/api/skills/files/import", { method: "POST", body: "x" })).status,
      503,
    );
  } finally {
    await unconfigured.close();
  }
});
