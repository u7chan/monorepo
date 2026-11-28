/**
 * 一時共有の状態と開始・停止。ゲートと cloudflared の起動基盤を 1 本の状態機械にまとめ、
 * 状態はメモリだけに持つ。契約は docs/service-tunnel.md。
 */
import type { Hono } from "hono";
import {
  CloudflaredLaunchError,
  cloudflaredUnavailableMessage,
  type CloudflaredFailureKind,
  type CloudflaredLauncher,
  type CloudflaredHandle,
} from "./cloudflared";
import { httpError } from "./errors";
import type {
  RuntimeServeStatus,
  ServeTunnelEndReason,
  ServeTunnelStatus,
  ServeTunnelTarget,
  ServeTunnelTtlMinutes,
} from "./schema";
import { SerialLock } from "./serial-lock";
import { createServiceProxy } from "./service-proxy";
import { createTunnelGate, tunnelBindingFrom, type TunnelGate } from "./tunnel-gate";
import { systemTunnelTimers, type TunnelTimers } from "./tunnel-timers";

export const TUNNEL_TTLS: readonly ServeTunnelTtlMinutes[] = [15, 60, 180];
/** `ready` の後も名前が引けない時間があるため、別に上限を置く (docs/service-tunnel.md) */
export const TUNNEL_DNS_DEADLINE_MS = 30_000;
const TUNNEL_DNS_QUERY_TIMEOUT_MS = 5_000;
const TUNNEL_DNS_POLL_MS = 500;
/** 名前が見えてから、利用者へ URL を見せる前に短く待つ */
export const TUNNEL_DNS_SETTLE_MS = 2_000;

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const STATUS_FAILED_MESSAGE = "サービスの状態を取得できませんでした。時間を置いてから再試行してください";
const DNS_FAILED_MESSAGE = "共有 URL の名前解決を確認できませんでした。時間を置いてから再試行してください";
const GATE_FAILED_MESSAGE = "共有を開始できませんでした。時間を置いてから再試行してください";

export type TunnelDnsLookup = (hostname: string, signal: AbortSignal) => Promise<boolean>;

export interface ServeTunnelStatusSource {
  status(): ServeTunnelStatus;
}

export interface ServeTunnelControl extends ServeTunnelStatusSource {
  start(input: { generation: string; ttlMinutes: ServeTunnelTtlMinutes }): Promise<ServeTunnelStatus>;
  stop(): Promise<ServeTunnelStatus>;
  shutdown(): Promise<void>;
}

export interface ServeTunnelServiceOptions {
  launcher: CloudflaredLauncher;
  serve: { runtimeStatus(options?: { fresh?: boolean }): Promise<RuntimeServeStatus> };
  /** サンドボックス未設定の構成では開始を 503 にする */
  sandboxConfigured: boolean;
  sandboxHost?: string;
  /** テスト用の差し替え。未指定はサンドボックス 8080 へのプロキシを組む */
  proxy?: Hono;
  /** テスト用の差し替え。未指定は 127.0.0.1 の一時ポートで待つゲートを組む */
  createGate?: typeof createTunnelGate;
  dns?: TunnelDnsLookup;
  /** テスト用の差し替え。未指定はタイマーで待つ */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timers?: TunnelTimers;
  now?: () => number;
  graceMs?: number;
  log?: (line: string) => void;
}

interface TunnelAttempt {
  aborted: boolean;
  gate: TunnelGate | null;
  handle: CloudflaredHandle | null;
  startedAt: number | null;
  expiresAt: number | null;
  timer: unknown;
  ended: Promise<void> | null;
  controller: AbortController;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A レコードの有無だけを見る。CNAME は A を返さないので、名前が引けていれば十分 */
async function lookupA(hostname: string, signal: AbortSignal): Promise<boolean> {
  const query = `${DNS_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=A`;
  const timeout = AbortSignal.timeout(TUNNEL_DNS_QUERY_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetch(query, { headers: { accept: "application/dns-json" }, signal: combined });
    if (!response.ok) return false;
    const body = (await response.json()) as { Status?: number; Answer?: Array<{ type?: number }> };
    return body.Status === 0 && (body.Answer ?? []).some((answer) => answer.type === 1);
  } catch {
    return false;
  }
}

export async function confirmTunnelDns(hostname: string, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + TUNNEL_DNS_DEADLINE_MS;
  while (!signal.aborted && Date.now() < deadline) {
    if (await lookupA(hostname, signal)) return true;
    if (signal.aborted || Date.now() >= deadline) return false;
    await sleep(TUNNEL_DNS_POLL_MS);
  }
  return false;
}

function launchFailureMessage(kind: CloudflaredFailureKind): string {
  switch (kind) {
    case "network":
      return "Cloudflare に接続できませんでした。時間を置いてから再試行してください";
    case "rejected":
      return "Cloudflare が共有の作成を拒否しました。時間を置いてから再試行してください";
    case "timeout":
      return "共有の作成が時間内に完了しませんでした。時間を置いてから再試行してください";
    case "unavailable":
      return "一時共有の起動基盤を使えません (設定を確認してください)";
    case "exited":
    case "aborted":
      return "cloudflared が予期せず終了しました。時間を置いてから再試行してください";
  }
}

export class ServeTunnelService implements ServeTunnelControl {
  #launcher: CloudflaredLauncher;
  #serve: ServeTunnelServiceOptions["serve"];
  #sandboxConfigured: boolean;
  #proxy: Hono;
  #createGate: typeof createTunnelGate;
  #dns: TunnelDnsLookup;
  #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #timers: TunnelTimers;
  #now: () => number;
  #graceMs: number | undefined;
  #log: (line: string) => void;
  #startLock = new SerialLock();

