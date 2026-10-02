import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBffApp } from "../src/app";

test("ブラウザの別ポート・別ホスト・null Origin の書き込みは副作用の前に拒否する", async () => {
  let renamed = false;
  const bff = await createBffApp({
    pi: null,
    sessionStoreDir: null,
    workspace: {
      renameEntry: async () => {
        renamed = true;
        return { path: "renamed", name: "renamed" };
      },
    } as any,
  });
  try {
    const agentCount = bff.catalog.snapshot().agents.length;
    for (const origin of [
      "http://app.test:8016",
      "http://app.test:8017",
      "http://evil.test:8015",
      "null",
      "",
      "garbage",
    ]) {
      const response = await bff.app.request("http://app.test:8015/api/files/rename", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "text/plain" },
        body: JSON.stringify({ path: "original", name: "renamed" }),
      });
      assert.equal(response.status, 403, origin);
    }
    assert.equal(renamed, false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await bff.app.request("http://app.test:8015/api/agents", {
        method,
        headers: { Origin: "http://app.test:8016" },
      });
      assert.equal(response.status, 403, method);
    }
    const response = await bff.app.request("http://app.test:8015/api/agents", {
      method: "POST",
      headers: { Origin: "http://app.test:8016", "Content-Type": "text/plain" },
      body: JSON.stringify({ name: "untrusted" }),
    });
    assert.equal(response.status, 403);
    assert.equal(bff.catalog.snapshot().agents.length, agentCount);
  } finally {
    await bff.close();
  }
});

test("Origin がない別サイト・同じサイトの別オリジンも Fetch Metadata で拒否する", async () => {
  const bff = await createBffApp({ pi: null, sessionStoreDir: null });
  try {
    for (const site of ["cross-site", "same-site", "none"]) {
      const response = await bff.app.request("/api/agents", { method: "POST", headers: { "Sec-Fetch-Site": site } });
      assert.equal(response.status, 403);
    }
  } finally {
    await bff.close();
  }
});

test("同一オリジンと CLI を維持し、Vite proxy が保持する外部 Host でも書き込める", async () => {
  const vite = readFileSync(new URL("../../client/vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /changeOrigin:\s*false/);
  const bff = await createBffApp({ pi: null, sessionStoreDir: null });
  try {
    for (const [url, headers] of [
      ["http://app.test:8015/api/agents", { Origin: "http://app.test:8015", "Sec-Fetch-Site": "same-origin" }],
      ["http://localhost:3000/api/agents", { Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-origin" }],
      ["http://app.test:8015/api/agents", {}],
    ] as const) {
      const response = await bff.app.request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "trusted" }),
      });
      assert.equal(response.status, 201);
    }
    const response = await bff.app.request("/api/health", { headers: { Origin: "http://other.test" } });
    assert.equal(response.status, 200);
  } finally {
    await bff.close();
  }
});

test("アップロード・停止・圧縮も先に拒否し、転送ヘッダでは許可を増やさない", async () => {
  const bff = await createBffApp({ pi: null, sessionStoreDir: null });
  try {
    for (const path of ["/api/sessions/fake/files", "/api/sessions/fake/stop", "/api/sessions/fake/compact"]) {
      const response = await bff.app.request(`http://app.test:8015${path}`, {
        method: "POST",
        headers: {
          Origin: "http://app.test:8016",
          "X-Forwarded-Host": "app.test:8016",
          "X-Forwarded-Proto": "http",
        },
      });
      assert.equal(response.status, 403, path);
    }
  } finally {
    await bff.close();
  }
});
