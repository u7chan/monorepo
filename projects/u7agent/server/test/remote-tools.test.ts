// createRemoteToolDefinitions がセッションの cwd をサンドボックスの実行要求へ載せることと、
// 組み込みスキルの仮想パスを read だけ BFF 側で返すことの検証 (実サンドボックス・実 LLM なし)。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { builtinSkillByName, builtinSkillPath } from "../src/builtin-skills";
import { createSecretMasker } from "../src/redact";
import type { SandboxToolClient } from "../src/sandbox/client";
import { createRemoteToolDefinitions, UnknownRemoteToolError } from "../src/sandbox/remote-tools";

const ROOT = "/workspace";

interface StubCall {
  tool: string;
  params: unknown;
  cwd?: string;
}

function stubClient(): { calls: StubCall[]; client: SandboxToolClient } {
  const calls: StubCall[] = [];
  const client = {
    execute: async (tool: string, input: { params: unknown; cwd?: string }) => {
      calls.push({ tool, params: input.params, cwd: input.cwd });
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as SandboxToolClient;
  return { calls, client };
}

function readDefinition(client: SandboxToolClient, cwd: string) {
  const definitions = createRemoteToolDefinitions({
    cwd,
    rootCwd: ROOT,
    sandboxCwd: "",
    client,
    masker: createSecretMasker([]),
    tools: ["read"],
  });
  const read = definitions.find((definition) => definition.name === "read");
  assert.ok(read, "read のリモート定義が作られる");
  return read;
}

async function executeLs(sandboxCwd: string, calls: StubCall[], client: SandboxToolClient): Promise<void> {
  const definitions = createRemoteToolDefinitions({
    cwd: sandboxCwd ? `${ROOT}/${sandboxCwd}` : ROOT,
    rootCwd: ROOT,
    sandboxCwd,
    client,
    masker: createSecretMasker([]),
    tools: ["ls"],
  });
  const ls = definitions.find((definition) => definition.name === "ls");
  assert.ok(ls, "ls のリモート定義が作られる");
  await ls.execute("call-1", { path: "." }, undefined, undefined, { cwd: ROOT } as never);
  assert.equal(calls.length, 1);
}

test("forwards the session cwd to the sandbox request", async () => {
  const { calls, client } = stubClient();
  await executeLs("nested/proj", calls, client);
  assert.deepEqual(calls[0], { tool: "ls", params: { path: "." }, cwd: "nested/proj" });
});

test("omits the cwd for an unassigned session (root)", async () => {
  const { calls, client } = stubClient();
  await executeLs("", calls, client);
  assert.equal(calls[0].cwd, undefined, "root は相対指定を省略し、サンドボックス側の既定に任せる");
});

test("rejects a tool the sandbox does not provide", () => {
  const { client } = stubClient();
  assert.throws(
    () =>
      createRemoteToolDefinitions({
        cwd: ROOT,
        rootCwd: ROOT,
        sandboxCwd: "",
        client,
        masker: createSecretMasker([]),
        tools: ["powershell"],
      }),
    UnknownRemoteToolError,
  );
});

test("read は組み込みスキルの仮想パスをバンドルから返し、サンドボックスへ送らない", async () => {
  const { calls, client } = stubClient();
  const read = readDefinition(client, join(ROOT, "proj"));
  const body = builtinSkillByName("skill-creator")?.body ?? "";

  const result = (await read.execute(
    "call-1",
    { path: builtinSkillPath(ROOT, "skill-creator") },
    undefined,
    undefined,
    { cwd: join(ROOT, "proj") } as never,
  )) as { content: Array<{ type: string; text?: string }> };

  assert.equal(result.content[0]?.text, body);
  assert.equal(calls.length, 0, "仮想パスはサンドボックスへ送らない");
});

test("read は root 相対と cwd 相対の仮想パスも解決する", async () => {
  const body = builtinSkillByName("skill-creator")?.body ?? "";
  for (const requested of [
    ".u7agent/builtin-skills/skill-creator/SKILL.md",
    "./.u7agent/builtin-skills/skill-creator/SKILL.md",
    "../.u7agent/builtin-skills/skill-creator/SKILL.md",
  ]) {
    const { calls, client } = stubClient();
    const read = readDefinition(client, join(ROOT, "proj"));
    const result = (await read.execute("call-1", { path: requested }, undefined, undefined, {} as never)) as {
      content: Array<{ text?: string }>;
    };
    assert.equal(result.content[0]?.text, body, requested);
    assert.equal(calls.length, 0, requested);
  }
});

test("read は仮想パスでも offset / limit を守る", async () => {
  const { client } = stubClient();
  const read = readDefinition(client, ROOT);
  const body = builtinSkillByName("skill-creator")?.body ?? "";
  const lines = body.split("\n");

  const result = (await read.execute(
    "call-1",
    { path: builtinSkillPath(ROOT, "skill-creator"), offset: 2, limit: 2 },
    undefined,
    undefined,
    {} as never,
  )) as { content: Array<{ text?: string }> };
  assert.equal(
    result.content[0]?.text,
    `${lines.slice(1, 3).join("\n")}\n\n[${lines.length - 3} more lines in file. Use offset=4 to continue.]`,
  );
});

test("write / edit のリモート定義は BFF へ書かず、cwd 付きでサンドボックスへ渡す", async () => {
  const bffCwd = mkdtempSync(join(tmpdir(), "pi-remote-tools-"));
  const { calls, client } = stubClient();
  const definitions = createRemoteToolDefinitions({
    cwd: bffCwd,
    rootCwd: ROOT,
    sandboxCwd: "proj",
    client,
    masker: createSecretMasker([]),
    tools: ["write", "edit"],
  });
  const write = definitions.find((definition) => definition.name === "write");
  const edit = definitions.find((definition) => definition.name === "edit");
  assert.ok(write && edit);

  await write.execute("call-1", { path: "cafe.html", content: "x" }, undefined, undefined, { cwd: bffCwd } as never);
  await edit.execute("call-2", { path: "cafe.html", edits: [{ oldText: "x", newText: "y" }] }, undefined, undefined, {
    cwd: bffCwd,
  } as never);

  assert.deepEqual(calls, [
    { tool: "write", params: { path: "cafe.html", content: "x" }, cwd: "proj" },
    { tool: "edit", params: { path: "cafe.html", edits: [{ oldText: "x", newText: "y" }] }, cwd: "proj" },
  ]);
  // パスの判定はサンドボックスが権威で、BFF はファイルシステムに触らない
  assert.equal(existsSync(join(bffCwd, "cafe.html")), false);
});

test("read は仮想パスでない要求をサンドボックスへ委譲する", async () => {
  const { calls, client } = stubClient();
  const read = readDefinition(client, join(ROOT, "proj"));

  // 既知の dir でも SKILL.md 以外、未知の名前、root の外は横取りしない
  for (const requested of [
    ".u7agent/builtin-skills/skill-creator/scripts/run.sh",
    ".u7agent/builtin-skills/unknown/SKILL.md",
    ".agents/skills/skill-creator/SKILL.md",
    "/other/.u7agent/builtin-skills/skill-creator/SKILL.md",
  ]) {
    calls.length = 0;
    const result = (await read.execute("call-1", { path: requested }, undefined, undefined, {} as never)) as {
      content: Array<{ text?: string }>;
    };
    assert.equal(result.content[0]?.text, "ok", requested);
    assert.equal(calls.length, 1, requested);
  }
});