  #state: "idle" | "starting" | "active" = "idle";
  #active: { url: string; startedAt: number; expiresAt: number; target: ServeTunnelTarget } | null = null;
  #lastEnded: { reason: ServeTunnelEndReason; at: number; message?: string } | null = null;
  #attempt: TunnelAttempt | null = null;
  #currentUrl: string | null = null;

  constructor(options: ServeTunnelServiceOptions) {
    this.#launcher = options.launcher;
    this.#serve = options.serve;
    this.#sandboxConfigured = options.sandboxConfigured;
    this.#dns = options.dns ?? confirmTunnelDns;
    this.#timers = options.timers ?? systemTunnelTimers;
    this.#sleep = options.sleep ?? ((ms, signal) => this.#sleepWithTimers(ms, signal));
    this.#now = options.now ?? Date.now;
    this.#graceMs = options.graceMs;
    this.#log = options.log ?? (() => {});
    this.#createGate = options.createGate ?? createTunnelGate;
    this.#proxy =
      options.proxy ??
      createServiceProxy({
        ...(options.sandboxHost === undefined ? {} : { host: options.sandboxHost }),
        serviceOrigin: () => this.#currentUrl ?? undefined,
      });
  }

  status(): ServeTunnelStatus {
    const availability = this.#launcher.availability();
    return {
      available: availability.available,
      unavailableReason: availability.available ? null : cloudflaredUnavailableMessage(availability.reason),
      state: this.#state,
      provider: "cloudflare-quick",
      active: this.#active,
      lastEnded: this.#lastEnded,
    };
  }

  async start(input: { generation: string; ttlMinutes: ServeTunnelTtlMinutes }): Promise<ServeTunnelStatus> {
    if (!TUNNEL_TTLS.includes(input.ttlMinutes)) {
      throw httpError(400, "期限は 15 / 60 / 180 分から選んでください");
    }
    if (this.#state !== "idle") throw httpError(409, "すでに一時共有を開始しています");
    const availability = this.#launcher.availability();
    if (!availability.available) throw httpError(503, cloudflaredUnavailableMessage(availability.reason));
    if (!this.#sandboxConfigured) {
      throw httpError(503, "サンドボックスが設定されていないため、一時共有を開始できません");
    }
    const attempt: TunnelAttempt = {
      aborted: false,
      gate: null,
      handle: null,
      startedAt: null,
      expiresAt: null,
      timer: null,
      ended: null,
      controller: new AbortController(),
    };
    // 待たせる前に starting にして、2 本目の開始を 409 で止める
    this.#attempt = attempt;
    this.#state = "starting";
    this.#lastEnded = null;
    return this.#startLock.run(() => this.#run(attempt, input));
  }

  /** 開始のロックには並ばない。`starting` 中は起動基盤の stop() で待ちを中断する */
  async stop(): Promise<ServeTunnelStatus> {
    const attempt = this.#attempt;
    if (attempt) await this.#end(attempt, "stopped");
    return this.status();
  }

  async shutdown(): Promise<void> {
    const attempt = this.#attempt;
    if (attempt) await this.#end(attempt, "stopped");
  }

  async #run(
    attempt: TunnelAttempt,
    input: { generation: string; ttlMinutes: ServeTunnelTtlMinutes },
  ): Promise<ServeTunnelStatus> {
    try {
      if (attempt.aborted) return this.#abort(attempt);
      let status: RuntimeServeStatus;
      try {
        status = await this.#serve.runtimeStatus({ fresh: true });
      } catch (error) {
        await this.#end(attempt, "failed", STATUS_FAILED_MESSAGE);
        throw error;
      }
      if (attempt.aborted) return this.#abort(attempt);
      if (!status.reachable) {
        await this.#end(attempt, null);
        throw httpError(409, "サービスが稼働していません");
      }
      if (status.generation === null || status.generation !== input.generation) {
        await this.#end(attempt, null);
        throw httpError(409, "サービスの状態が変わりました。最新の状態で確認し直してください");
      }

      const binding = tunnelBindingFrom(status);
      const gate = this.#createGate({
        runtimeStatus: () => this.#serve.runtimeStatus(),
        proxy: this.#proxy,
        binding,
        expiresAt: () => attempt.expiresAt,
        onReplaced: () => void this.#end(attempt, "replaced"),
        onBinding: (next) => {
          if (this.#attempt === attempt && this.#active !== null) {
            this.#active = { ...this.#active, target: next.target };
          }
        },
        now: this.#now,
        timers: this.#timers,
        ...(this.#graceMs === undefined ? {} : { graceMs: this.#graceMs }),
      });
      attempt.gate = gate;

      let port: number;
      try {
        port = await gate.listen();
      } catch {
        throw await this.#failStart(attempt, 502, GATE_FAILED_MESSAGE);
      }
      if (attempt.aborted) return this.#abort(attempt);

      let handle: CloudflaredHandle;
      try {
        handle = this.#launcher.launch({ originPort: port });
      } catch (error) {
        return this.#rejectStart(attempt, error);
      }
      attempt.handle = handle;

      let ready: { url: string };
      try {
        ready = await handle.ready;
      } catch (error) {
        if (attempt.aborted || (error instanceof CloudflaredLaunchError && error.kind === "aborted")) {
          return this.#abort(attempt);
        }
        return this.#rejectStart(attempt, error);
      }
      if (attempt.aborted) return this.#abort(attempt);

      const url = ready.url;
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        throw await this.#failStart(attempt, 502, GATE_FAILED_MESSAGE);
      }
      let visible: boolean;
      try {
        visible = await this.#dns(hostname, attempt.controller.signal);
      } catch {
        visible = false;
      }
      if (attempt.aborted) return this.#abort(attempt);
      if (!visible) throw await this.#failStart(attempt, 502, DNS_FAILED_MESSAGE);
      await this.#sleep(TUNNEL_DNS_SETTLE_MS, attempt.controller.signal);
      if (attempt.aborted) return this.#abort(attempt);

