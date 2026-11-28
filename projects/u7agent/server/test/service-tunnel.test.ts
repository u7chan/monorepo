// 一時共有の状態機械を、起動基盤・ゲート・時計・DNS を差し替えて固定する。
// cloudflared もサンドボックスも起動せず、開始・停止・期限・置き換え・失敗の分岐だけを見る。

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Hono } from "hono";
import {
  CloudflaredLaunchError,
  type CloudflaredHandle,
  type CloudflaredLauncher,
  type CloudflaredExit,
} from "../src/cloudflared";
import type { RuntimeServeStatus } from "../src/schema";
import { ServeTunnelService, type TunnelDnsLookup } from "../src/service-tunnel";
import { createServiceProxy } from "../src/service-proxy";
import type { TunnelGate, TunnelGateOptions } from "../src/tunnel-gate";
import type { TunnelTimers } from "../src/tunnel-timers";

const STATUS: RuntimeServeStatus = {
  reachable: true,
  owner: { sessionId: "session-1", title: "アプリの会話" },
  generation: "gen-1",
  command: { cwd: "projects/app", command: "pnpm dev" },
};

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const timers: TunnelTimers = {
    setTimeout(callback, ms) {
      const handle = next++;
      pending.set(handle, { callback, ms });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => [...pending.values()],
    async runAll() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

interface FakeHandle extends CloudflaredHandle {
  originPort: number;
  stops: number;
  resolveReady(url: string): void;
  rejectReady(error: unknown): void;
  resolveExit(exit: CloudflaredExit): void;
}

function fakeLauncher(options: { available?: boolean; ready?: (handle: FakeHandle) => void } = {}) {
  const handles: FakeHandle[] = [];
  const launcher: CloudflaredLauncher = {
    availability: () =>
      options.available === false
        ? { available: false, reason: "binary_missing" }
        : { available: true, binary: "/usr/local/libexec/u7agent/cloudflared", stateDir: "/store/tunnel" },
    launch({ originPort }) {
      let resolveReady!: (value: { url: string }) => void;
      let rejectReady!: (error: unknown) => void;
      let resolveExit!: (exit: CloudflaredExit) => void;
      const ready = new Promise<{ url: string }>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const exited = new Promise<CloudflaredExit>((resolve) => {
        resolveExit = resolve;
      });
      const handle: FakeHandle = {
        originPort,
        stops: 0,
        ready,
        exited,
        resolveReady: (url) => resolveReady({ url }),
        rejectReady,
        resolveExit,
        stop: async () => {
          handle.stops++;
          rejectReady(new CloudflaredLaunchError("aborted"));
        },
      };
      handles.push(handle);
      options.ready?.(handle);
      return handle;
    },
    sweepOrphans: async () => ({ killed: 0, failed: 0, removedRecords: 0, removedHomes: 0 }),
  };
  return { launcher, handles };
}

interface FakeGate {
  options: TunnelGateOptions;
  closed: number;
  failListen: boolean;
}

function fakeGates() {
  const gates: FakeGate[] = [];
  const createGate = (options: TunnelGateOptions): TunnelGate => {
    const gate: FakeGate = { options, closed: 0, failListen: false };
    gates.push(gate);
    return {
      app: new Hono(),
      listen: async () => {
        if (gate.failListen) throw new Error("listen failed");
        return 41000 + gates.length;
      },
      close: async () => {
        gate.closed++;
      },
    };
  };
  return { gates, createGate };
}

function setup(
  options: {
    status?: RuntimeServeStatus;
    launcher?: ReturnType<typeof fakeLauncher>;
    timers?: ReturnType<typeof fakeTimers>;
    dns?: TunnelDnsLookup;
    sandboxConfigured?: boolean;
    now?: () => number;
    statusError?: unknown;
  } = {},
) {
  const launcher = options.launcher ?? fakeLauncher({ ready: (handle) => handle.resolveReady("https://quick.test") });
  const fakes = options.timers ?? fakeTimers();
  const gateFactory = fakeGates();
  const dnsCalls: string[] = [];
  let current: RuntimeServeStatus = options.status ?? STATUS;
  const service = new ServeTunnelService({
    launcher: launcher.launcher,
    serve: {
      runtimeStatus: async () => {
        if (options.statusError !== undefined) throw options.statusError;
        return current;
      },
    },
    sandboxConfigured: options.sandboxConfigured ?? true,
    createGate: gateFactory.createGate,
    timers: fakes.timers,
    dns:
      options.dns ??
      (async (hostname) => {
        dnsCalls.push(hostname);
        return true;
      }),
    sleep: async () => {},
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    service,
    launcher,
    gates: gateFactory.gates,
    timers: fakes,
    dnsCalls,
    setStatus: (status: RuntimeServeStatus) => {
      current = status;
    },
  };
}

test("開始すると active になり、束縛した対象と期限を返す", async () => {
  const { service, launcher, gates, dnsCalls, timers } = setup({ now: () => 1_000 });
  const status = await service.start({ generation: "gen-1", ttlMinutes: 60 });

  assert.equal(status.state, "active");
  assert.equal(status.available, true);
  assert.equal(status.provider, "cloudflare-quick");
  assert.deepEqual(status.active, {
    url: "https://quick.test",
    startedAt: 1_000,
    expiresAt: 1_000 + 60 * 60_000,
    target: { title: "アプリの会話", cwd: "projects/app", command: "pnpm dev" },
  });
  assert.equal(status.lastEnded, null);
  assert.deepEqual(status.active === null ? [] : [status.active.url], ["https://quick.test"]);
  assert.deepEqual(dnsCalls, ["quick.test"]);
  assert.equal(gates[0]?.options.binding.sessionId, "session-1");
  assert.equal(launcher.handles[0]?.originPort, 41001);
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0]?.ms, 60 * 60_000);
});

test("期限が来たら idle に戻り、理由 expired を残す", async () => {
  const { service, launcher, gates, timers } = setup();
  await service.start({ generation: "gen-1", ttlMinutes: 15 });
  await timers.runAll();

  const status = service.status();
  assert.equal(status.state, "idle");
  assert.equal(status.active, null);
  assert.equal(status.lastEnded?.reason, "expired");
  assert.equal(status.lastEnded?.message, undefined);
  assert.equal(launcher.handles[0]?.stops, 1);
  assert.equal(gates[0]?.closed, 1);
});

test("cloudflared が ready の後に終了したら理由 exited で片付ける", async () => {
  const { service, launcher, gates } = setup();
  await service.start({ generation: "gen-1", ttlMinutes: 15 });
  launcher.handles[0]?.resolveExit({ code: 1, signal: null, stderrTail: "" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.status().state, "idle");
  assert.equal(service.status().lastEnded?.reason, "exited");
  assert.equal(gates[0]?.closed, 1);
});

test("停止は冪等で、理由 stopped を 1 回だけ残す", async () => {
  const { service, launcher, gates } = setup();
  await service.start({ generation: "gen-1", ttlMinutes: 60 });
  assert.equal((await service.stop()).state, "idle");
  assert.equal((await service.stop()).state, "idle");
  assert.equal(service.status().lastEnded?.reason, "stopped");
  assert.equal(launcher.handles[0]?.stops, 1);
  assert.equal(gates[0]?.closed, 1);
});

test("generation が一致しなければ 409 で、何も起動せず直近の終了も残さない", async () => {
  const { service, launcher, gates, timers } = setup();
  await assert.rejects(service.start({ generation: "stale", ttlMinutes: 60 }), (error: { statusCode?: number }) => {
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.equal(service.status().state, "idle");
  assert.equal(service.status().lastEnded, null);
  assert.equal(launcher.handles.length, 0);
  assert.equal(gates.length, 0);
  assert.equal(timers.pending().length, 0);
});

test("到達不可のサービスは 409 で開始しない", async () => {
  const { service, launcher } = setup({
    status: { reachable: false, owner: null, generation: null, command: null },
  });
  await assert.rejects(service.start({ generation: "gen-1", ttlMinutes: 60 }), (error: { statusCode?: number }) => {
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.equal(launcher.handles.length, 0);
});

test("使用中の開始は 409 で止め、代わりの共有を作らない", async () => {
  const { service, launcher } = setup();
  const started = service.start({ generation: "gen-1", ttlMinutes: 60 });
  await assert.rejects(service.start({ generation: "gen-1", ttlMinutes: 60 }), (error: { statusCode?: number }) => {
    assert.equal(error.statusCode, 409);
    return true;
  });
  await started;
  assert.equal(launcher.handles.length, 1);
});

test("起動基盤が使えないときは 503 で、開始しない", async () => {
  const { service } = setup({ launcher: fakeLauncher({ available: false }) });
  assert.equal(service.status().available, false);
  assert.ok(service.status().unavailableReason?.includes("cloudflared"));
  await assert.rejects(service.start({ generation: "gen-1", ttlMinutes: 60 }), (error: { statusCode?: number }) => {
    assert.equal(error.statusCode, 503);
    return true;
  });
});

test("サンドボックス未設定は 503 で開始しない", async () => {
  const { service, launcher } = setup({ sandboxConfigured: false });
  await assert.rejects(service.start({ generation: "gen-1", ttlMinutes: 60 }), (error: { statusCode?: number }) => {
    assert.equal(error.statusCode, 503);
    return true;
  });
  assert.equal(launcher.handles.length, 0);
});

test("ready の失敗は分類ごとの固定文言で 502 にし、ゲートと子を片付ける", async () => {
  const launcher = fakeLauncher({ ready: (handle) => handle.rejectReady(new CloudflaredLaunchError("rejected")) });
  const { service, gates } = setup({ launcher });
  await assert.rejects(
    service.start({ generation: "gen-1", ttlMinutes: 60 }),
    (error: { statusCode?: number; message: string }) => {
      assert.equal(error.statusCode, 502);
      assert.ok(error.message.includes("拒否"));
      return true;
    },
  );
  assert.equal(service.status().state, "idle");
  assert.equal(service.status().lastEnded?.reason, "failed");
  assert.equal(gates[0]?.closed, 1);
});

test("DNS を確認できなければ 502 で片付け、URL を出さない", async () => {
  const { service, launcher, gates } = setup({ dns: async () => false });
  await assert.rejects(service.start({ generation: "gen-1", ttlMinutes: 60 }), (error: { statusCode?: number }) => {
    assert.equal(error.statusCode, 502);
    return true;
  });
  assert.equal(service.status().state, "idle");
  assert.equal(service.status().lastEnded?.reason, "failed");
  assert.equal(service.status().lastEnded?.message?.includes("名前解決"), true);
  assert.equal(launcher.handles[0]?.stops, 1);
  assert.equal(gates[0]?.closed, 1);
});

const START_FAILURES: [name: string, options: Parameters<typeof setup>[0]][] = [
  ["サービスの状態の確認", { statusError: new Error("connect ECONNREFUSED 192.0.2.10:4000") }],
  ["DNS の確認", { dns: async () => false }],
  [
    "cloudflared の拒否",
    { launcher: fakeLauncher({ ready: (handle) => handle.rejectReady(new CloudflaredLaunchError("rejected")) }) },
  ],
];

for (const [name, options] of START_FAILURES) {
  test(`開始の失敗（${name}）は、応答の文言と lastEnded.message が同じ固定文言で、生の例外を載せない`, async () => {
    const { service, launcher } = setup(options);
    await assert.rejects(
      service.start({ generation: "gen-1", ttlMinutes: 60 }),
      (error: { statusCode?: number; message: string }) => {
        assert.equal(error.statusCode, 502);
        assert.equal(error.message, service.status().lastEnded?.message);
        assert.equal(error.message.includes("192.0.2.10"), false);
        return true;
      },
    );
    assert.equal(service.status().state, "idle");
    assert.equal(service.status().lastEnded?.reason, "failed");
    assert.equal(
      launcher.handles.every((handle) => handle.stops === 1),
      true,
    );
  });
}

test("starting 中の停止は開始を中断し、idle を返す", async () => {
  let releaseDns!: (value: boolean) => void;
  const dns: TunnelDnsLookup = () =>
    new Promise((resolve) => {
      releaseDns = resolve;
    });
  const { service, launcher, gates } = setup({ dns });
  const starting = service.start({ generation: "gen-1", ttlMinutes: 60 });
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = await service.stop();
  releaseDns(false);
  assert.equal(stopped.state, "idle");
  assert.equal((await starting).state, "idle");
  assert.equal(service.status().lastEnded?.reason, "stopped");
  assert.equal(launcher.handles[0]?.stops, 1);
  assert.equal(gates[0]?.closed, 1);
});

test("starting 中の shutdown も開始を中断する", async () => {
  const launcher = fakeLauncher();
  let releaseReady!: () => void;
  launcher.launcher.launch = (input) => {
    void input;
    let resolve!: (value: { url: string }) => void;
    const ready = new Promise<{ url: string }>((r) => {
      resolve = r;
    });
    releaseReady = () => resolve({ url: "https://quick.test" });
    return {
      ready,
      exited: new Promise<CloudflaredExit>(() => {}),
      stop: async () => {},
    };
  };
  const { service } = setup({ launcher });
  const starting = service.start({ generation: "gen-1", ttlMinutes: 60 });
  await new Promise((resolve) => setImmediate(resolve));
  await service.shutdown();
  releaseReady();
  assert.equal((await starting).state, "idle");
  assert.equal(service.status().lastEnded?.reason, "stopped");
});

test("ゲートが置き換えを検知したら理由 replaced で終える", async () => {
  const { service, launcher, gates } = setup();
  await service.start({ generation: "gen-1", ttlMinutes: 60 });
  gates[0]?.options.onReplaced();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.status().state, "idle");
  assert.equal(service.status().lastEnded?.reason, "replaced");
  assert.equal(launcher.handles[0]?.stops, 1);
});

test("ゲートの再束縛は active の target を更新する", async () => {
  const { service, gates } = setup();
  await service.start({ generation: "gen-1", ttlMinutes: 60 });
  gates[0]?.options.onBinding({
    generation: "gen-2",
    sessionId: "session-1",
    cwd: "projects/app",
    target: { title: "アプリの会話", cwd: "projects/app", command: "pnpm dev --host" },
  });
  assert.equal(service.status().active?.target.command, "pnpm dev --host");
});

test("開始中の stop はゲートの listen より前に来ても開始を止める", async () => {
  let releaseStatus!: (status: RuntimeServeStatus) => void;
  const pending = new Promise<RuntimeServeStatus>((resolve) => {
    releaseStatus = resolve;
  });
  const launcher = fakeLauncher();
  const service = new ServeTunnelService({
    launcher: launcher.launcher,
    serve: { runtimeStatus: () => pending },
    sandboxConfigured: true,
    createGate: fakeGates().createGate,
    dns: async () => true,
    sleep: async () => {},
  });
  const starting = service.start({ generation: "gen-1", ttlMinutes: 60 });
  const stopped = await service.stop();
  releaseStatus(STATUS);
  assert.equal(stopped.state, "idle");
  assert.equal((await starting).state, "idle");
  assert.equal(launcher.handles.length, 0);
  assert.equal(service.status().lastEnded?.reason, "stopped");
});

test("ゲートの listen に失敗したら 502 で片付ける", async () => {
  const launcher = fakeLauncher();
  const createGate = fakeGates().createGate;
  const failing: typeof createGate = (options) => {
    const gate = createGate(options);
    gate.listen = async () => {
      throw new Error("listen failed");
    };
    return gate;
  };
  const failingService = new ServeTunnelService({
    launcher: launcher.launcher,
    serve: { runtimeStatus: async () => STATUS },
    sandboxConfigured: true,
    createGate: failing,
    dns: async () => true,
    sleep: async () => {},
  });
  await assert.rejects(
    failingService.start({ generation: "gen-1", ttlMinutes: 60 }),
    (error: { statusCode?: number }) => {
      assert.equal(error.statusCode, 502);
      return true;
    },
  );
  assert.equal(failingService.status().lastEnded?.reason, "failed");
});

test("実ゲートは loopback で待ち受け、転送してから停止で閉じる", async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("上流のポートを解決できません");
  const launcher = fakeLauncher({ ready: (handle) => handle.resolveReady("https://quick.test") });
  const service = new ServeTunnelService({
    launcher: launcher.launcher,
    serve: { runtimeStatus: async () => STATUS },
    sandboxConfigured: true,
    proxy: createServiceProxy({ host: "127.0.0.1", port: address.port }),
    dns: async () => true,
    sleep: async () => {},
  });
  try {
    await service.start({ generation: "gen-1", ttlMinutes: 15 });
    const gatePort = launcher.handles[0]?.originPort;
    assert.ok(gatePort !== undefined);
    const response = await fetch(`http://127.0.0.1:${gatePort}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "upstream");
    assert.equal(response.headers.get("x-robots-tag"), "noindex");

    await service.stop();
    await assert.rejects(fetch(`http://127.0.0.1:${gatePort}/`));
  } finally {
    await service.shutdown();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("置き換えの 403 は接続を切る前に応答として届き、その後にゲートを閉じる", async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("上流のポートを解決できません");
  let current: RuntimeServeStatus = STATUS;
  const launcher = fakeLauncher({ ready: (handle) => handle.resolveReady("https://quick.test") });
  const service = new ServeTunnelService({
    launcher: launcher.launcher,
    serve: { runtimeStatus: async () => current },
    sandboxConfigured: true,
    proxy: createServiceProxy({ host: "127.0.0.1", port: address.port }),
    dns: async () => true,
    sleep: async () => {},
  });
  try {
    await service.start({ generation: "gen-1", ttlMinutes: 15 });
    const gatePort = launcher.handles[0]?.originPort;
    assert.ok(gatePort !== undefined);
    assert.equal((await fetch(`http://127.0.0.1:${gatePort}/`)).status, 200);

    current = {
      reachable: true,
      owner: { sessionId: "session-2", title: "別の会話" },
      generation: "gen-2",
      command: { cwd: "projects/other", command: "pnpm dev" },
    };
    const replaced = await fetch(`http://127.0.0.1:${gatePort}/`);
    assert.equal(replaced.status, 403);
    assert.equal(await replaced.text(), "公開するアプリが置き換わったため、共有は終了しました");
    for (let index = 0; index < 50 && service.status().state !== "idle"; index++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(service.status().lastEnded?.reason, "replaced");
  } finally {
    await service.shutdown();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
