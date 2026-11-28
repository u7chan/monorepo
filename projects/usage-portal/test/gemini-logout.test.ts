// Gemini のログアウトで、token の削除・進行中の取得との直列化・未接続の確認・状態の消し方を固定する。
// token は一時ディレクトリの偽 HOME に置き、CLI は「token があれば接続済み」と答える偽の実装にする。
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GeminiCliError, geminiTokenPath, type GeminiCli, type GeminiCliResult } from "../src/server/gemini/cli";
import { GEMINI_MANUAL_COOLDOWN_MS, createGeminiUsageService } from "../src/server/gemini/service";
import {
  loadProviderUsage,
  openDatabase,
  saveProviderError,
  saveProviderSnapshot,
  type DatabaseHandle,
} from "../src/server/db";
import { parseGeminiUsage } from "../src/server/providers/gemini";
import { BASE_TIME } from "./support";

const MINUTE = 60 * 1000;
const SIGN_IN_STDERR = "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";
const TOKEN_BODY = "token-SENTINEL";
const USAGE_BODY = {
  command: {
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 0.25, reset_time: "2026-11-28T12:57:12Z" }],
        },
      ],
    },
  },
};

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  dirs.push(dir);

  return dir;
}

function open(): DatabaseHandle {
  const handle = openDatabase(tempDir("usage-portal-gemini-logout-db-"));

  handles.push(handle);

  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

type Override = (
  args: readonly string[],
  seenToken: boolean,
) => GeminiCliResult | Error | Promise<GeminiCliResult> | null;

function harness(options: { token?: boolean; override?: Override } = {}) {
  let clock = BASE_TIME;
  const credentialDir = tempDir("usage-portal-gemini-logout-credentials-");
  const tokenPath = geminiTokenPath(credentialDir);
  const db = open();
  const calls: { args: string[]; tokenExisted: boolean }[] = [];
  const logs: string[] = [];

  if (options.token ?? true) {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, TOKEN_BODY, { mode: 0o000 });
    // 読めない token でも、削除はディレクトリの権限だけで通る。
    chmodSync(tokenPath, 0o000);
  }

  const cli: GeminiCli = {
    run: async (args) => {
      const tokenExisted = existsSync(tokenPath);

      calls.push({ args: [...args], tokenExisted });

      const overridden = options.override?.(args, tokenExisted) ?? null;
      const result =
        overridden ??
        (args[0] === "models"
          ? tokenExisted
            ? { exitCode: 0, stdout: "gemini-4-neon-high\tx\n", stderr: "" }
            : { exitCode: 1, stdout: "", stderr: SIGN_IN_STDERR }
          : { exitCode: 0, stdout: JSON.stringify(USAGE_BODY), stderr: "" });
      const resolved = await result;

      if (resolved instanceof Error) {
        throw resolved;
      }

      return resolved;
    },
  };
  const service = createGeminiUsageService({
    db,
    cli,
    credentialDir,
    now: () => clock,
    log: (message) => logs.push(message),
  });

  return {
    service,
    db,
    calls,
    logs,
    tokenPath,
    advance(ms: number) {
      clock += ms;
    },
    modelsCalls: () => calls.filter((call) => call.args[0] === "models").length,
  };
}

function geminiSnapshot(capturedAt: number) {
  return parseGeminiUsage(USAGE_BODY, capturedAt);
}

function rows(db: DatabaseHandle, table: string): unknown[] {
  return db.db.query(`SELECT * FROM ${table} WHERE provider = 'gemini'`).all();
}

function seedState(db: DatabaseHandle): void {
  saveProviderSnapshot(db, "gemini", geminiSnapshot(BASE_TIME - 5 * MINUTE));
  saveProviderError(db, "gemini", { code: "upstream", message: "取得できませんでした", at: BASE_TIME - MINUTE });
}

