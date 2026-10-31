// アカウントの保存先（作成・更新・削除・権限・原子的置き換え・壊れたファイルの扱い）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAccounts, OPENCODE_ACCOUNTS_FILE } from "../src/server/opencode/accounts";

const dirs: string[] = [];
const NOW = 1_800_000_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-opencode-accounts-"));

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

describe("createOpenCodeAccounts", () => {
  test("作成した順に並べ、uuid と保存時刻を返し、ディレクトリ 0700・ファイル 0600 にする", () => {
    let clock = NOW;
    const credentialDir = join(tempDir(), "credentials");
    const accounts = createOpenCodeAccounts({ credentialDir, now: () => clock });

    expect(accounts.list()).toEqual([]);

    const first = accounts.create({ name: "メイン", icon: "🦊", apiKey: "sk-first" });

    clock = NOW + 60_000;
    const second = accounts.create({ name: "サブ", icon: "🐼", apiKey: "sk-second" });

    expect(first.id).toMatch(UUID_PATTERN);
    expect(second.id).not.toBe(first.id);
    expect(accounts.list()).toEqual([
      { id: first.id, name: "メイン", icon: "🦊", savedAt: NOW, probeModel: null, probeThinking: null },
      { id: second.id, name: "サブ", icon: "🐼", savedAt: NOW + 60_000, probeModel: null, probeThinking: null },
    ]);
    expect(accounts.get(second.id)?.name).toBe("サブ");
    expect(accounts.apiKey(second.id)).toBe("sk-second");
    expect(mode(credentialDir)).toBe(0o700);
    expect(mode(join(credentialDir, OPENCODE_ACCOUNTS_FILE))).toBe(0o600);
    expect(existsSync(join(credentialDir, `${OPENCODE_ACCOUNTS_FILE}.tmp`))).toBe(false);
  });

  test("ファイルには version と apiKey を含む配列だけを書く", () => {
    const credentialDir = join(tempDir(), "credentials");
    const accounts = createOpenCodeAccounts({ credentialDir, now: () => NOW });

    accounts.create({ name: "メイン", icon: "🦊", apiKey: "sk-sentinel" });

    expect(JSON.parse(readFileSync(join(credentialDir, OPENCODE_ACCOUNTS_FILE), "utf8"))).toEqual({
      version: 1,
      accounts: [
        {
          id: expect.any(String),
          name: "メイン",
          icon: "🦊",
          apiKey: "sk-sentinel",
          savedAt: NOW,
          probeModel: null,
          probeThinking: null,
        },
      ],
    });
  });

  test("一部だけを更新し、保存時刻も更新する", () => {
    let clock = NOW;
    const credentialDir = join(tempDir(), "credentials");
    const accounts = createOpenCodeAccounts({ credentialDir, now: () => clock });
    const created = accounts.create({ name: "メイン", icon: "🦊", apiKey: "sk-first" });

    clock = NOW + 1_000;
    expect(accounts.update(created.id, { name: "メイン 2" })).toEqual({
      id: created.id,
      name: "メイン 2",
      icon: "🦊",
      savedAt: NOW + 1_000,
      probeModel: null,
      probeThinking: null,
    });
    expect(accounts.apiKey(created.id)).toBe("sk-first");

    clock = NOW + 2_000;
    expect(accounts.update(created.id, { icon: "🐧", apiKey: "sk-second" })).toEqual({
      id: created.id,
      name: "メイン 2",
      icon: "🐧",
      savedAt: NOW + 2_000,
      probeModel: null,
      probeThinking: null,
    });
    expect(accounts.apiKey(created.id)).toBe("sk-second");

    expect(accounts.update("missing", { name: "x" })).toBeNull();
  });

  test("削除したアカウントは一覧から消え、未知の id は false を返す", () => {
    const credentialDir = join(tempDir(), "credentials");
    const accounts = createOpenCodeAccounts({ credentialDir, now: () => NOW });
    const first = accounts.create({ name: "メイン", icon: "🦊", apiKey: "sk-first" });
    const second = accounts.create({ name: "サブ", icon: "🐼", apiKey: "sk-second" });

    expect(accounts.remove(first.id)).toBe(true);
    expect(accounts.list()).toEqual([
      { id: second.id, name: "サブ", icon: "🐼", savedAt: NOW, probeModel: null, probeThinking: null },
    ]);
    expect(accounts.apiKey(first.id)).toBeNull();
    expect(accounts.remove("missing")).toBe(false);
  });

  test("書き込みに失敗したら、前のアカウントをそのまま読める", () => {
    const credentialDir = join(tempDir(), "credentials");
    const path = join(credentialDir, OPENCODE_ACCOUNTS_FILE);
    const accounts = createOpenCodeAccounts({ credentialDir, now: () => NOW });

    accounts.create({ name: "メイン", icon: "🦊", apiKey: "sk-first" });

    // 一時ファイルの置き場を塞いで rename まで進ませない。root でも失敗させられる。
    mkdirSync(`${path}.tmp`);

    expect(() => accounts.create({ name: "サブ", icon: "🐼", apiKey: "sk-second" })).toThrow();
    expect(accounts.list().map((account) => account.name)).toEqual(["メイン"]);
  });

  test("壊れた JSON・未知の version は 0 件として扱い、内容をログに出さない", () => {
    const credentialDir = join(tempDir(), "credentials");
    const path = join(credentialDir, OPENCODE_ACCOUNTS_FILE);
    const logs: string[] = [];

    mkdirSync(credentialDir, { recursive: true, mode: 0o700 });

    const accounts = createOpenCodeAccounts({ credentialDir, now: () => NOW, log: (message) => logs.push(message) });

    for (const content of [
      "not json sk-sentinel",
      JSON.stringify({ version: 99, accounts: [] }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, accounts: [{ id: "", name: "x", icon: "🦊", apiKey: "sk", savedAt: 1 }] }),
      JSON.stringify({ version: 1, accounts: [{ id: "a", name: "x", icon: "🚀", apiKey: "sk", savedAt: 1 }] }),
      JSON.stringify({ version: 1, accounts: [{ id: "a", name: "x", icon: "🦊", apiKey: "", savedAt: 1 }] }),
    ]) {
      writeFileSync(path, content, { mode: 0o600 });

      expect(accounts.list()).toEqual([]);
      expect(accounts.apiKey("a")).toBeNull();
    }

    expect(logs).toEqual(["opencode-accounts.json を読めないため、アカウント 0 件として扱います"]);
    expect(JSON.stringify(logs)).not.toContain("sk-sentinel");
  });

  test("接続確認の設定を保存し、既存レコードは未設定として読む", () => {
    const credentialDir = join(tempDir(), "credentials");
    const path = join(credentialDir, OPENCODE_ACCOUNTS_FILE);
    const accounts = createOpenCodeAccounts({ credentialDir, now: () => NOW });

    // 旧バージョンが書いたレコード（probe の項目が無い）。
    mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        accounts: [{ id: "old", name: "旧", icon: "🦊", apiKey: "sk-old", savedAt: NOW }],
      }),
      { mode: 0o600 },
    );

    expect(accounts.list()).toEqual([
      { id: "old", name: "旧", icon: "🦊", savedAt: NOW, probeModel: null, probeThinking: null },
    ]);

    // 保存済みのモデルが catalog から消えても、ストレージを壊れた扱いにしない。
    expect(accounts.update("old", { probeModel: "gone-model", probeThinking: "low" })).toEqual({
      id: "old",
      name: "旧",
      icon: "🦊",
      savedAt: NOW,
      probeModel: "gone-model",
      probeThinking: "low",
    });
    expect(accounts.get("old")?.probeModel).toBe("gone-model");

    // 片方だけの設定は、書き込み側の不具合として壊れたファイル扱いにする。
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        accounts: [
          { id: "old", name: "旧", icon: "🦊", apiKey: "sk-old", savedAt: NOW, probeModel: "m", probeThinking: null },
        ],
      }),
      { mode: 0o600 },
    );

    expect(accounts.list()).toEqual([]);
  });

  test("read で読んだ配列を restore で書き戻せる", () => {
    const credentialDir = join(tempDir(), "credentials");
    const path = join(credentialDir, OPENCODE_ACCOUNTS_FILE);
    const accounts = createOpenCodeAccounts({ credentialDir, now: () => NOW });

    accounts.create({ name: "メイン", icon: "🦊", apiKey: "sk-first" });
    const previous = accounts.read();

    accounts.create({ name: "サブ", icon: "🐼", apiKey: "sk-second" });
    expect(accounts.list()).toHaveLength(2);

    accounts.restore(previous);
    expect(accounts.list()).toHaveLength(1);
    expect(accounts.list()[0]?.name).toBe("メイン");

    accounts.restore(null);
    expect(accounts.list()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
});
