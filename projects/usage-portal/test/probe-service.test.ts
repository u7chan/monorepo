// probe service の契約（固定プロンプト・single-flight・status の丸め・stream 終端・off 省略・timeout 後の解放・kick）を固定する。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessageEventStream, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { OpenCodeAccount } from "../src/server/opencode/accounts";
import {
  createProbeRunner,
  PROBE_MAX_TOKENS,
  PROBE_PROMPT,
  type ProbeStreamProvider,
} from "../src/server/probe/service";
import type { CodexProbeConfig, ProbeSettingsStore } from "../src/server/probe/settings";
import { stubAccount } from "./support";

// 上流の HTTP は service の fetch wrapper を通って globalThis.fetch に届く。
// 偽の provider が指定した status をそのまま返し、adapter の成功・失敗を再現する。
let upstreamStatus = 200;
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", { status: upstreamStatus })) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

type Scenario = {
  /** 上流が返す HTTP status。`null` は応答前に失敗したことを表す。 */
  status?: number | null;
  /** stream の終端。省略は `stop`。 */
  stopReason?: string | null;
  /** stream が終端しない（abort されるまで待つ）。 */
  hang?: boolean;
  /** adapter が受け取った options と context を記録する。 */
  capture?: (options: SimpleStreamOptions, context: TranscriptContext) => void;
};

