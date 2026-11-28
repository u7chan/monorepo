// Gemini の adapter が、公式 CLI の `/usage` の JSON を窓へ畳む規則と、接続の判定を固定する。
// 形は実機（agy 1.5.19）の出力を写した fixture で、値は架空。CLI は偽の実装で、ネットワークは使わない。
import { describe, expect, test } from "bun:test";
import { GeminiCliError, type GeminiCli, type GeminiCliResult } from "../src/server/gemini/cli";
import { ProviderError } from "../src/server/providers/types";
import {
  GEMINI_MODELS_ARGS,
  GEMINI_USAGE_ARGS,
  fetchGeminiUsage,
  parseGeminiUsage,
  readGeminiConnection,
} from "../src/server/providers/gemini";
import { BASE_TIME } from "./support";

const SIGN_IN_STDERR =
  "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";
const WEEKLY_RESET = "2026-12-05T07:57:12Z";
const FIVE_HOUR_RESET = "2026-11-28T12:57:12Z";

type Bucket = {
  id: string;
  name?: string;
  description?: string;
  window?: string;
  remaining_fraction?: unknown;
  reset_time?: unknown;
};

function usageBody(groups: { name: string; buckets: Bucket[] }[]): unknown {
  return {
    conversation_id: "",
    status: "SUCCESS",
    num_turns: 0,
    command: { name: "usage", data: { description: "Usage", groups } },
  };
}

function geminiGroup(buckets: Bucket[]): { name: string; buckets: Bucket[] } {
  return { name: "Gemini Models", buckets };
}

const WEEKLY: Bucket = {
  id: "gemini-weekly",
  name: "Weekly Limit Remaining",
  window: "weekly",
  remaining_fraction: 0.6,
  reset_time: WEEKLY_RESET,
};
const FIVE_HOUR: Bucket = {
  id: "gemini-5h",
  name: "Five Hour Limit Remaining",
  window: "5h",
  remaining_fraction: 0.25,
  reset_time: FIVE_HOUR_RESET,
};
const THIRD_PARTY: Bucket[] = [
  { id: "3p-weekly", window: "weekly", remaining_fraction: 0.1, reset_time: "1970-01-01T00:00:00Z" },
  { id: "3p-5h", window: "5h", remaining_fraction: 0.2, reset_time: "1970-01-01T00:00:00Z" },
];

function windowsOf(body: unknown) {
  return parseGeminiUsage(body, BASE_TIME).windows.map((window) => [
    window.id,
    window.label,
    window.durationSeconds,
    window.usedPercent,
    window.resetsAt,
  ]);
}

