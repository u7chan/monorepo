/**
 * Quick Tunnel の向き先になるゲート。期限と公開アプリの同一性を要求ごとに確かめ、
 * 通った要求だけを `service-proxy` へ渡す。契約は docs/service-tunnel.md。
 */
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import type { Server } from "node:http";
import type { RuntimeServeStatus, ServeTunnelTarget } from "./schema";
import { SERVE_START_TIMEOUT_MS } from "./serve";
import { systemTunnelTimers, type TunnelTimers } from "./tunnel-timers";

/** 公開しているアプリの同一性。`generation` と、起動元の会話・cwd の組で比べる */
export interface TunnelBinding {
  generation: string;
  /** 起動元の会話。生 bash 起動などで分からないときは null (その時点で再束縛しない) */
  sessionId: string | null;
  cwd: string | null;
  target: ServeTunnelTarget;
}

/** serve の起動の期限より長くしないと、正当な起動し直しの途中で共有が終わる */
export const TUNNEL_GATE_GRACE_MS = SERVE_START_TIMEOUT_MS * 2;
const RETRY_AFTER_SECONDS = "5";
/** 応答を書き終える前に接続を切ると、cloudflared が 502 に変える。強制終了までの短い猶予 */
const CLOSE_DRAIN_MS = 100;
const EXPIRED_BODY = "共有の期限が切れました";
const REPLACED_BODY = "公開するアプリが置き換わったため、共有は終了しました";
const WAITING_BODY = "アプリの状態を確認しています。しばらくしてから開き直してください";
const STATUS_BODY = "アプリの状態を確認できません。しばらくしてから開き直してください";

export interface TunnelGateOptions {
  runtimeStatus: () => Promise<RuntimeServeStatus>;
  proxy: Hono;
  binding: TunnelBinding;
  /** `active` になるまで null。ゲートの 410 はタイマーの遅れに備える二重の確認 */
  expiresAt: () => number | null;
  onReplaced: () => void;
  onBinding: (binding: TunnelBinding) => void;
  now?: () => number;
  timers?: TunnelTimers;
  graceMs?: number;
}

export interface TunnelGate {
  readonly app: Hono;
  /** 127.0.0.1 の一時ポートで待ち受け、割り当てられたポートを返す */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function tunnelBindingFrom(status: RuntimeServeStatus): TunnelBinding {
  const generation = status.generation;
  if (generation === null) throw new Error("generation の無い状態は束縛できません");
  return {
    generation,
    sessionId: status.owner?.sessionId ?? null,
    cwd: status.command?.cwd ?? null,
    target: {
      title: status.owner?.title ?? null,
      cwd: status.command?.cwd ?? null,
      command: status.command?.command ?? null,
    },
  };
}

function withNoindex(response: Response): Response {
  if (response.headers.has("x-robots-tag")) return response;
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function plain(body: string, status: 403 | 410 | 503, retryAfter = false): Response {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
  });
  if (retryAfter) headers.set("retry-after", RETRY_AFTER_SECONDS);
  return new Response(body, { status, headers });
}

export function createTunnelGate(options: TunnelGateOptions): TunnelGate {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? systemTunnelTimers;
  const graceMs = options.graceMs ?? TUNNEL_GATE_GRACE_MS;
  let binding = options.binding;
  let graceTimer: unknown = null;
  let replacing = false;
  let inflight: Promise<RuntimeServeStatus> | null = null;
  let server: Server | null = null;
  let port: number | null = null;
  let closing: Promise<void> | null = null;

  /** 並行して来た要求は、進行中の 1 回の確認を共有する (ページ表示のバーストで確認を重ねない) */
  const observe = (): Promise<RuntimeServeStatus> => {
    if (inflight) return inflight;
    const promise = options.runtimeStatus().finally(() => {
      if (inflight === promise) inflight = null;
    });
    inflight = promise;
    return promise;
  };

  const clearGrace = () => {
    if (graceTimer !== null) {
      timers.clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const replace = () => {
    clearGrace();
    if (replacing) return;
    replacing = true;
    // 応答を返した後に閉じる (ハンドラの中でゲートの close を待たない)
    queueMicrotask(() => options.onReplaced());
  };

  const rebind = (status: RuntimeServeStatus) => {
    binding = tunnelBindingFrom(status);
    options.onBinding(binding);
  };

  const sameTarget = (status: RuntimeServeStatus): boolean =>
    binding.sessionId !== null && status.owner?.sessionId === binding.sessionId && status.command?.cwd === binding.cwd;

  const decide = (status: RuntimeServeStatus): "pass" | "wait" | "replaced" => {
    if (!status.reachable) {
      clearGrace();
      return "pass";
    }
    if (status.generation === null) {
      armGrace();
      return "wait";
    }
    if (status.generation === binding.generation) {
      clearGrace();
      return "pass";
    }
    if (binding.sessionId === null) {
      replace();
      return "replaced";
    }
    if (status.owner === null) {
      armGrace();
      return "wait";
    }
    if (sameTarget(status)) {
      rebind(status);
      clearGrace();
      return "pass";
    }
    replace();
    return "replaced";
  };

  /** 猶予が満了したら、要求が来ていなくてもここで決める (確認待ちを残したままにしない) */
  const decideAfterGrace = async () => {
    graceTimer = null;
    if (closing) return;
    let status: RuntimeServeStatus;
    try {
      status = await observe();
    } catch {
      armGrace();
      return;
    }
    if (closing) return;
    if (!status.reachable) return;
    if (status.generation === null) {
      armGrace();
      return;
    }
    if (status.generation === binding.generation) return;
    if (sameTarget(status)) {
      rebind(status);
      return;
    }
    // 待受だけが入れ替わった (owner が null のまま) 場合も、ここで共有ごと終える
    replace();
  };

  function armGrace() {
    if (closing || graceTimer !== null) return;
    graceTimer = timers.setTimeout(() => void decideAfterGrace(), graceMs);
  }

  const app = new Hono();
  app.all("*", async (c) => {
    const expiresAt = options.expiresAt();
    if (expiresAt !== null && now() >= expiresAt) return plain(EXPIRED_BODY, 410);
    let status: RuntimeServeStatus;
    try {
      status = await observe();
    } catch {
      return plain(STATUS_BODY, 503, true);
    }
    const decision = decide(status);
    if (decision === "replaced") return plain(REPLACED_BODY, 403);
    if (decision === "wait") return plain(WAITING_BODY, 503, true);
    return withNoindex(await options.proxy.fetch(c.req.raw));
  });

  return {
    app,
    async listen() {
      if (port !== null) return port;
      const created = createAdaptorServer({ fetch: app.fetch }) as Server;
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(0, "127.0.0.1", () => {
          created.off("error", reject);
          resolve();
        });
      });
      const address = created.address();
      if (address === null || typeof address === "string") {
        created.close();
        throw new Error("ゲートの待受ポートを解決できませんでした");
      }
      server = created;
      port = address.port;
      return port;
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        clearGrace();
        const active = server;
        server = null;
        if (!active) return;
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          active.close(() => {
            if (timer) clearTimeout(timer);
            resolve();
          });
          // close は新しい接続を止めるだけなので、猶予の後に keep-alive の接続も切る
          timer = setTimeout(() => active.closeAllConnections?.(), CLOSE_DRAIN_MS);
          timer.unref();
        });
      })();
      return closing;
    },
  };
}
