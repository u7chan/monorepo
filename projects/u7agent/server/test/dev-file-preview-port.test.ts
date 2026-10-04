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

// 文字列一致の検査だけでは、import 元の取り違え (存在しない名前を import) を検出できない。
// Node は起動時に SyntaxError で落ちるので、dev.mjs の port resolver の import を実モジュールと照合する。
test("dev.mjs が import する名前は対象モジュールが export している", async () => {
  const modules = new Map<string, object>([
    ["../server/src/preview-port.ts", await import("../src/preview-port")],
    ["../server/src/file-preview-port.ts", await import("../src/file-preview-port")],
  ]);
  let checked = 0;
  for (const match of devScript.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    const target = modules.get(match[2]);
    if (!target) continue;
    checked += 1;
    for (const name of match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)) {
      assert.ok(name in target, `${match[2]} は ${name} を export していない`);
    }
  }
  assert.ok(checked > 0, "dev.mjs の port resolver の import を検査できていない");
});