describe("parseGeminiUsage", () => {
  test("gemini-* の 5h と weekly を rolling と weekly の窓にし、3p-* は読まない", () => {
    const body = usageBody([geminiGroup([WEEKLY, FIVE_HOUR]), { name: "Claude and GPT models", buckets: THIRD_PARTY }]);
    const snapshot = parseGeminiUsage(body, BASE_TIME);

    expect(snapshot).toMatchObject({
      provider: "gemini",
      name: "Gemini",
      plan: null,
      capturedAt: BASE_TIME,
      limitReached: false,
      notes: [],
    });
    // 並びは上流の順ではなく rolling → weekly に固定する。
    expect(windowsOf(body)).toEqual([
      ["rolling", "ローリング", 18_000, 75, Date.parse(FIVE_HOUR_RESET)],
      ["weekly", "週次", 604_800, 40, Date.parse(WEEKLY_RESET)],
    ]);
  });

  test("3p-* だけなら、窓を 1 つも読めないので schema エラー", () => {
    expect(() =>
      parseGeminiUsage(usageBody([{ name: "Claude and GPT models", buckets: THIRD_PARTY }]), BASE_TIME),
    ).toThrow(expect.objectContaining({ code: "schema" }));
  });

  test("同じ window の gemini-* が複数あれば、使用率の高い bucket とそのリセット時刻を採る", () => {
    const body = usageBody([
      geminiGroup([
        { ...FIVE_HOUR, id: "gemini-5h", remaining_fraction: 0.9, reset_time: "2026-11-28T10:00:00Z" },
        { ...FIVE_HOUR, id: "gemini-5h-extra", remaining_fraction: 0.2, reset_time: "2026-11-28T11:00:00Z" },
        { ...FIVE_HOUR, id: "gemini-5h-other", remaining_fraction: 0.5, reset_time: "2026-11-28T12:00:00Z" },
      ]),
    ]);

    expect(windowsOf(body)).toEqual([["rolling", "ローリング", 18_000, 80, Date.parse("2026-11-28T11:00:00Z")]]);
  });

  test("リセット時刻が epoch でも読めない値でも、窓は残して resetsAt を null にする", () => {
    for (const reset of ["1970-01-01T00:00:00Z", "soon", "2026", "", null, 123, undefined]) {
      const body = usageBody([geminiGroup([{ ...FIVE_HOUR, reset_time: reset }])]);

      expect(windowsOf(body)).toEqual([["rolling", "ローリング", 18_000, 75, null]]);
    }
  });

  test("ISO 8601 のオフセット付きと小数秒を読む", () => {
    const body = usageBody([geminiGroup([{ ...FIVE_HOUR, reset_time: "2026-11-28T21:57:12.500+09:00" }])]);

    expect(windowsOf(body)[0]?.[4]).toBe(Date.parse("2026-11-28T12:57:12.500Z"));
  });

  test("remaining_fraction は 0 / 1 を境界として扱い、範囲外は clamp する", () => {
    const used = (fraction: unknown) =>
      parseGeminiUsage(usageBody([geminiGroup([{ ...FIVE_HOUR, remaining_fraction: fraction }])]), BASE_TIME);

    // 0 は使い切り（欠損ではない）。1 は未使用。
    expect(used(0).windows[0]?.usedPercent).toBe(100);
    expect(used(0).limitReached).toBe(true);
    expect(used(1).windows[0]?.usedPercent).toBe(0);
    expect(used(1).limitReached).toBe(false);

    // 残りが負なら使用率は 100 を超える。100 に丸め、超えたことだけを note で伝える。
    const over = used(-0.2);

    expect(over.windows[0]?.usedPercent).toBe(100);
    expect(over.notes).toEqual(["上限超過"]);

    // 残りが 1 を超えても 0 に丸めるだけで、note は付けない。
    const under = used(1.3);

    expect(under.windows[0]?.usedPercent).toBe(0);
    expect(under.notes).toEqual([]);
  });

  test("remaining_fraction が欠けた・数でない bucket は 0% や 100% に見立てず捨てる", () => {
    for (const fraction of [undefined, null, "0.5", Number.NaN, Number.POSITIVE_INFINITY]) {
      const body = usageBody([geminiGroup([WEEKLY, { ...FIVE_HOUR, remaining_fraction: fraction }])]);

      expect(windowsOf(body).map((window) => window[0])).toEqual(["weekly"]);
    }
  });

  test("未知の window の bucket は捨て、読める窓だけを残す。1 つも無ければ schema エラー", () => {
    const monthly: Bucket = {
      id: "gemini-monthly",
      window: "monthly",
      remaining_fraction: 0.5,
      reset_time: WEEKLY_RESET,
    };

    expect(windowsOf(usageBody([geminiGroup([monthly, WEEKLY])])).map((window) => window[0])).toEqual(["weekly"]);
    expect(() => parseGeminiUsage(usageBody([geminiGroup([monthly])]), BASE_TIME)).toThrow(
      expect.objectContaining({ code: "schema" }),
    );
  });

  test("形が違う応答は schema エラーにする", () => {
    for (const body of [null, "text", [], {}, { command: {} }, { command: { data: { groups: "x" } } }, usageBody([])]) {
      expect(() => parseGeminiUsage(body, BASE_TIME)).toThrow(ProviderError);
    }
  });

  test("bucket の name / description は snapshot に残さない", () => {
    const snapshot = parseGeminiUsage(
      usageBody([
        geminiGroup([
          { ...FIVE_HOUR, name: "name-sentinel", description: "description-sentinel" },
          { ...WEEKLY, name: "name-sentinel", description: "description-sentinel" },
        ]),
      ]),
      BASE_TIME,
    );

    expect(JSON.stringify(snapshot)).not.toContain("sentinel");
  });
});

type Call = { args: readonly string[] };

function scriptedCli(respond: (args: readonly string[]) => GeminiCliResult | Error): { cli: GeminiCli; calls: Call[] } {
  const calls: Call[] = [];

  return {
    calls,
    cli: {
      run: async (args) => {
        calls.push({ args });

        const result = respond(args);

        if (result instanceof Error) {
          throw result;
        }

        return result;
      },
    },
  };
}

const connected = (): GeminiCliResult => ({ exitCode: 0, stdout: "gemini-4-neon-high\tGemini 4 Neon\n", stderr: "" });
const signedOut = (): GeminiCliResult => ({ exitCode: 1, stdout: "", stderr: SIGN_IN_STDERR });
const usageOk = (): GeminiCliResult => ({
  exitCode: 0,
  stdout: JSON.stringify(usageBody([geminiGroup([WEEKLY, FIVE_HOUR])])),
  stderr: "",
});

