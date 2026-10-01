// `pnpm dev` がプレビュー オリジンの待受とブラウザから見た値に同じ値を使うこと。ずれると iframe が繋がらない
// (値は server の resolver が唯一の決定点で、dev.mjs 側はそれを直書きしない)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const devScript = readFileSync(fileURLToPath(new URL("../../scripts/dev.mjs", import.meta.url)), "utf8");

test("dev は解決した 1 つの値を空き確認と BFF の両 env へ渡す", () => {
  assert.match(devScript, /const filePreviewPort = resolveDevFilePreviewPort\(process\.env\)/);
  assert.match(devScript, /assertPortFree\(filePreviewPort\)/);
  assert.match(devScript, /PI_FILE_PREVIEW_PORT:\s*String\(filePreviewPort\)/);
  assert.match(devScript, /PI_FILE_PREVIEW_LISTEN_PORT:\s*String\(filePreviewPort\)/);
});

test("dev は既定ポートを直書きしない (resolver が唯一の決定点)", () => {
  assert.ok(!devScript.includes("4318"), "dev.mjs に既定ポートの直書きが戻っている");
});
