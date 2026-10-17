// サンドボックスクライアントとサンドボックス service を直接つなぎ、スキルの持ち出し / 取り込みの
// URL・query・raw body の中継・応答の解釈・エラー写像を検証する (実 HTTP は使わない)。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Hono } from "hono";
import { createBffApp } from "../src/app";
import { createSandboxToolClient, SandboxRequestError } from "../src/sandbox/client";
import { createSandboxService } from "../src/sandbox/service";
import { buildZip, skillEntries } from "./zip-fixtures";

const TOKEN = "client-integration-token-0123456789";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-sbx-skill-archive-client-${prefix}-`));
}

function skillText(name: string, body = "本文\n"): string {
  return `---\nname: ${name}\ndescription: "説明"\n---\n${body}`;
}

/** service の app へ直結する fetch。URL のパスと query だけを渡す (baseUrl の組み立てを検証する) */
function bridgedFetch(app: Hono): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    return app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

test("client は持ち出しの本文・見積り・取り込みを service と通す", async () => {
  const root = makeRoot("roundtrip");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const client = createSandboxToolClient({
    baseUrl: "http://sandbox.test:9418/",
    token: TOKEN,
    fetchImpl: bridgedFetch(service.app),
  });
  try {
    await mkdir(join(root, ".agents/skills/alpha/refs"), { recursive: true });
    await writeFile(join(root, ".agents/skills/alpha/SKILL.md"), skillText("alpha"), "utf8");
    await writeFile(join(root, ".agents/skills/alpha/refs/note.txt"), "note\n", "utf8");

    const exported = await client.exportSkills();
    assert.equal(exported.contentType, "application/zip");
    assert.equal(exported.contentDisposition, "attachment; filename*=UTF-8''skills.zip");
    assert.equal(exported.contentLength, undefined, "zip に Content-Length を付けている");
    const zip = Buffer.from(await new Response(exported.body).arrayBuffer());

    const skillBytes = Buffer.byteLength(skillText("alpha"));
    const checked = await client.checkSkillsExport();
    assert.deepEqual(checked, {
      kind: "archive",
      name: "skills.zip",
      bytes: skillBytes + 5,
      entries: 4,
      skipped: [],
    });

    // plan: raw body をそのまま送り、応答は plan の形 (同じツリーなので identical)
    const planned = await client.importSkills({ body: new Blob([zip]).stream(), dryRun: ["true"], replace: [] });
    assert.deepEqual(planned, {
      skills: [{ name: "alpha", status: "identical" }],
      entries: 4,
      bytes: skillBytes + 5,
    });

    // 同名で内容が違う bundle は conflict。replace の名前は繰り返しの query として送り、apply でフォルダごと置換する
    const nextSkill = skillText("alpha", "新しい本文\n");
    const changed = buildZip([...skillEntries("alpha", { "SKILL.md": nextSkill, "refs/note.txt": "changed\n" })]);
    const applied = await client.importSkills({
      body: new Blob([changed]).stream(),
      dryRun: [],
      replace: ["alpha", "alpha"],
    });
    assert.deepEqual(applied, {
      applied: [
        {
          name: "alpha",
          relativePath: ".agents/skills/alpha/SKILL.md",
          fileVersion: createHash("sha256").update(nextSkill).digest("hex"),
          replaced: true,
        },
      ],
      skipped: [],
      entries: 3,
      bytes: Buffer.byteLength(nextSkill) + 8,
    });
    assert.equal(await readFile(join(root, ".agents/skills/alpha/SKILL.md"), "utf8"), nextSkill);
    assert.equal(await readFile(join(root, ".agents/skills/alpha/refs/note.txt"), "utf8"), "changed\n");
  } finally {
    service.close();
  }
});

test("client は持ち出し / 取り込みのサンドボックス失敗を写す", async () => {
  const root = makeRoot("errors");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const client = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: bridgedFetch(service.app),
  });
  try {
    // `.agents/skills` が無い環境では 404 (文言はサンドボックスのまま)
    await assert.rejects(client.exportSkills(), (error: unknown) => {
      assert.ok(error instanceof SandboxRequestError);
      assert.equal(error.status, 404);
      return true;
    });
    await assert.rejects(client.checkSkillsExport(), (error: unknown) => {
      assert.ok(error instanceof SandboxRequestError);
      assert.equal(error.status, 404);
      return true;
    });

    // dryRun / replace の解釈はサンドボックスが行い、400 は文言ごと透過する
    const zip = buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") }));
    await assert.rejects(
      client.importSkills({ body: new Blob([zip]).stream(), dryRun: ["1"], replace: [] }),
      (error: unknown) => {
        assert.ok(error instanceof SandboxRequestError);
        assert.equal(error.status, 400);
        assert.match(error.message, /dryRun/);
        return true;
      },
    );
    await assert.rejects(
      client.importSkills({ body: new Blob(["not a zip"]).stream(), dryRun: [], replace: [] }),
      (error: unknown) => {
        assert.ok(error instanceof SandboxRequestError);
        assert.equal(error.status, 400);
        assert.match(error.message, /Invalid ZIP archive/);
        return true;
      },
    );
  } finally {
    service.close();
  }
});

test("取り込んだスキルは BFF の一覧に現れ、export の見積りに載る", async () => {
  const root = makeRoot("bff-list");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const client = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: bridgedFetch(service.app),
  });
  const bff = await createBffApp({
    cwd: root,
    sessionStoreDir: null,
    pi: null,
    workspace: client,
    skillArchiveSandbox: client,
  });
  try {
    const zip = buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha"), "refs/note.txt": "note\n" }));
    const imported = await bff.app.request("/api/skills/files/import", { method: "POST", body: zip });
    assert.equal(imported.status, 200);

    const list = await bff.app.request("/api/skills/files");
    assert.equal(list.status, 200);
    const body = (await list.json()) as { skills: { name: string; scope: string; relativePath: string }[] };
    assert.deepEqual(
      body.skills.filter((skill) => skill.scope === "user").map((skill) => [skill.name, skill.relativePath]),
      [["alpha", ".agents/skills/alpha/SKILL.md"]],
    );

    const checked = await bff.app.request("/api/skills/files/export/check");
    assert.equal(checked.status, 200);
    assert.deepEqual(await checked.json(), {
      kind: "archive",
      name: "skills.zip",
      bytes: Buffer.byteLength(skillText("alpha")) + 5,
      entries: 4,
      skipped: [],
    });
  } finally {
    await bff.close();
    service.close();
  }
});