function fakeProvider(scenario: Scenario = {}): ProbeStreamProvider {
  return {
    streamSimple(_model, context, options) {
      scenario.capture?.(options ?? {}, context);

      if (typeof scenario.status === "number") {
        upstreamStatus = scenario.status;
      }

      const stream = {
        async *[Symbol.asyncIterator]() {
          if (scenario.status === null) {
            throw new Error("network unreachable");
          }

          if (scenario.status !== undefined) {
            const response = await options?.fetch?.("https://upstream.test/v1/stream", { method: "POST" });

            if (!response || !response.ok) {
              // adapter は非 2xx で本文を読む前に例外にする。
              throw new Error("upstream status");
            }
          }

          if (scenario.hang) {
            await new Promise((_, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
          }

          yield { type: "text_delta" };
        },
        result: async () => ({ stopReason: "stopReason" in scenario ? scenario.stopReason : "stop" }),
      };

      return stream as unknown as AssistantMessageEventStream;
    },
  };
}

function settings(config: CodexProbeConfig | null): ProbeSettingsStore {
  return { read: () => ({ codex: config }), writeCodex: () => {} };
}

function accounts(account: OpenCodeAccount | null, apiKey: string | null = "sk-probe-key") {
  return {
    get: (id: string) => (account !== null && account.id === id ? account : null),
    apiKey: (id: string) => (account !== null && account.id === id ? apiKey : null),
  };
}

function createRunner(
  overrides: {
    config?: CodexProbeConfig | null;
    account?: OpenCodeAccount | null;
    apiKey?: string | null;
    codex?: Scenario;
    opencodeGo?: Scenario;
    credential?: () => Promise<{ accessToken: string }>;
    timeoutMs?: number;
    now?: () => number;
  } = {},
) {
  const kicked: number[] = [];
  const logs: string[] = [];
  const runner = createProbeRunner({
    settings: settings(overrides.config === undefined ? { model: "gpt-6-luna", thinking: "low" } : overrides.config),
    accounts: accounts(
      overrides.account === undefined
        ? stubAccount({ probeModel: "deepseek-v4.1-flash", probeThinking: "low" })
        : overrides.account,
      overrides.apiKey === undefined ? "sk-probe-key" : overrides.apiKey,
    ),
    credential: overrides.credential ?? (async () => ({ accessToken: "access-token-sentinel" })),
    userAgent: "usage-portal-test/0.0.0",
    kick: async () => {
      kicked.push(Date.now());
    },
    timeoutMs: overrides.timeoutMs ?? 1_000,
    now: overrides.now,
    log: (message) => logs.push(message),
    providers: {
      codex: fakeProvider(overrides.codex ?? { status: 200 }),
      opencodeGo: fakeProvider(overrides.opencodeGo ?? { status: 200 }),
    },
  });

  return { runner, kicked, logs };
}

describe("checkCodex", () => {
  test("未設定は not_configured で、送信しない", async () => {
    const { runner, kicked } = createRunner({ config: null });

    expect(await runner.checkCodex()).toEqual({ ok: false, error: "not_configured" });
    expect(kicked).toEqual([]);
  });

  test("catalog に無いモデルは model_unavailable、対応しない思考レベルは invalid_thinking", async () => {
    const missing = createRunner({ config: { model: "no-such-model", thinking: "low" } });
    const thinking = createRunner({ config: { model: "gpt-6-astra", thinking: "off" } });

    expect(await missing.runner.checkCodex()).toEqual({ ok: false, error: "model_unavailable" });
    expect(await thinking.runner.checkCodex()).toEqual({ ok: false, error: "invalid_thinking" });
    expect([...missing.kicked, ...thinking.kicked]).toEqual([]);
  });

  test("資格情報が取れないときは reauth_required で、上流を叩かない", async () => {
    let sent = false;
    const { runner, kicked } = createRunner({
      credential: async () => {
        throw new Error("token expired");
      },
      codex: {
        status: 200,
        capture: () => {
          sent = true;
        },
      },
    });

    expect(await runner.checkCodex()).toEqual({ ok: false, error: "reauth_required" });
    expect(sent).toBe(false);
    expect(kicked).toEqual([]);
  });

  test("固定プロンプト 1 文だけを、設定値と User-Agent で送る", async () => {
    let captured: { options?: SimpleStreamOptions; context?: TranscriptContext } = {};
    const { runner } = createRunner({
      config: { model: "gpt-6-luna", thinking: "low" },
      codex: {
        status: 200,
        capture: (options, context) => {
          captured = { options, context };
        },
      },
    });

    expect(await runner.checkCodex()).toEqual({ ok: true, latencyMs: expect.any(Number) });

    const messages = captured.context?.messages ?? [];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe(PROBE_PROMPT);
    expect(captured.context?.messages.some((message) => message.role === "system")).toBe(false);
    expect(captured.options?.apiKey).toBe("access-token-sentinel");
    expect(captured.options?.reasoning).toBe("low");
    expect(captured.options?.transport).toBe("sse");
    expect(captured.options?.maxRetries).toBe(0);
    expect(captured.options?.headers?.["user-agent"]).toBe("usage-portal-test/0.0.0");
    expect(captured.options?.signal).toBeInstanceOf(AbortSignal);
  });

  test("思考レベル off は reasoning を省略する", async () => {
    let captured: SimpleStreamOptions = {};
    const { runner } = createRunner({
      config: { model: "gpt-5.3-codex-spark", thinking: "off" },
      codex: {
        status: 200,
        capture: (options) => {
          captured = options;
        },
      },
    });

    expect((await runner.checkCodex()).ok).toBe(true);
    expect("reasoning" in captured).toBe(false);
  });

  test("成功したら 1 回だけ kick し、失敗したら kick しない", async () => {
    const success = createRunner({ codex: { status: 200 } });
    const failure = createRunner({ codex: { status: 429 } });

    expect((await success.runner.checkCodex()).ok).toBe(true);
    expect(success.kicked).toHaveLength(1);

    expect(await failure.runner.checkCodex()).toEqual({ ok: false, error: "limit_reached" });
    // 送信はネットワークに届いているので、失敗でも取り直す。
    expect(failure.kicked).toHaveLength(1);
  });

  test("kick が返らなくても、待ち時間の上限で送信の結果を返す", async () => {
    let kicked = 0;
    const runner = createProbeRunner({
      settings: settings({ model: "gpt-6-luna", thinking: "low" }),
      accounts: accounts(null),
      credential: async () => ({ accessToken: "token" }),
      userAgent: "usage-portal-test/0.0.0",
      kick: () => {
        kicked += 1;

        return new Promise<void>(() => {});
      },
      timeoutMs: 5_000,
      kickWaitMs: 10,
      log: () => {},
      providers: { codex: fakeProvider({ status: 200 }), opencodeGo: fakeProvider() },
    });

    const startedAt = Date.now();

    expect(await runner.checkCodex()).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(kicked).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("kick の失敗は probe の結果に混ぜない", async () => {
    const runner = createProbeRunner({
      settings: settings({ model: "gpt-6-luna", thinking: "low" }),
      accounts: accounts(null),
      credential: async () => ({ accessToken: "token" }),
      userAgent: "usage-portal-test/0.0.0",
      kick: async () => {
        throw new Error("kick failed");
      },
      timeoutMs: 1_000,
      log: () => {},
      providers: { codex: fakeProvider({ status: 200 }), opencodeGo: fakeProvider() },
    });

    expect(await runner.checkCodex()).toEqual({ ok: true, latencyMs: expect.any(Number) });
  });
});

describe("checkOpenCode", () => {
  test("未設定・未知のアカウント・キー欠損は not_configured", async () => {
    const noProbe = createRunner({ account: stubAccount() });
    const noKey = createRunner({ apiKey: null });
    const missing = createRunner({ account: null });

    expect(await noProbe.runner.checkOpenCode("account-1")).toEqual({ ok: false, error: "not_configured" });
    expect(await noKey.runner.checkOpenCode("account-1")).toEqual({ ok: false, error: "not_configured" });
    expect(await missing.runner.checkOpenCode("missing")).toEqual({ ok: false, error: "not_configured" });
  });

  test("アカウントのキーで送り、maxTokens 16・セッション ID・User-Agent を渡す", async () => {
    let captured: SimpleStreamOptions = {};
    const { runner, kicked } = createRunner({
      opencodeGo: {
        status: 200,
        capture: (options) => {
          captured = options;
        },
      },
    });

    expect(await runner.checkOpenCode("account-1")).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(captured.apiKey).toBe("sk-probe-key");
    expect(captured.maxTokens).toBe(PROBE_MAX_TOKENS);
    expect(captured.reasoning).toBe("low");
    expect(typeof captured.sessionId).toBe("string");
    expect(captured.sessionId).not.toBe("");
    expect(captured.headers?.["user-agent"]).toBe("usage-portal-test/0.0.0");
    // 接続確認では全 source を取り直さない。
    expect(kicked).toEqual([]);
  });

  test("401 は invalid_key、404 は model_unavailable、429 は limit_reached に丸める", async () => {
    for (const [scenario, error] of [
      [{ status: 401 }, "invalid_key"],
      [{ status: 403 }, "invalid_key"],
      [{ status: 404 }, "model_unavailable"],
      [{ status: 400 }, "model_unavailable"],
      [{ status: 429 }, "limit_reached"],
      [{ status: 500 }, "unavailable"],
      [{ status: null }, "unavailable"],
      // 200 でも stream が error / aborted で終わったら成功にしない。
      [{ status: 200, stopReason: "error" }, "unavailable"],
      [{ status: 200, stopReason: "aborted" }, "unavailable"],
      [{ status: 200, stopReason: null }, "unavailable"],
    ] as const) {
      const { runner } = createRunner({ opencodeGo: scenario });

      expect(await runner.checkOpenCode("account-1")).toEqual({ ok: false, error });
    }
  });

  test("Codex の 401 は reauth_required に丸める", async () => {
    const { runner } = createRunner({ codex: { status: 401 } });

    expect(await runner.checkCodex()).toEqual({ ok: false, error: "reauth_required" });
  });

  test("length で終わった stream は成功として扱う", async () => {
    const { runner } = createRunner({ opencodeGo: { status: 200, stopReason: "length" } });

    expect((await runner.checkOpenCode("account-1")).ok).toBe(true);
  });
});

describe("single-flight と timeout", () => {
  test("同じ source の同時実行は in_progress にし、重ねて送らない", async () => {
    let sends = 0;
    const { runner } = createRunner({
      timeoutMs: 50,
      opencodeGo: {
        status: 200,
        hang: true,
        capture: () => {
          sends += 1;
        },
      },
    });

    const first = runner.checkOpenCode("account-1");

    expect(await runner.checkOpenCode("account-1")).toEqual({ ok: false, error: "in_progress" });
    expect(await first).toEqual({ ok: false, error: "unavailable" });
    expect(sends).toBe(1);

    // 解放されているので、次の呼び出しは in_progress にならない。
    expect((await runner.checkOpenCode("account-1")).ok).toBe(false);
  });

  test("stream が終端しないときは timeout で失敗し、実行中の印を残さない", async () => {
    const { runner } = createRunner({ timeoutMs: 20, codex: { status: 200, hang: true } });

    expect(await runner.checkCodex()).toEqual({ ok: false, error: "unavailable" });

    const next = createRunner({ codex: { status: 200 } });
    expect((await next.runner.checkCodex()).ok).toBe(true);
  });

  test("source が違えば同時に走らせない待ち行列を作らない", async () => {
    const { runner } = createRunner({ timeoutMs: 50, codex: { status: 200, hang: true } });

    // Codex が詰まっていても、OpenCode Go は別の source として送れる。
    const codex = runner.checkCodex();
    const opencode = await runner.checkOpenCode("account-1");

    expect(opencode.ok).toBe(true);
    expect(await codex).toEqual({ ok: false, error: "unavailable" });
  });
});