      const startedAt = this.#now();
      const expiresAt = startedAt + input.ttlMinutes * 60_000;
      attempt.startedAt = startedAt;
      attempt.expiresAt = expiresAt;
      if (this.#attempt !== attempt) return this.status();
      this.#currentUrl = url;
      this.#state = "active";
      this.#active = { url, startedAt, expiresAt, target: binding.target };
      attempt.timer = this.#timers.setTimeout(() => void this.#end(attempt, "expired"), expiresAt - startedAt);
      void handle.exited.then(
        () => void this.#end(attempt, "exited"),
        () => void this.#end(attempt, "exited"),
      );
      this.#log("tunnel: active");
      return this.status();
    } catch (error) {
      if (attempt.ended) throw error;
      await this.#end(attempt, "failed", GATE_FAILED_MESSAGE);
      throw httpError(502, GATE_FAILED_MESSAGE);
    }
  }

  async #rejectStart(attempt: TunnelAttempt, error: unknown): Promise<never> {
    if (attempt.aborted || (error instanceof CloudflaredLaunchError && error.kind === "aborted")) {
      await this.#abort(attempt);
      throw httpError(409, "一時共有の開始を中断しました");
    }
    if (error instanceof CloudflaredLaunchError && error.kind === "unavailable") {
      const message = error.unavailableReason
        ? cloudflaredUnavailableMessage(error.unavailableReason)
        : launchFailureMessage("unavailable");
      throw await this.#failStart(attempt, 503, message);
    }
    const kind: CloudflaredFailureKind = error instanceof CloudflaredLaunchError ? error.kind : "exited";
    throw await this.#failStart(attempt, 502, launchFailureMessage(kind));
  }

  async #failStart(
    attempt: TunnelAttempt,
    statusCode: 502 | 503,
    message: string,
  ): Promise<ReturnType<typeof httpError>> {
    await this.#end(attempt, "failed", message);
    return httpError(statusCode, message);
  }

  async #abort(attempt: TunnelAttempt): Promise<ServeTunnelStatus> {
    await this.#end(attempt, "stopped");
    return this.status();
  }

  /** 片付けは 1 回だけ。null の理由は「開始しなかった」で、直近の終了を残さない */
  #end(attempt: TunnelAttempt, reason: ServeTunnelEndReason | null, message?: string): Promise<void> {
    if (attempt.ended) return attempt.ended;
    attempt.ended = (async () => {
      attempt.aborted = true;
      attempt.controller.abort();
      if (attempt.timer !== null) {
        this.#timers.clearTimeout(attempt.timer);
        attempt.timer = null;
      }
      // ゲートを先に閉じる。閉じた後に届く要求で、止めた子へ転送しない
      await attempt.gate?.close().catch(() => {});
      await attempt.handle?.stop().catch(() => {});
      if (this.#attempt === attempt) {
        this.#attempt = null;
        this.#state = "idle";
        this.#active = null;
        this.#currentUrl = null;
        if (reason !== null) {
          this.#lastEnded = { reason, at: this.#now(), ...(message === undefined ? {} : { message }) };
          this.#log(`tunnel: ${reason}`);
        }
      }
    })();
    return attempt.ended;
  }

  #sleepWithTimers(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let handle: unknown = null;
      const done = () => {
        if (handle !== null) this.#timers.clearTimeout(handle);
        signal.removeEventListener("abort", done);
        resolve();
      };
      handle = this.#timers.setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
