// Codex の資格情報の置き場（権限・device id・未接続時の分類）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAuth, prepareCredentialDir } from "../src/server/codex/auth";
import { createDeviceIdStore } from "../src/server/codex/device-id";

const dirs: string[] = [];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-credentials-"));

  dirs.push(dir);

  return dir;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function writeCredential(credentialDir: string, credential: Record<string, unknown>): void {
  writeFileSync(join(credentialDir, "auth.json"), JSON.stringify({ "openai-codex": credential }), { mode: 0o600 });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("prepareCredentialDir", () => {
  test("ディレクトリを 0700 で作り、既存の auth.json / device-id を 0600 に揃える", () => {
    const credentialDir = join(tempDir(), "credentials");

    prepareCredentialDir(credentialDir);

    expect(mode(credentialDir)).toBe(0o700);

    writeFileSync(join(credentialDir, "auth.json"), "{}", { mode: 0o644 });
    writeFileSync(join(credentialDir, "device-id"), "x", { mode: 0o644 });

    prepareCredentialDir(credentialDir);

    expect(mode(join(credentialDir, "auth.json"))).toBe(0o600);
    expect(mode(join(credentialDir, "device-id"))).toBe(0o600);
  });
});

describe("createDeviceIdStore", () => {
  test("UUID を 0600 で保存し、作り直しても同じ値を返す", () => {
    const credentialDir = tempDir();
    const path = join(credentialDir, "device-id");
    const first = createDeviceIdStore(path).getOrCreate();

    expect(first).toMatch(UUID_PATTERN);
    expect(mode(path)).toBe(0o600);
    expect(createDeviceIdStore(path).getOrCreate()).toBe(first);
  });

  test("壊れた値を UUID で作り直す", () => {
    const credentialDir = tempDir();
    const path = join(credentialDir, "device-id");
    const logs: string[] = [];

    writeFileSync(path, "not-a-uuid");

    const value = createDeviceIdStore(path, (message) => logs.push(message)).getOrCreate();

    expect(value).toMatch(UUID_PATTERN);
    expect(readFileSync(path, "utf8").trim()).toBe(value);
    expect(logs).toEqual(["device id file is invalid; a new id is generated"]);
  });

  test("書けない場所でもこのプロセスでは同じ値を返し続ける", () => {
    const parent = tempDir();
    const logs: string[] = [];
    const store = createDeviceIdStore(join(parent, "missing", "device-id"), (message) => logs.push(message));
    // 親ディレクトリを作れないようにして書き込みを失敗させる。
    mkdirSync(join(parent, "missing"));
    rmSync(join(parent, "missing"), { recursive: true, force: true });

    const value = store.getOrCreate();

    expect(value).toMatch(UUID_PATTERN);
    expect(store.getOrCreate()).toBe(value);
    expect(logs).toEqual([]);
  });
});

describe("createCodexAuth", () => {
  test("資格情報が無ければ signedIn=false、credential は not_connected", async () => {
    const credentialDir = tempDir();

    prepareCredentialDir(credentialDir);

    const auth = createCodexAuth({ credentialDir });

    expect(auth.signedIn()).toBe(false);

    await expect(auth.credential()).rejects.toMatchObject({
      code: "not_connected",
      message: "Codex にサインインしていません",
    });
  });

  test("保存された OAuth から access token と accountId を返す", async () => {
    const credentialDir = tempDir();

    prepareCredentialDir(credentialDir);
    writeCredential(credentialDir, {
      type: "oauth",
      access: "access-sentinel",
      refresh: "refresh-sentinel",
      expires: Date.now() + 60 * 60 * 1000,
      accountId: "account-sentinel",
    });

    const auth = createCodexAuth({ credentialDir });

    expect(auth.signedIn()).toBe(true);
    expect(await auth.credential()).toEqual({ accessToken: "access-sentinel", accountId: "account-sentinel" });
  });

  test("accountId が無ければ再サインインとして扱う", async () => {
    const credentialDir = tempDir();

    prepareCredentialDir(credentialDir);
    writeCredential(credentialDir, {
      type: "oauth",
      access: "access-sentinel",
      refresh: "refresh-sentinel",
      expires: Date.now() + 60 * 60 * 1000,
    });

    await expect(createCodexAuth({ credentialDir }).credential()).rejects.toMatchObject({
      code: "reauth_required",
    });
  });

  test("API キーが保存されていても OAuth としては扱わない", async () => {
    const credentialDir = tempDir();

    prepareCredentialDir(credentialDir);
    writeCredential(credentialDir, { type: "api_key", key: "key-sentinel" });

    const auth = createCodexAuth({ credentialDir });

    expect(auth.signedIn()).toBe(false);
    await expect(auth.credential()).rejects.toMatchObject({ code: "not_connected" });
  });

  test("資格情報ディレクトリの中だけを使い、SDK が作る auth.json も 0600", async () => {
    const credentialDir = tempDir();

    prepareCredentialDir(credentialDir);

    const auth = createCodexAuth({ credentialDir });

    await auth.credential().catch(() => undefined);

    // SDK は空の auth.json を用意するが、置き場は資格情報ディレクトリの中だけ。
    expect(readdirSync(credentialDir)).toEqual(["auth.json"]);
    expect(mode(join(credentialDir, "auth.json"))).toBe(0o600);
  });
});