describe("GeminiUsageService.logout", () => {
  test("token を読めなくても消し、未接続を確かめてから snapshot と error を消す。sample は残す", async () => {
    const h = harness();

    seedState(h.db);

    const samples = h.db.db.query("SELECT * FROM usage_sample WHERE provider = 'gemini'").all();

    expect(samples.length).toBeGreaterThan(0);
    await expect(h.service.logout()).resolves.toBe("done");
    expect(existsSync(h.tokenPath)).toBe(false);
    // 削除してから確認する。確認の時点で token が残っていたら、確認が意味を持たない。
    expect(h.calls.map((call) => [call.args[0], call.tokenExisted])).toEqual([["models", false]]);
    expect(rows(h.db, "provider_snapshot")).toEqual([]);
    expect(rows(h.db, "provider_error")).toEqual([]);
    expect(h.db.db.query("SELECT * FROM usage_sample WHERE provider = 'gemini'").all()).toEqual(samples);
  });

  test("token が無い（ENOENT）ときも、削除済みとして確認へ進む", async () => {
    const h = harness({ token: false });

    seedState(h.db);

    await expect(h.service.logout()).resolves.toBe("done");
    expect(h.modelsCalls()).toBe(1);
    expect(rows(h.db, "provider_snapshot")).toEqual([]);
  });

  test("削除後も connected なら、状態を残して incomplete を返す", async () => {
    const h = harness({
      override: (args) =>
        args[0] === "models" ? { exitCode: 0, stdout: "gemini-4-neon-high\tx\n", stderr: "" } : null,
    });

    seedState(h.db);

    await expect(h.service.logout()).resolves.toBe("incomplete");
    expect(existsSync(h.tokenPath)).toBe(false);
    expect(rows(h.db, "provider_snapshot")).toHaveLength(1);
    expect(rows(h.db, "provider_error")).toHaveLength(1);
  });

  test("確認が期限を過ぎたら、状態を残して failed を返す", async () => {
    const h = harness({ override: (args) => (args[0] === "models" ? new GeminiCliError("timeout", "timeout") : null) });

    seedState(h.db);

    await expect(h.service.logout()).resolves.toBe("failed");
    expect(rows(h.db, "provider_snapshot")).toHaveLength(1);
    expect(rows(h.db, "provider_error")).toHaveLength(1);
  });

  test("確認が未接続の文言以外で失敗したら、状態を残して failed を返す", async () => {
    const h = harness({
      override: (args) => (args[0] === "models" ? { exitCode: 1, stdout: "", stderr: "network is unreachable" } : null),
    });

    seedState(h.db);

    await expect(h.service.logout()).resolves.toBe("failed");
    expect(rows(h.db, "provider_snapshot")).toHaveLength(1);
  });

  test("token を消せなかったら、確認へ進まず状態を残して failed を返す。もう一度実行すれば確認に進める", async () => {
    const h = harness({ token: false });

    // ファイルではなくディレクトリが置かれていて、unlink できない。
    mkdirSync(h.tokenPath, { recursive: true });
    seedState(h.db);

    await expect(h.service.logout()).resolves.toBe("failed");
    expect(h.modelsCalls()).toBe(0);
    expect(rows(h.db, "provider_snapshot")).toHaveLength(1);

    rmSync(h.tokenPath, { recursive: true, force: true });

    await expect(h.service.logout()).resolves.toBe("done");
    expect(h.modelsCalls()).toBe(1);
    expect(rows(h.db, "provider_snapshot")).toEqual([]);
  });

  test("完了したら、手動更新の 60 秒の下限を戻す", async () => {
    const h = harness();

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "skipped", reason: "cooldown" });
    await expect(h.service.logout()).resolves.toBe("done");

    // 再サインイン後の「接続を確認」は、60 秒待たずに通る。
    mkdirSync(dirname(h.tokenPath), { recursive: true });
    writeFileSync(h.tokenPath, TOKEN_BODY, { mode: 0o600 });

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    expect(GEMINI_MANUAL_COOLDOWN_MS).toBe(60_000);
  });

  test("完了しなかったときは、60 秒の下限を戻さない", async () => {
    const h = harness({
      override: (args) => (args[0] === "models" ? { exitCode: 0, stdout: "", stderr: "" } : null),
    });

    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "refreshed" });
    await expect(h.service.logout()).resolves.toBe("incomplete");
    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "skipped", reason: "cooldown" });
  });

  test("進行中の取得を待ってから token を消し、その結果は書き戻さない", async () => {
    const gate = deferred<GeminiCliResult>();
    let first = true;
    const h = harness({
      override: (args) => {
        if (args[0] === "models" && first) {
          first = false;

          return gate.promise;
        }

        return null;
      },
    });
    const refreshing = h.service.refresh("manual");
    const loggingOut = h.service.logout();

    // 取得が終わるまで token は残る。消してしまうと、CLI が書き戻す余地が残る。
    await Bun.sleep(30);
    expect(existsSync(h.tokenPath)).toBe(true);
    expect(h.modelsCalls()).toBe(1);

    gate.resolve({ exitCode: 0, stdout: "gemini-4-neon-high\tx\n", stderr: "" });

    await expect(refreshing).resolves.toEqual({ state: "skipped", reason: "logout" });
    await expect(loggingOut).resolves.toBe("done");
    expect(existsSync(h.tokenPath)).toBe(false);
    expect(rows(h.db, "provider_snapshot")).toEqual([]);
    expect(rows(h.db, "provider_error")).toEqual([]);
    expect(rows(h.db, "usage_sample")).toEqual([]);
    // 取得の models・/usage のあとに、確認の models が 1 回だけ走る。
    expect(h.calls.map((call) => call.args[0])).toEqual(["models", "-p", "models"]);
  });

  test("進行中の取得が失敗しても、ログアウト後に error を書き戻さない", async () => {
    const gate = deferred<GeminiCliResult>();
    let first = true;
    const h = harness({
      override: (args) => {
        if (args[0] === "models" && first) {
          first = false;

          return gate.promise;
        }

        return null;
      },
    });
    const refreshing = h.service.refresh("manual");
    const loggingOut = h.service.logout();

    // 取得は未接続と判定されて失敗する。ログアウトの確認とは別の結果で、書いてはならない。
    gate.resolve({ exitCode: 1, stdout: "", stderr: SIGN_IN_STDERR });

    await expect(refreshing).resolves.toEqual({ state: "skipped", reason: "logout" });
    await expect(loggingOut).resolves.toBe("done");
    expect(rows(h.db, "provider_error")).toEqual([]);
  });

  test("ログアウト中の refresh は CLI を起動せず skipped を返す", async () => {
    const gate = deferred<GeminiCliResult>();
    let first = true;
    const h = harness({
      override: (args) => {
        if (args[0] === "models" && first) {
          first = false;

          return gate.promise;
        }

        return null;
      },
    });
    const refreshing = h.service.refresh("manual");
    const loggingOut = h.service.logout();
    const before = h.calls.length;

    await expect(h.service.refresh("auto")).resolves.toEqual({ state: "skipped", reason: "logout" });
    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "skipped", reason: "logout" });
    expect(h.calls).toHaveLength(before);

    gate.resolve({ exitCode: 0, stdout: "", stderr: "" });
    await refreshing;
    await loggingOut;
  });

  test("ログアウトを重ねて呼んでも、確認は 1 回にまとめる", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.service.logout(), h.service.logout()]);

    expect(first).toBe("done");
    expect(second).toBe("done");
    expect(h.modelsCalls()).toBe(1);
  });

  test("完了のあとは refresh が再び CLI を起動できる", async () => {
    const h = harness();

    await h.service.logout();

    // token が無いので未接続として失敗するが、CLI は起動される。
    await expect(h.service.refresh("manual")).resolves.toEqual({ state: "failed", error: "not_connected" });
    expect(h.modelsCalls()).toBe(2);
  });

  test("stderr と token をログにも DB にも残さない", async () => {
    const h = harness({
      override: (args) => (args[0] === "models" ? { exitCode: 1, stdout: "", stderr: "stderr-SENTINEL" } : null),
    });

    seedState(h.db);

    await h.service.logout();
    await h.service.refresh("manual");

    expect(h.logs.join("\n")).not.toContain("SENTINEL");

    for (const table of ["provider_snapshot", "provider_error", "usage_sample"]) {
      expect(JSON.stringify(h.db.db.query(`SELECT * FROM ${table}`).all())).not.toContain("SENTINEL");
    }

    expect(loadProviderUsage(h.db, ["gemini"]).get("gemini")?.error?.message ?? "").not.toContain("SENTINEL");
  });
});
