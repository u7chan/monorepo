// Go だけの正規化、取得の共有、前回値の保持と鮮度を固定する。上流の実データ・資格情報は使わない。
import { describe, expect, test } from "bun:test";
import {
  createOpenCodeStatusReader,
  OPENCODE_STATUS_API_URL,
  parseOpenCodeStatus,
} from "../src/server/opencode/status";
import type { JsonResponse } from "../src/server/providers/http";
import { BASE_TIME } from "./support";

function body(go: Record<string, unknown> = {}, root: Record<string, unknown> = {}) {
  return {
    updatedAt: BASE_TIME,
    stale: false,
    status: "degraded",
    components: [
      { service: "free", status: "degraded", reason: "upstream" },
      { service: "payg", status: "outage", reason: "errors" },
      {
        service: "go",
        status: "operational",
        reason: "none",
        since: BASE_TIME - 60_000,
        models: [],
        breakdown: [{ id: "model-a", status: "operational", reason: "none" }],
        ...go,
      },
    ],
    incidents: [],
    ...root,
  };
}

describe("parseOpenCodeStatus", () => {
  test("全体・Free・従量課金の障害を Go の状態に混ぜない", () => {
    const snapshot = parseOpenCodeStatus(body());

    expect(snapshot?.status).toBe("operational");
    expect(snapshot?.reason).toBe("none");
    expect(snapshot?.updatedAt).toBe(BASE_TIME);
    expect(snapshot?.models).toEqual([{ id: "model-a", status: "operational", reason: "none" }]);
  });

  test("性能低下・障害・モデルごとの理由を保持する", () => {
    const snapshot = parseOpenCodeStatus(
      body({
        status: "degraded",
        reason: "latency",
        breakdown: [
          { id: "model-a", status: "degraded", reason: "latency" },
          { id: "model-b", status: "outage", reason: "upstream" },
        ],
      }),
    );

    expect(snapshot?.status).toBe("degraded");
    expect(snapshot?.reason).toBe("latency");
    expect(snapshot?.models.map((model) => [model.id, model.status, model.reason])).toEqual([
      ["model-a", "degraded", "latency"],
      ["model-b", "outage", "upstream"],
    ]);
    expect(parseOpenCodeStatus(body({ status: "outage" }))?.status).toBe("outage");
  });

  test("breakdown に無い影響モデルも残すが、同じモデルを二重に返さない", () => {
    const snapshot = parseOpenCodeStatus(
      body({
        status: "degraded",
        models: [
          { id: "model-a", reason: "latency" },
          { id: "model-b", reason: "upstream" },
        ],
      }),
    );

    expect(snapshot?.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    expect(snapshot?.models[1]).toEqual({ id: "model-b", status: "degraded", reason: "upstream" });
  });

  test("未解決の Go のインシデントだけを新しい順に返し、復旧待ちも残す", () => {
    const incident = {
      service: "go",
      resolvedAt: null,
      status: "degraded",
      reason: "latency",
      models: [{ id: "model-a" }],
    };
    const snapshot = parseOpenCodeStatus(
      body(
        {},
        {
          incidents: [
            { ...incident, startedAt: BASE_TIME - 60_000 },
            { ...incident, startedAt: BASE_TIME - 30_000 },
            { ...incident, service: "free", startedAt: BASE_TIME },
            { ...incident, resolvedAt: BASE_TIME, startedAt: BASE_TIME - 90_000 },
          ],
        },
      ),
    );

    expect(snapshot?.incidents.map((item) => item.startedAt)).toEqual([BASE_TIME - 30_000, BASE_TIME - 60_000]);
    expect(snapshot?.incidents[0]?.models).toEqual(["model-a"]);
    expect(snapshot?.status).toBe("operational");
  });

  test("未知の状態・理由は正常へ丸めない", () => {
    const snapshot = parseOpenCodeStatus(
      body({
        status: "no-data",
        reason: "new-reason",
        breakdown: [{ id: "model-a", status: "new-status", reason: "new-reason" }],
      }),
    );

    expect(snapshot?.status).toBe("unknown");
    expect(snapshot?.reason).toBe("unknown");
    expect(snapshot?.models[0]?.status).toBe("unknown");
  });

  test("Go・更新時刻・鮮度が読めない応答を成功にしない", () => {
    for (const invalid of [
      null,
      [],
      {},
      body({}, { components: [] }),
      body({}, { updatedAt: "today" }),
      body({}, { updatedAt: 0 }),
      body({}, { stale: "false" }),
      body({ status: undefined }),
    ]) {
      expect(parseOpenCodeStatus(invalid)).toBeNull();
    }
  });

  test("上流の任意の本文・メタデータやモデル ID でない文字列は返さない", () => {
    const snapshot = parseOpenCodeStatus(
      body(
        {
          message: "sentinel-private",
          breakdown: [{ id: "<script>sentinel</script>", status: "degraded" }],
        },
        { history: [{ note: "sentinel-history" }], notes: ["sentinel-note"] },
      ),
    );

    expect(JSON.stringify(snapshot)).not.toContain("sentinel");
    expect(snapshot?.models).toEqual([]);
  });
});

describe("createOpenCodeStatusReader", () => {
  test("要求時だけ公開 API を取得し、資格情報を送らない", async () => {
    const calls: { url: string; headers: Record<string, string>; timeoutMs: number }[] = [];
    const read = createOpenCodeStatusReader({
      now: () => BASE_TIME,
      userAgent: "usage-portal/test",
      request: async (url, init) => {
        calls.push({ url, ...init });

        return { status: 200, json: body() };
      },
    });

    expect(calls).toHaveLength(0);
    expect((await read()).state).toBe("ok");
    expect(calls).toEqual([
      {
        url: OPENCODE_STATUS_API_URL,
        headers: { accept: "application/json", "user-agent": "usage-portal/test" },
        timeoutMs: 8_000,
      },
    ]);
  });

  test("同時取得を共有し、60 秒はキャッシュを返す", async () => {
    let clock = BASE_TIME;
    let calls = 0;
    let resolve: (response: JsonResponse) => void = () => {};
    const response = new Promise<JsonResponse>((done) => {
      resolve = done;
    });
    const read = createOpenCodeStatusReader({
      now: () => clock,
      userAgent: "test",
      request: async () => {
        calls += 1;

        return response;
      },
    });
    const first = read();
    const second = read();

    expect(calls).toBe(1);
    resolve({ status: 200, json: body() });
    expect(await first).toEqual(await second);
    clock += 59_999;
    await read();
    expect(calls).toBe(1);
    clock += 1;
    await read();
    expect(calls).toBe(2);
  });

  test("通信・HTTP・JSON・schema の失敗を Go の障害とは判定しない", async () => {
    for (const response of [
      null,
      { status: 503, json: { message: "sentinel" } },
      { status: 200, json: null },
      { status: 200, json: {} },
    ]) {
      const read = createOpenCodeStatusReader({ userAgent: "test", request: async () => response });

      expect(await read()).toEqual({ state: "error", snapshot: null });
    }
  });

  test("タイムアウトなどの例外も本文を返さず、失敗時も 60 秒空ける", async () => {
    let clock = BASE_TIME;
    let calls = 0;
    const read = createOpenCodeStatusReader({
      now: () => clock,
      userAgent: "test",
      request: async () => {
        calls += 1;
        throw new DOMException("sentinel-timeout", "TimeoutError");
      },
    });

    expect(await read()).toEqual({ state: "error", snapshot: null });
    await read();
    expect(calls).toBe(1);
    clock += 60_000;
    await read();
    expect(calls).toBe(2);
  });

  test("取得に失敗したら前回の状態と時刻を stale として残し、回復したら置き換える", async () => {
    let clock = BASE_TIME;
    let response: JsonResponse | null = { status: 200, json: body() };
    const read = createOpenCodeStatusReader({ now: () => clock, userAgent: "test", request: async () => response });

    await read();
    clock += 60_000;
    response = null;

    const stale = await read();

    expect(stale.state).toBe("stale");
    expect(stale.snapshot?.status).toBe("operational");
    expect(stale.snapshot?.updatedAt).toBe(BASE_TIME);
    clock += 60_000;
    response = { status: 200, json: body({ status: "degraded", reason: "errors" }, { updatedAt: clock }) };

    const recovered = await read();

    expect(recovered.state).toBe("ok");
    expect(recovered.snapshot?.status).toBe("degraded");
    expect(recovered.snapshot?.updatedAt).toBe(clock);
  });

  test("上流が stale と明示するか更新が 5 分より古ければ、取得成功でも stale", async () => {
    for (const root of [{ stale: true }, { updatedAt: BASE_TIME - 300_001 }]) {
      const read = createOpenCodeStatusReader({
        now: () => BASE_TIME,
        userAgent: "test",
        request: async () => ({ status: 200, json: body({}, root) }),
      });

      expect((await read()).state).toBe("stale");
    }
  });
});
