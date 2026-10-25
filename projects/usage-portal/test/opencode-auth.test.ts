// OpenCode Go の API キーを CREDENTIAL_DIR に 0600 で保存し、壊れたファイルを未登録として扱うことを固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAuth, OPENCODE_KEY_FILE } from "../src/server/opencode/auth";

const dirs: string[] = [];
const NOW = 1_800_000_000_000;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-opencode-auth-"));

  dirs.push(dir);

  return dir;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createOpenCodeAuth", () => {
  test("保存したキーと保存時刻を返し、ディレクトリ 0700・ファイル 0600 にする", () => {
    let clock = NOW;
    const credentialDir = join(tempDir(), "credentials");
    const auth = createOpenCodeAuth({ credentialDir, now: () => clock });

    expect(auth.state()).toEqual({ configured: false, savedAt: null });

    auth.save("sk-sentinel-key");

    expect(auth.state()).toEqual({ configured: true, savedAt: NOW });
    expect(auth.apiKey()).toBe("sk-sentinel-key");
    expect(mode(credentialDir)).toBe(0o700);
    expect(mode(join(credentialDir, OPENCODE_KEY_FILE))).toBe(0o600);

    clock = NOW + 60_000;
    auth.save("sk-replaced-key");

    expect(auth.state()).toEqual({ configured: true, savedAt: NOW + 60_000 });
    expect(auth.apiKey()).toBe("sk-replaced-key");
    expect(existsSync(join(credentialDir, `${OPENCODE_KEY_FILE}.tmp`))).toBe(false);
  });

  test("解除すると未登録に戻り、ファイルを残さない", () => {
    const credentialDir = join(tempDir(), "credentials");
    const auth = createOpenCodeAuth({ credentialDir, now: () => NOW });

    auth.save("sk-sentinel-key");
    auth.clear();

    expect(auth.state()).toEqual({ configured: false, savedAt: null });
    expect(auth.apiKey()).toBeNull();
    expect(existsSync(join(credentialDir, OPENCODE_KEY_FILE))).toBe(false);

    // 二度目の解除も失敗しない。
    auth.clear();
    expect(auth.state().configured).toBe(false);
  });

  test("壊れた JSON・未知の version・空のキーは未登録として扱う", () => {
    const credentialDir = join(tempDir(), "credentials");
    const path = join(credentialDir, OPENCODE_KEY_FILE);

    mkdirSync(credentialDir, { recursive: true, mode: 0o700 });

    const auth = createOpenCodeAuth({ credentialDir, now: () => NOW });

    for (const content of [
      "not json",
      JSON.stringify({ version: 99, apiKey: "sk-key", savedAt: NOW }),
      JSON.stringify({ version: 1, apiKey: "", savedAt: NOW }),
      JSON.stringify({ version: 1, apiKey: "sk-key", savedAt: "now" }),
      JSON.stringify({ version: 1, apiKey: "sk-key" }),
    ]) {
      writeFileSync(path, content, { mode: 0o600 });

      expect(auth.state()).toEqual({ configured: false, savedAt: null });
      expect(auth.apiKey()).toBeNull();
    }
  });

  test("保存したファイルにキー以外の値を増やさない", () => {
    const credentialDir = join(tempDir(), "credentials");
    const auth = createOpenCodeAuth({ credentialDir, now: () => NOW });

    auth.save("sk-sentinel-key");

    expect(JSON.parse(readFileSync(join(credentialDir, OPENCODE_KEY_FILE), "utf8"))).toEqual({
      version: 1,
      apiKey: "sk-sentinel-key",
      savedAt: NOW,
    });
  });
});
