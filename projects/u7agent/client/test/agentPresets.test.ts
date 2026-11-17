import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_PRESETS, agentPresetOf, agentPresetValue } from "../src/lib/agentPresets";

/** client/ 直下。assets の実在は public/ からの相対で見る */
const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** server/src/agents.ts の ICON_MAX_BYTES と同じ上限。超えた画像は保存できない */
const ICON_MAX_BYTES = 16 * 1024;

test("preset ids are unique and the stored value round-trips", () => {
  assert.equal(new Set(AGENT_PRESETS.map((preset) => preset.id)).size, AGENT_PRESETS.length);
  for (const preset of AGENT_PRESETS) {
    assert.match(preset.id, /^[a-z0-9-]{1,32}$/);
    assert.ok(preset.label.length > 0);
    assert.ok(preset.src.startsWith("/agent-icons/"));
    assert.equal(agentPresetOf(agentPresetValue(preset))?.id, preset.id);
  }
});

test("agentPresetOf resolves only bundled preset ids", () => {
  assert.equal(agentPresetOf("preset:bot-mint")?.src, "/agent-icons/bot-mint.webp");
  assert.equal(agentPresetOf("preset:unknown"), undefined);
  assert.equal(agentPresetOf("data:image/webp;base64,AAAA"), undefined);
  assert.equal(agentPresetOf(undefined), undefined);
});

test("bundled preset images are webp files within the server limit", () => {
  for (const preset of AGENT_PRESETS) {
    const file = join(CLIENT_ROOT, "public", preset.src.replace(/^\//, ""));
    const bytes = readFileSync(file);
    assert.ok(bytes.length > 0, `${preset.src} is empty`);
    assert.ok(bytes.length <= ICON_MAX_BYTES, `${preset.src} is ${bytes.length} bytes`);
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF", `${preset.src} is not a RIFF file`);
    assert.equal(bytes.subarray(8, 12).toString("latin1"), "WEBP", `${preset.src} is not a webp file`);
  }
});
