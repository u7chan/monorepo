// ゲートの同一性の表・確認待ちの猶予・期限の二重確認を、状態の取得と時計を差し替えて固定する。
// サンドボックスや cloudflared には触れず、転送先は常に偽のプロキシにする。

import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { RuntimeServeStatus } from "../src/schema";
import { createTunnelGate, type TunnelBinding } from "../src/tunnel-gate";
import type { TunnelTimers } from "../src/tunnel-timers";

const BINDING: TunnelBinding = {
  generation: "gen-1",
  sessionId: "session-1",
  cwd: "projects/app",
  target: { title: "アプリの会話", cwd: "projects/app", command: "pnpm dev" },
};

function status(overrides: Partial<RuntimeServeStatus> = {}): RuntimeServeStatus {
  return {
    reachable: true,
    owner: { sessionId: "session-1", title: "アプリの会話" },
    generation: "gen-1",
    command: { cwd: "projects/app", command: "pnpm dev" },
    ...overrides,
  };
}

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const timers: TunnelTimers = {
    setTimeout(callback) {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => pending.size,
    async runAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function setup(
  options: {
    initial?: RuntimeServeStatus | Error;
    timers?: TunnelTimers;
    graceMs?: number;
    now?: () => number;
    expiresAt?: number | null;
  } = {},
) {
  let current: RuntimeServeStatus | Error = options.initial ?? status();
  let calls = 0;
  const replaced: number[] = [];
  const bindings: TunnelBinding[] = [];
  const gate = createTunnelGate({
    runtimeStatus: async () => {
      calls++;
      if (current instanceof Error) throw current;
      return current;
    },
    proxy: new Hono().all("*", (c) => c.text("app")),
    binding: BINDING,
    expiresAt: () => options.expiresAt ?? null,
    onReplaced: () => replaced.push(1),
    onBinding: (binding) => bindings.push(binding),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    gate,
    replaced,
    bindings,
    calls: () => calls,
    set(next: RuntimeServeStatus | Error) {
      current = next;
    },
  };
}

const request = (gate: ReturnType<typeof setup>["gate"]) => gate.app.request("http://gate.test/items");

test("期限切れは状態を読まずに 410 を返す", async () => {
  const { gate, calls } = setup({ now: () => 1_000, expiresAt: 1_000 });
  const response = await request(gate);
  assert.equal(response.status, 410);
  assert.equal(await response.text(), "共有の期限が切れました");
  assert.equal(calls(), 0);
});

test("到達不可は束縛を変えずに通し、プロキシの 502 に任せる", async () => {
  const { gate, bindings } = setup({
    initial: status({ reachable: false, owner: null, generation: null, command: null }),
  });
  const response = await request(gate);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "app");
  assert.deepEqual(bindings, []);
});

test("同じ generation は通す", async () => {
  const { gate } = setup();
  const response = await request(gate);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
});

test("generation が違い、起動元の会話と cwd が同じなら再束縛して通す", async () => {
  const { gate, bindings, replaced } = setup({ initial: status({ generation: "gen-2" }) });
  const response = await request(gate);
  assert.equal(response.status, 200);
  assert.equal(replaced.length, 0);
  assert.deepEqual(bindings, [{ ...BINDING, generation: "gen-2" }]);
});

test("generation が違い、起動元の会話が違えば 403 で共有を終える", async () => {
  const { gate, replaced } = setup({
    initial: status({ generation: "gen-2", owner: { sessionId: "session-2", title: "別の会話" } }),
  });
  const response = await request(gate);
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "公開するアプリが置き換わったため、共有は終了しました");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replaced, [1]);
});

test("generation が違い、cwd が違えば 403 で共有を終える", async () => {
  const { gate, replaced } = setup({
    initial: status({ generation: "gen-2", command: { cwd: "projects/other", command: "pnpm dev" } }),
  });
  const response = await request(gate);
  assert.equal(response.status, 403);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replaced, [1]);
});

test("起動元の会話を持たない束縛は、generation が変わった時点で終える", async () => {
  const { gate, replaced } = setup({ initial: status({ generation: "gen-2" }) });
  assert.equal((await request(gate)).status, 200);
  const unknown = createTunnelGate({
    runtimeStatus: async () => status({ generation: "gen-2" }),
    proxy: new Hono().all("*", (c) => c.text("app")),
    binding: { ...BINDING, sessionId: null },
    expiresAt: () => null,
    onReplaced: () => replaced.push(1),
    onBinding: () => {},
  });
  assert.equal((await request(unknown)).status, 403);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replaced, [1]);
});

