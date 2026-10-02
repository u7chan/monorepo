import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_PREVIEW_PORT, resolvePreviewPort } from "../src/preview-port";
import { SANDBOX_DEFAULT_PORT } from "../src/sandbox/protocol";
import { appendSystemPrompt } from "../src/agent";
import { createBffApp } from "../src/app";
import { HealthSchema } from "../src/schema";

test("serve の公開ポートは未設定なら 8080、不正値では起動を拒否する", () => {
  assert.equal(DEFAULT_PREVIEW_PORT, 8080);
  for (const value of [undefined, "", " "]) assert.equal(resolvePreviewPort(value), 8080);
  for (const value of ["1", "8016", "65535", " 8080 "]) assert.equal(resolvePreviewPort(value), Number(value));
  for (const value of ["0", "-1", "65536", "1.5", "NaN", "abc", "1e3", "0x10", "+80"]) {
    assert.throws(() => resolvePreviewPort(value), /PI_PREVIEW_PORT/);
  }
});

test("health は serve と HTML プレビューの公開ポートを別々に返す", async () => {
  for (const previewPort of [undefined, 8016]) {
    const bff = await createBffApp({ pi: null, sessionStoreDir: null, previewPort, filePreviewPort: 8017 });
    try {
      const health = HealthSchema.parse(await (await bff.app.request("/api/health")).json());
      assert.equal(health.previewPort, previewPort ?? 8080);
      assert.equal(health.filePreviewPort, 8017);
    } finally {
      await bff.close();
    }
  }
});

test("ツール API の既定を移設し、serve の運用はプロンプトへ誘導する", () => {
  assert.equal(SANDBOX_DEFAULT_PORT, 9418);
  const dev = readFileSync(new URL("../../scripts/dev.mjs", import.meta.url), "utf8");
  assert.match(dev, /const SANDBOX_PORT = Number\(process\.env\.SANDBOX_PORT\) \|\| 9418/);
  const prompt = appendSystemPrompt("/workspace");
  for (const text of [
    "0.0.0.0:8080",
    "nohup",
    "--strictPort",
    "curl -fsS http://127.0.0.1:8080/",
    "across all conversations",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
});
