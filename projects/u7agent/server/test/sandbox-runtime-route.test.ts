// サンドボックスの GET /v1/runtime/info (実行環境の診断) を app.request() で検証する。
// 認証必須・/healthz 不変・workspace 内の偽コマンドを実行しないことを固定する。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import type { SandboxRuntimeInfo } from "../src/sandbox/protocol";

const TOKEN = "runtime-route-token-0123456789abcdef";
const HAS_SH = existsSync("/bin/sh");

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

test("serves the runtime info only with a valid token and keeps /healthz public", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-runtime-"));
  const service = createSandboxService({
    token: TOKEN,
    rootCwd: root,
    probeRuntimeInfo: async (workspaceRoot): Promise<SandboxRuntimeInfo> => ({
      environment: { os: "Test OS 1.0", arch: "x86_64", user: "tester", isRoot: false, workspace: workspaceRoot },
      commands: [
        { name: "curl", version: "8.14.1" },
        { name: "node", version: null },
      ],
    }),
  });

  const unauthorized = await service.app.request("/v1/runtime/info");
  assert.equal(unauthorized.status, 401);
  const wrongToken = await service.app.request("/v1/runtime/info", {
    headers: { Authorization: "Bearer wrong-token-0123456789abcdef" },
  });
  assert.equal(wrongToken.status, 401);

  // /healthz は Compose healthcheck 用のまま (実行環境の情報を載せない)
  const healthz = await service.app.request("/healthz");
  assert.equal(healthz.status, 200);
  const healthzBody = (await healthz.json()) as Record<string, unknown>;
  assert.equal(healthzBody.ok, true);
  assert.equal("environment" in healthzBody, false);
  assert.equal("commands" in healthzBody, false);

  const response = await service.app.request("/v1/runtime/info", { headers: authHeaders() });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(TOKEN), false, "共有トークンを応答へ出さない");
  assert.deepEqual(JSON.parse(text), {
    environment: { os: "Test OS 1.0", arch: "x86_64", user: "tester", isRoot: false, workspace: root },
    commands: [
      { name: "curl", version: "8.14.1" },
      { name: "node", version: null },
    ],
  });
});

test("reports a fixed error when the probe itself fails", async () => {
  const service = createSandboxService({
    token: TOKEN,
    rootCwd: tmpdir(),
    probeRuntimeInfo: async () => {
      throw new Error(`internal failure at /secret/path token=${TOKEN}`);
    },
  });
  const response = await service.app.request("/v1/runtime/info", { headers: authHeaders() });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes("/secret/path"), false);
  assert.deepEqual(JSON.parse(text), { error: "実行環境の診断に失敗しました" });
});

test("detects the real workspace without running a fake command from the workspace", { skip: !HAS_SH }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-runtime-real-"));
  const marker = join(root, "fake-ran");
  // 実行環境の検出はワークスペースを PATH に含めないため、ここに置いた bash は実行されない
  writeFileSync(join(root, "bash"), `#!/bin/sh\ntouch '${marker}'\nprintf '9.9.9\\n'\n`, { mode: 0o755 });
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/runtime/info", { headers: authHeaders() });
  assert.equal(response.status, 200);
  const info = (await response.json()) as SandboxRuntimeInfo;
  assert.equal(info.environment.workspace, root);
  assert.equal(
    info.commands.some((command) => command.name === "bash" && command.version === "9.9.9"),
    false,
  );
  assert.equal(existsSync(marker), false);
});