test("状態を取れないときは 503 で共有を終えない", async () => {
  const { gate, replaced } = setup({ initial: new Error("sandbox down") });
  const response = await request(gate);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.deepEqual(replaced, []);
});

test("並行した要求は 1 回の確認を共有し、終了も 1 回だけ起こす", async () => {
  let release!: (value: RuntimeServeStatus) => void;
  const pending = new Promise<RuntimeServeStatus>((resolve) => {
    release = resolve;
  });
  const replaced: number[] = [];
  let calls = 0;
  const gate = createTunnelGate({
    runtimeStatus: () => {
      calls++;
      return pending;
    },
    proxy: new Hono().all("*", (c) => c.text("app")),
    binding: BINDING,
    expiresAt: () => null,
    onReplaced: () => replaced.push(1),
    onBinding: () => {},
  });
  const both = Promise.all([request(gate), request(gate)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release(status({ generation: "gen-2", owner: { sessionId: "session-2", title: "別の会話" } }));
  const [first, second] = await both;
  assert.equal(first.status, 403);
  assert.equal(second.status, 403);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replaced, [1]);
});

test("確認待ちの猶予: 同じ会話の起動し直しなら再束縛して戻る", async () => {
  const fakes = fakeTimers();
  const { gate, bindings, replaced, set } = setup({ timers: fakes.timers, graceMs: 20 });
  // まず確認待ちに入れる
  set(status({ generation: "gen-2", owner: null, command: null }));
  const response = await request(gate);
  assert.equal(response.status, 503);
  assert.equal(fakes.pending(), 1);
  assert.deepEqual(replaced, []);

  // 起動し直しが終わり、同じ会話・同じ cwd で待受が戻った
  set(status({ generation: "gen-3" }));
  await fakes.runAll();
  assert.deepEqual(bindings, [{ ...BINDING, generation: "gen-3" }]);
  assert.equal((await request(gate)).status, 200);
});

test("確認待ちの猶予: 別のアプリが待受していれば終える", async () => {
  const fakes = fakeTimers();
  const { gate, set, replaced } = setup({ timers: fakes.timers, graceMs: 20 });
  set(status({ generation: "gen-2", owner: null, command: null }));
  assert.equal((await request(gate)).status, 503);
  set(status({ generation: "gen-2", owner: { sessionId: "session-9", title: "別の会話" } }));
  await fakes.runAll();
  assert.deepEqual(replaced, [1]);
});

test("確認待ちの猶予: 到達不可になったら待ちを解いて束縛を変えない", async () => {
  const fakes = fakeTimers();
  const { gate, set, replaced, calls } = setup({ timers: fakes.timers, graceMs: 20 });
  set(status({ generation: "gen-2", owner: null, command: null }));
  assert.equal((await request(gate)).status, 503);
  set(status({ reachable: false, owner: null, generation: null, command: null }));
  await fakes.runAll();
  assert.deepEqual(replaced, []);
  const before = calls();
  assert.equal((await request(gate)).status, 200);
  assert.ok(calls() > before);
});

test("確認待ちの猶予: 確認が例外なら終えずに猶予を置き直す", async () => {
  const fakes = fakeTimers();
  const { gate, set, replaced } = setup({ timers: fakes.timers, graceMs: 20 });
  set(status({ generation: "gen-2", owner: null, command: null }));
  assert.equal((await request(gate)).status, 503);
  set(new Error("sandbox down"));
  await fakes.runAll();
  assert.deepEqual(replaced, []);
  assert.equal(fakes.pending(), 1);
  set(status({ generation: "gen-3" }));
  await fakes.runAll();
  assert.equal((await request(gate)).status, 200);
});

test("確認待ちの間に別の会話が待受を取ったら、猶予を待たずに終える", async () => {
  const fakes = fakeTimers();
  const { gate, set, replaced } = setup({ timers: fakes.timers, graceMs: 20 });
  set(status({ generation: "gen-2", owner: null, command: null }));
  assert.equal((await request(gate)).status, 503);
  set(status({ generation: "gen-3", owner: { sessionId: "session-2", title: "別の会話" } }));
  assert.equal((await request(gate)).status, 403);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replaced, [1]);
});

test("ゲートを閉じると確認待ちのタイマーを捨てる", async () => {
  const fakes = fakeTimers();
  const { gate, set } = setup({ timers: fakes.timers, graceMs: 20 });
  set(status({ generation: "gen-2", owner: null, command: null }));
  assert.equal((await request(gate)).status, 503);
  assert.equal(fakes.pending(), 1);
  await gate.close();
  assert.equal(fakes.pending(), 0);
});