describe("readGeminiConnection", () => {
  test("exit 0 は connected", async () => {
    const { cli } = scriptedCli(connected);

    await expect(readGeminiConnection(cli)).resolves.toBe("connected");
  });

  test("exit 1 で既定のサインイン文言があれば not_connected", async () => {
    const { cli } = scriptedCli(signedOut);

    await expect(readGeminiConnection(cli)).resolves.toBe("not_connected");
  });

  test("サインイン文言の無い失敗・exit 1 以外・期限超過は upstream で、未接続とは決めない", async () => {
    const failures: (GeminiCliResult | Error)[] = [
      { exitCode: 1, stdout: "", stderr: "Error: network is unreachable\n" },
      { exitCode: 2, stdout: "", stderr: SIGN_IN_STDERR },
      { exitCode: null, stdout: "", stderr: "" },
      new GeminiCliError("timeout", "timeout"),
      new Error("unexpected"),
    ];

    for (const failure of failures) {
      const { cli } = scriptedCli(() => failure);

      await expect(readGeminiConnection(cli)).rejects.toMatchObject({ code: "upstream" });
    }
  });

  test("CLI を起動できないときは config", async () => {
    const { cli } = scriptedCli(() => new GeminiCliError("spawn", "spawn"));

    await expect(readGeminiConnection(cli)).rejects.toMatchObject({ code: "config" });
  });
});

describe("fetchGeminiUsage", () => {
  test("agy models → /usage の順に呼び、窓を保存する形で返す", async () => {
    const { cli, calls } = scriptedCli((args) => (args[0] === "models" ? connected() : usageOk()));
    const snapshot = await fetchGeminiUsage({ cli, now: () => BASE_TIME });

    expect(calls.map((call) => call.args)).toEqual([GEMINI_MODELS_ARGS, GEMINI_USAGE_ARGS]);
    expect(GEMINI_USAGE_ARGS).toEqual(["-p", "/usage", "--output-format", "json"]);
    expect(snapshot.windows.map((window) => window.id)).toEqual(["rolling", "weekly"]);
    expect(snapshot.capturedAt).toBe(BASE_TIME);
  });

  test("未接続なら not_connected で、/usage は起動しない", async () => {
    const { cli, calls } = scriptedCli(signedOut);

    await expect(fetchGeminiUsage({ cli, now: () => BASE_TIME })).rejects.toMatchObject({ code: "not_connected" });
    expect(calls).toHaveLength(1);
  });

  test("接続を判定できなければ、upstream / config のどちらでも /usage は起動しない", async () => {
    for (const [failure, code] of [
      [new GeminiCliError("timeout", "timeout"), "upstream"],
      [new GeminiCliError("spawn", "spawn"), "config"],
      [{ exitCode: 1, stdout: "", stderr: "boom" }, "upstream"],
    ] as const) {
      const { cli, calls } = scriptedCli(() => failure);

      await expect(fetchGeminiUsage({ cli, now: () => BASE_TIME })).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(1);
    }
  });

  test("/usage の失敗は upstream、JSON を読めない・窓が無いは schema", async () => {
    const run = (usage: GeminiCliResult | Error) =>
      fetchGeminiUsage({
        cli: scriptedCli((args) => (args[0] === "models" ? connected() : usage)).cli,
        now: () => BASE_TIME,
      });

    await expect(run({ exitCode: 1, stdout: "", stderr: "" })).rejects.toMatchObject({ code: "upstream" });
    await expect(run(new GeminiCliError("timeout", "timeout"))).rejects.toMatchObject({ code: "upstream" });
    await expect(run({ exitCode: 0, stdout: "not json", stderr: "" })).rejects.toMatchObject({ code: "schema" });
    await expect(run({ exitCode: 0, stdout: JSON.stringify(usageBody([])), stderr: "" })).rejects.toMatchObject({
      code: "schema",
    });
  });

  test("CLI の出力と例外文を、エラーの文言に載せない", async () => {
    const { cli } = scriptedCli((args) =>
      args[0] === "models"
        ? { exitCode: 1, stdout: "stdout-sentinel", stderr: "stderr-sentinel" }
        : new Error("exception-sentinel"),
    );
    const error = await fetchGeminiUsage({ cli, now: () => BASE_TIME }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).not.toContain("sentinel");
  });
});
