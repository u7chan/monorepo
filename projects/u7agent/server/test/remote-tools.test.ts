// createRemoteToolDefinitions がセッションの cwd をサンドボックスの実行要求へ載せることの検証 (実サンドボックス・実 LLM なし)。

import assert from "node:assert/strict";
import test from "node:test";
import { createSecretMasker } from "../src/redact";
import type { SandboxToolClient } from "../src/sandbox/client";
import { createRemoteToolDefinitions, UnknownRemoteToolError } from "../src/sandbox/remote-tools";

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

async function executeLs(sandboxCwd: string, calls: StubCall[], client: SandboxToolClient): Promise<void> {
  const definitions = createRemoteToolDefinitions({
    cwd: sandboxCwd ? `/workspace/${sandboxCwd}` : "/workspace",
    sandboxCwd,
    client,
    masker: createSecretMasker([]),
    tools: ["ls"],
  });
  const ls = definitions.find((definition) => definition.name === "ls");
  assert.ok(ls, "ls のリモート定義が作られる");
  await ls.execute("call-1", { path: "." }, undefined, undefined, { cwd: "/workspace" } as never);
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
        cwd: "/workspace",
        sandboxCwd: "",
        client,
        masker: createSecretMasker([]),
        tools: ["powershell"],
      }),
    UnknownRemoteToolError,
  );
});
