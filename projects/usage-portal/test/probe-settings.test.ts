// DATA_DIR/settings.json の読み書き（未設定・破損・atomic write・0600）を固定する。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProbeSettings, PROBE_SETTINGS_FILE } from "../src/server/probe/settings";

const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-probe-settings-"));

  dirs.push(dir);

  return dir;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function cleanup(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("createProbeSettings", () => {
  test("ファイルが無ければ未設定として読み、警告も出さない", () => {
    const logged: string[] = [];
    const settings = createProbeSettings({ dataDir: tempDataDir(), log: (message) => logged.push(message) });

    expect(settings.read()).toEqual({ codex: null });
    expect(logged).toEqual([]);

    cleanup();
  });

  test("書き込みは { probe: { codex } } の形で 0600、ディレクトリは 0700、一時ファイルは残さない", () => {
    const dataDir = join(tempDataDir(), "data");
    const settings = createProbeSettings({ dataDir, log: () => {} });

    settings.writeCodex({ model: "model-a", thinking: "low" });

    const path = join(dataDir, PROBE_SETTINGS_FILE);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ probe: { codex: { model: "model-a", thinking: "low" } } });
    expect(mode(path)).toBe(0o600);
    expect(mode(dataDir)).toBe(0o700);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(settings.read()).toEqual({ codex: { model: "model-a", thinking: "low" } });

    settings.writeCodex(null);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ probe: { codex: null } });
    expect(settings.read()).toEqual({ codex: null });

    cleanup();
  });

  test("壊れた JSON・知らない形は未設定として扱い、警告は 1 回だけ出す", () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, PROBE_SETTINGS_FILE);
    const logged: string[] = [];
    const settings = createProbeSettings({ dataDir, log: (message) => logged.push(message) });

    writeFileSync(path, "{ not json");

    expect(settings.read()).toEqual({ codex: null });
    expect(settings.read()).toEqual({ codex: null });
    expect(logged).toHaveLength(1);

    for (const body of ['{"probe":{}}', '{"probe":null}', '{"probe":{"codex":{"model":1}}}', "[]", "null"]) {
      writeFileSync(path, body);
      expect(settings.read()).toEqual({ codex: null });
    }

    cleanup();
  });

  test("片方だけ入った設定は未設定として扱う", () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, PROBE_SETTINGS_FILE);

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, '{"probe":{"codex":{"model":"model-a"}}}');

    expect(createProbeSettings({ dataDir, log: () => {} }).read()).toEqual({ codex: null });

    cleanup();
  });
});
