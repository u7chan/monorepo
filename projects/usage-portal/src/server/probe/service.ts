import { randomUUID } from "node:crypto";
import {
  normalizeContext,
  type AssistantMessageEventStream,
  type Api,
  type FetchFunction,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { OpenCodeAccounts } from "../opencode/accounts";
import { findProbeModel, supportsProbeThinking } from "./catalog";
import type { ProbeSettingsStore } from "./settings";

/** 応答本文は使わない。届いたことだけを確かめるための 1 文。 */
export const PROBE_PROMPT = "Reply with the single word OK.";

/** stream 全体の上限。`timeoutMs` だけでは SSE が途中で止まったときに返らない。 */
export const PROBE_TIMEOUT_MS = 30_000;

/** OpenCode Go は API ごとの出力上限。総コストを 16 token に抑える意味ではない。 */
export const PROBE_MAX_TOKENS = 16;

/** 送信後の再取得を待つ上限。全 source の取り直しが遅い環境で、送信の結果を落とさない。 */
const KICK_WAIT_MS = 5_000;

export type ProbeErrorCode =
  | "not_configured"
  | "in_progress"
  | "reauth_required"
  | "invalid_key"
  | "limit_reached"
  | "model_unavailable"
  | "invalid_thinking"
  | "unavailable";

export type ProbeOutcome = { ok: true; latencyMs: number } | { ok: false; error: ProbeErrorCode };

export type ProbeRunner = {
  checkCodex: () => Promise<ProbeOutcome>;
  checkOpenCode: (accountId: string) => Promise<ProbeOutcome>;
};

type StreamReading = { status: number | null; failed: boolean; latencyMs: number };

/** 送信だけを差し替えられるように、adapter のうち `streamSimple` だけを要求する。 */
export type ProbeStreamProvider = { streamSimple: Provider<Api>["streamSimple"] };

type SendOptions = {
  apiKey: string;
  now: () => number;
  thinking: ModelThinkingLevel;
  userAgent: string;
  timeoutMs: number;
  extra?: Partial<SimpleStreamOptions>;
};

/**
 * pi-ai の provider adapter を直接使って最小プロンプトを 1 回だけ送る。
 * エージェントも system prompt も tools も足さない（adapter の既定だけが付く）。
 */
export function createProbeRunner(options: {
  settings: ProbeSettingsStore;
  accounts: Pick<OpenCodeAccounts, "get" | "apiKey">;
  /** `CodexAuth.credential()`。token は adapter へ渡すだけで、外へ出さない。 */
  credential: () => Promise<{ accessToken: string }>;
  userAgent: string;
  /** Codex の送信後に利用枠を取り直す。失敗は probe の結果に混ぜない。 */
  kick: () => Promise<void>;
  timeoutMs?: number;
  /** 送信後の再取得を待つ上限。 */
  kickWaitMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** テスト用の差し替え。既定は pi-ai の実 adapter。 */
  providers?: { codex?: ProbeStreamProvider; opencodeGo?: ProbeStreamProvider };
}): ProbeRunner {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const providers = {
    codex: options.providers?.codex ?? openaiCodexProvider(),
    opencodeGo: options.providers?.opencodeGo ?? opencodeGoProvider(),
  };
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  // 二重送信を防ぐ。上流の利用枠を 1 メッセージで 2 回減らさない。
  const inFlight = new Set<string>();

  async function singleFlight(key: string, task: () => Promise<ProbeOutcome>): Promise<ProbeOutcome> {
    if (inFlight.has(key)) {
      return { ok: false, error: "in_progress" };
    }

    inFlight.add(key);

    const work = task();

    // 中断後に adapter が返らない場合も、実行中の印を残さない。
    work.catch(() => undefined);

    try {
      return await Promise.race([work, after(timeoutMs * 2, { ok: false, error: "unavailable" } as const)]);
    } finally {
      inFlight.delete(key);
    }
  }

  /** kick が遅い環境で応答を止めない。失敗しても送信の結果は変えない。 */
  async function kickOrGiveUp(): Promise<void> {
    await Promise.race([
      options.kick().catch(() => log("送信後の利用枠の再取得に失敗しました")),
      after(options.kickWaitMs ?? KICK_WAIT_MS, undefined),
    ]);
  }

  return {
    async checkCodex() {
      const config = options.settings.read().codex;

      if (config === null) {
        return { ok: false, error: "not_configured" };
      }

      return singleFlight("codex", async () => {
        const model = findProbeModel("codex", config.model);

        if (model === null) {
          return { ok: false, error: "model_unavailable" };
        }

        if (!supportsProbeThinking(model, config.thinking)) {
          return { ok: false, error: "invalid_thinking" };
        }

        let accessToken: string;

        try {
          accessToken = (await options.credential()).accessToken;
        } catch {
          // SDK の例外文には token が混ざり得る。分類だけを残す。
          return { ok: false, error: "reauth_required" };
        }

        const reading = await send(providers.codex, model, {
          apiKey: accessToken,
          now,
          thinking: config.thinking,
          userAgent: options.userAgent,
          timeoutMs,
          extra: { transport: "sse", maxRetries: 0 },
        });

        const outcome = classify(reading, "reauth_required");

        // 送信がネットワークに届いたら、成功・失敗を問わず 1 回取り直す。
        // kick の完了はリセット時刻の更新を意味しないので、待つが結果には混ぜない。
        if (reading.status !== null) {
          await kickOrGiveUp();
        }

        return outcome;
      });
    },
    async checkOpenCode(accountId) {
      const account = options.accounts.get(accountId);
      const model = account?.probeModel ? findProbeModel("opencodeGo", account.probeModel) : null;
      const apiKey = account === null ? null : options.accounts.apiKey(accountId);

      if (account === null || account.probeThinking === null || apiKey === null) {
        return { ok: false, error: "not_configured" };
      }

      if (model === null) {
        // 保存後に pi-ai を更新して catalog から消えた場合。設定の見直しを促す。
        return { ok: false, error: "model_unavailable" };
      }

      if (!supportsProbeThinking(model, account.probeThinking)) {
        return { ok: false, error: "invalid_thinking" };
      }

      return singleFlight(`opencode-go:${accountId}`, async () => {
        const reading = await send(providers.opencodeGo, model, {
          apiKey,
          now,
          thinking: account.probeThinking as ModelThinkingLevel,
          userAgent: options.userAgent,
          timeoutMs,
          extra: { maxTokens: PROBE_MAX_TOKENS, sessionId: randomUUID() },
        });

        return classify(reading, "invalid_key");
      });
    },
  };
}

/** status は fetch wrapper で控える。`onResponse` は失敗時に呼ばれない adapter がある。 */
async function send(provider: ProbeStreamProvider, model: Model<Api>, options: SendOptions): Promise<StreamReading> {
  const capture = createStatusCapture();
  const startedAt = options.now();
  const stream = provider.streamSimple(model, context(), {
    apiKey: options.apiKey,
    ...reasoningOption(options.thinking),
    headers: { "user-agent": options.userAgent },
    // timeoutMs だけでは SSE が途中で止まったときに返らない。stream 全体を中断する。
    signal: AbortSignal.timeout(options.timeoutMs),
    fetch: capture.fetch,
    ...options.extra,
  });
  const failed = await drain(stream);

  return { status: capture.status(), failed, latencyMs: options.now() - startedAt };
}

/** 固定プロンプト 1 文だけ。会話履歴も system prompt も足さない。 */
function context() {
  return normalizeContext({
    messages: [{ role: "user", content: PROBE_PROMPT, timestamp: Date.now() }],
  });
}

/** `off` は `SimpleStreamOptions.reasoning` が受け付けないので、送信時だけ省略する。 */
function reasoningOption(thinking: ModelThinkingLevel): { reasoning?: SimpleStreamOptions["reasoning"] } {
  return thinking === "off" ? {} : { reasoning: thinking };
}

function classify(reading: StreamReading, authCode: "reauth_required" | "invalid_key"): ProbeOutcome {
  const error = statusError(reading.status, authCode);

  if (error !== null) {
    return { ok: false, error };
  }

  // 200 でも stream が終端していなければ成功にしない。
  if (reading.failed || reading.status !== 200) {
    return { ok: false, error: "unavailable" };
  }

  return { ok: true, latencyMs: reading.latencyMs };
}

function statusError(status: number | null, authCode: "reauth_required" | "invalid_key"): ProbeErrorCode | null {
  if (status === 401 || status === 403) {
    return authCode;
  }

  if (status === 429) {
    return "limit_reached";
  }

  if (status === 400 || status === 404) {
    return "model_unavailable";
  }

  return null;
}

/** stream を最後まで消費し、`stopReason` が終端として使えるかを見る。本文は読まない。 */
async function drain(stream: AssistantMessageEventStream): Promise<boolean> {
  try {
    for await (const _event of stream) {
      // 本文は使わない。
    }

    const message = await stream.result();
    const stopReason = typeof message?.stopReason === "string" ? message.stopReason : null;

    return stopReason === null || stopReason === "error" || stopReason === "aborted";
  } catch {
    // 上流の本文を含む例外文は外へ出さない。
    return true;
  }
}

/** body は読まない。status だけを控え、そのまま adapter へ返す。 */
function createStatusCapture(): { fetch: FetchFunction; status: () => number | null } {
  let status: number | null = null;
  const wrapper = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);

    status = response.status;

    return response;
  }) as unknown as FetchFunction;

  return { fetch: wrapper, status: () => status };
}

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);

    // 待ち手のためにプロセスを生かし続けない。
    timer.unref?.();
  });
}
