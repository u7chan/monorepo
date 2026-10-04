import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_PREVIEW_PORT,
  DEFAULT_SERVICE_LISTEN_PORT,
  resolvePreviewPort,
  resolveServiceListenPort,
  SERVE_LISTEN_PORT,
} from "../src/preview-port";
import { SANDBOX_DEFAULT_PORT } from "../src/sandbox/protocol";
import { appendSystemPrompt } from "../src/agent";
import { createBffApp } from "../src/app";
import { HealthSchema } from "../src/schema";

test("サービス オリジンの待受ポートは未設定なら 4319、不正値では起動を拒否する", () => {
  assert.equal(DEFAULT_SERVICE_LISTEN_PORT, 4319);
  // dev ではアプリ自身が 8080 で待つため、サービス リスナーの既定にしない (転送先は 8080 固定)
  assert.notEqual(DEFAULT_SERVICE_LISTEN_PORT, SERVE_LISTEN_PORT);
  for (const value of [undefined, "", " "]) assert.equal(resolveServiceListenPort(value), 4319);
  for (const value of ["1", "8016", "65535", " 4319 "]) assert.equal(resolveServiceListenPort(value), Number(value));
  for (const value of ["0", "-1", "65536", "1.5", "NaN", "abc", "1e3", "0x10", "+80"]) {
    assert.throws(() => resolveServiceListenPort(value), /PI_SERVICE_LISTEN_PORT/);
  }
});

test("serve の公開ポートは未設定なら待受へ寄せ、不正値では起動を拒否する", () => {
  assert.equal(DEFAULT_PREVIEW_PORT, DEFAULT_SERVICE_LISTEN_PORT);
  for (const value of [undefined, "", " "]) assert.equal(resolvePreviewPort(value), 4319);
  // 待受を変えたのにブラウザから見た値が未設定なら、待受の値へ寄せる (prod は publish したポートを明示する)
  for (const value of [undefined, "", " "]) assert.equal(resolvePreviewPort(value, 5000), 5000);
  for (const value of ["1", "8016", "65535", " 8080 "]) assert.equal(resolvePreviewPort(value), Number(value));
  assert.equal(resolvePreviewPort("8016", 5000), 8016);
  for (const value of ["0", "-1", "65536", "1.5", "NaN", "abc", "1e3", "0x10", "+80"]) {
    assert.throws(() => resolvePreviewPort(value), /PI_PREVIEW_PORT/);
  }
});

test("health は serve と HTML プレビューの公開ポートを別々に返す", async () => {
  for (const previewPort of [undefined, 8016]) {
    const bff = await createBffApp({ pi: null, sessionStoreDir: null, previewPort, filePreviewPort: 8017 });
    try {
      const health = HealthSchema.parse(await (await bff.app.request("/api/health")).json());
      assert.equal(health.previewPort, previewPort ?? DEFAULT_PREVIEW_PORT);
      assert.equal(health.filePreviewPort, 8017);
    } finally {
      await bff.close();
    }
  }
});

test("dev はサービス オリジンの待受とブラウザから見た値を env から解決して渡す", () => {
  const dev = readFileSync(new URL("../../scripts/dev.mjs", import.meta.url), "utf8");
  assert.match(dev, /const serviceListenPort = resolveServiceListenPort\(process\.env\.PI_SERVICE_LISTEN_PORT\)/);
  assert.match(dev, /const previewPort = resolvePreviewPort\(process\.env\.PI_PREVIEW_PORT, serviceListenPort\)/);
  // 空き確認に加えて、Vite とアプリの 8080 を含む他の待受との重複も起動前に止める
  assert.match(dev, /assertPortFree\(serviceListenPort\)/);
  assert.match(dev, /assertServicePortDistinct\(serviceListenPort, filePreviewPort\)/);
  assert.match(dev, /PI_SERVICE_LISTEN_PORT:\s*String\(serviceListenPort\)/);
  assert.match(dev, /PI_PREVIEW_PORT:\s*String\(previewPort\)/);
});

test("ツール API の既定を移設し、serve の運用は組み込みスキルへ移す", () => {
  assert.equal(SANDBOX_DEFAULT_PORT, 9418);
  const dev = readFileSync(new URL("../../scripts/dev.mjs", import.meta.url), "utf8");
  assert.match(dev, /const SANDBOX_PORT = Number\(process\.env\.SANDBOX_PORT\) \|\| 9418/);
  // serve の作法 (nohup / --strictPort / curl 検証) は同梱の serve スキルが正で、
  // system prompt はツールとスキルへ 1 行で誘導するだけにする
  const prompt = appendSystemPrompt("/workspace");
  assert.ok(prompt.includes("`serve` tool"), prompt);
  assert.ok(prompt.includes("`serve` skill"), prompt);
  assert.ok(!prompt.includes("nohup"), "起動の作法はスキル側に置く");
});
