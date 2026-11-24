// 実行の生成物を返す API。cwd の境界、Range、上流 status の写像、完了前の拒否を固定する。
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/server/upstream";
import {
  createHarness,
  jsonResponse,
  NOW,
  RUN_ID,
  SESSION_ID,
  SESSION_URL,
  SPACE_ID,
  seedConnection,
  type Harness,
} from "./harness";

type Call = { url: string; method: string; range: string | null; path: string | null; acceptEncoding: string | null };

function createFilesUpstream(
  options: {
    cwd?: string;
    stat?: (path: string) => { status: number; path?: string };
    raw?: (path: string, range: string | null) => Response;
    download?: (path: string) => Response;
  } = {},
) {
  const calls: Call[] = [];
  let session: Record<string, unknown> = {
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    status: "completed",
    queueDepth: 0,
    cwd: options.cwd ?? "projects/app",
    run: { id: RUN_ID, status: "completed" },
    messages: [],
  };

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const path = url.searchParams.get("path");
    const headers = new Headers(init?.headers);

    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      range: headers.get("range"),
      path,
      acceptEncoding: headers.get("accept-encoding"),
    });

    if (url.pathname.startsWith("/api/sessions/")) {
      return jsonResponse(session);
    }

    if (url.pathname === "/api/files/stat") {
      const result = options.stat?.(path ?? "") ?? { status: 200, path: path ?? "" };

      return result.status === 200
        ? jsonResponse({ path: result.path })
        : jsonResponse({ error: "stat failed" }, result.status);
    }

    if (url.pathname === "/api/files/raw") {
      return (
        options.raw?.(path ?? "", headers.get("range")) ??
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Length": "3", "Accept-Ranges": "bytes", "Content-Type": "image/png" },
        })
      );
    }

    if (url.pathname === "/api/files/download") {
      return (
        options.download?.(path ?? "") ??
        new Response("<h1>hi</h1>", { status: 200, headers: { "Content-Length": "9", "Content-Type": "text/html" } })
      );
    }

    return jsonResponse({ error: "unexpected" }, 500);
  };

  return {
    calls,
    fetchImpl,
    setSession(next: Record<string, unknown>) {
      session = next;
    },
  };
}

function seedCompletedRun(harness: Harness): { token: string; connectionId: string; keyId: string } {
  const seeded = seedConnection(harness);

  harness.store.insertRun({
    runId: RUN_ID,
    connectionId: seeded.connectionId,
    keyId: seeded.keyId,
    status: "running",
    sessionUrl: SESSION_URL,
    createdAt: NOW,
    updatedAt: NOW,
  });
  harness.store.completeRun(RUN_ID, "completed", "done", null, [{ path: "generated/cafe.png", kind: "image" }], NOW);

  return seeded;
}

function fileRequest(harness: Harness, token: string, query = ""): Promise<Response> {
  return Promise.resolve(
    harness.app.request(`/v1/runs/${RUN_ID}/files${query}`, { headers: { Authorization: `Bearer ${token}` } }),
  );
}

describe("生成物のダウンロード", () => {
  test("一覧は完了した run の assets を返し、実行中は 409", async () => {
    const upstream = createFilesUpstream();
    const harness = await createHarness({ fetchImpl: upstream.fetchImpl });

    try {
      const { token, connectionId, keyId } = seedCompletedRun(harness);
      const listed = await fileRequest(harness, token);

      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ files: [{ path: "generated/cafe.png", kind: "image" }] });

      const runningId = "aaaaaaaaaaaaaaaa";
      harness.store.insertRun({
        runId: runningId,
        connectionId,
        keyId,
        status: "running",
        sessionUrl: SESSION_URL,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const running = await harness.app.request(`/v1/runs/${runningId}/files`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(running.status).toBe(409);
      expect(await running.json()).toEqual({ error: "run_not_completed" });
    } finally {
      harness.cleanup();
    }
  });

  test("cwd を前置した root 相対で stat し、範囲付きの画像を返す", async () => {
    const upstream = createFilesUpstream({
      raw: (_path, range) =>
        new Response(new Uint8Array([0, 1, 2, 3]), {
          status: range ? 206 : 200,
          headers: {
            "Content-Length": "4",
            "Content-Range": "bytes 0-3/8",
            "Accept-Ranges": "bytes",
            "Content-Type": "image/png",
          },
        }),
    });
    const harness = await createHarness({ fetchImpl: upstream.fetchImpl });

    try {
      const { token } = seedCompletedRun(harness);
      const response = await harness.app.request(`/v1/runs/${RUN_ID}/files?path=generated%2Fcafe.png`, {
        headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-3" },
      });
      const imageCall = upstream.calls.find((call) => call.url.includes("/api/files/raw"));

      expect(response.status).toBe(206);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toContain("attachment");
      expect(response.headers.get("content-range")).toBe("bytes 0-3/8");
      expect(response.headers.get("content-length")).toBe("4");
      expect(imageCall?.path).toBe("projects/app/generated/cafe.png");
      expect(imageCall?.range).toBe("bytes=0-3");
      expect(await response.arrayBuffer()).toHaveLength(4);
    } finally {
      harness.cleanup();
    }
  });

  test("画像以外は download を使い、Range を渡さない", async () => {
    const upstream = createFilesUpstream({
      stat: () => ({ status: 200, path: "projects/app/demo.html" }),
    });
    const harness = await createHarness({ fetchImpl: upstream.fetchImpl });

    try {
      const { token } = seedCompletedRun(harness);
      const response = await fileRequest(harness, token, "?path=demo.html");
      const downloadCall = upstream.calls.find((call) => call.url.includes("/api/files/download"));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toContain("demo.html");
      expect(downloadCall?.range).toBeNull();
      expect(await response.text()).toBe("<h1>hi</h1>");
    } finally {
      harness.cleanup();
    }
  });

  test("Content-Encoding がある応答では Content-Length を引き継がない", async () => {
    const upstream = createFilesUpstream({
      stat: () => ({ status: 200, path: "projects/app/demo.html" }),
      download: () =>
        new Response("<h1>hi</h1>", {
          status: 200,
          headers: { "Content-Encoding": "gzip", "Content-Length": "10", "Content-Type": "text/html" },
        }),
    });
    const harness = await createHarness({ fetchImpl: upstream.fetchImpl });

    try {
      const { token } = seedCompletedRun(harness);
      const response = await fileRequest(harness, token, "?path=demo.html");
      const downloadCall = upstream.calls.find((call) => call.url.includes("/api/files/download"));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(downloadCall?.acceptEncoding).toBe("identity");
      expect(await response.text()).toBe("<h1>hi</h1>");
    } finally {
      harness.cleanup();
    }
  });

  test("cwd に空白を含んでもダウンロードできる", async () => {
    const cwd = "projects/my app";
    const upstream = createFilesUpstream({
      cwd,
      stat: (path) => ({ status: 200, path }),
    });
    const harness = await createHarness({ fetchImpl: upstream.fetchImpl });

    try {
      const { token } = seedCompletedRun(harness);
      const response = await fileRequest(harness, token, "?path=generated%2Fcafe.png");
      const statCall = upstream.calls.find((call) => call.url.includes("/api/files/stat"));

      expect(response.status).toBe(200);
      expect(statCall?.path).toBe(`${cwd}/generated/cafe.png`);
      expect(await response.arrayBuffer()).toHaveLength(3);
    } finally {
      harness.cleanup();
    }
  });

  test("cwd の外を指す realpath は 400、root の cwd は 403", async () => {
    const outside = createFilesUpstream({ stat: () => ({ status: 200, path: "projects/other/x.png" }) });
    const outsideHarness = await createHarness({ fetchImpl: outside.fetchImpl });

    try {
      const { token } = seedCompletedRun(outsideHarness);
      const response = await fileRequest(outsideHarness, token, "?path=generated%2Fx.png");

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_path" });
    } finally {
      outsideHarness.cleanup();
    }

    const root = createFilesUpstream({ cwd: "" });
    const rootHarness = await createHarness({ fetchImpl: root.fetchImpl });

    try {
      const { token } = seedCompletedRun(rootHarness);
      const response = await fileRequest(rootHarness, token, "?path=generated%2Fx.png");

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "file_scope_unavailable" });
    } finally {
      rootHarness.cleanup();
    }
  });

  test("path の不正・重複クエリ・対象外の拡張子を拒否する", async () => {
    const upstream = createFilesUpstream({ stat: () => ({ status: 200, path: "projects/app/icon.svg" }) });
    const harness = await createHarness({ fetchImpl: upstream.fetchImpl });

    try {
      const { token } = seedCompletedRun(harness);

      for (const query of ["?path=", "?path=../x.png", "?path=a.png&path=b.png"]) {
        const response = await fileRequest(harness, token, query);

        expect(response.status).toBe(400);
      }

      const svg = await fileRequest(harness, token, "?path=icon.svg");

      expect(svg.status).toBe(415);
      expect(await svg.json()).toEqual({ error: "not_downloadable" });
    } finally {
      harness.cleanup();
    }
  });

  test("上流の 400 / 404 / 413 / 416 / 502 / 503 / 504 を写像する", async () => {
    const notFound = createFilesUpstream({ stat: () => ({ status: 404 }) });
    const notFoundHarness = await createHarness({ fetchImpl: notFound.fetchImpl });

    try {
      const { token } = seedCompletedRun(notFoundHarness);
      const response = await fileRequest(notFoundHarness, token, "?path=missing.png");

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "file_not_found" });
    } finally {
      notFoundHarness.cleanup();
    }

    const tooLarge = createFilesUpstream({
      raw: () => new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Length": "100" } }),
    });
    const tooLargeHarness = await createHarness({
      fetchImpl: tooLarge.fetchImpl,
      filesOptions: { maxBytes: 10 },
    });

    try {
      const { token } = seedCompletedRun(tooLargeHarness);
      const response = await fileRequest(tooLargeHarness, token, "?path=generated%2Fcafe.png");

      expect(response.status).toBe(413);
    } finally {
      tooLargeHarness.cleanup();
    }

    const range = createFilesUpstream({
      raw: () =>
        new Response(JSON.stringify({ error: "range" }), {
          status: 416,
          headers: { "Content-Range": "bytes */8", "Accept-Ranges": "bytes", "Content-Length": "16" },
        }),
    });
    const rangeHarness = await createHarness({ fetchImpl: range.fetchImpl });

    try {
      const { token } = seedCompletedRun(rangeHarness);
      const response = await fileRequest(rangeHarness, token, "?path=generated%2Fcafe.png");

      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */8");
      expect(response.headers.get("content-length")).toBe(
        String(new TextEncoder().encode(JSON.stringify({ error: "range_not_satisfiable" })).byteLength),
      );
      expect(await response.json()).toEqual({ error: "range_not_satisfiable" });
    } finally {
      rangeHarness.cleanup();
    }

    const unavailable = createFilesUpstream({ stat: () => ({ status: 503 }) });
    const unavailableHarness = await createHarness({ fetchImpl: unavailable.fetchImpl });

    try {
      const { token } = seedCompletedRun(unavailableHarness);
      const response = await fileRequest(unavailableHarness, token, "?path=generated%2Fcafe.png");

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "upstream_unavailable" });
    } finally {
      unavailableHarness.cleanup();
    }

    const badPath = createFilesUpstream({ stat: () => ({ status: 400 }) });
    const badPathHarness = await createHarness({ fetchImpl: badPath.fetchImpl });

    try {
      const { token } = seedCompletedRun(badPathHarness);
      const response = await fileRequest(badPathHarness, token, "?path=generated%2Fcafe.png");

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_path" });
    } finally {
      badPathHarness.cleanup();
    }

    const badGateway = createFilesUpstream({
      raw: () => new Response("upstream", { status: 502 }),
    });
    const badGatewayHarness = await createHarness({ fetchImpl: badGateway.fetchImpl });

    try {
      const { token } = seedCompletedRun(badGatewayHarness);
      const response = await fileRequest(badGatewayHarness, token, "?path=generated%2Fcafe.png");

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "upstream_unavailable" });
    } finally {
      badGatewayHarness.cleanup();
    }

    const rawTimeout = createFilesUpstream({
      raw: () => new Response("upstream", { status: 504 }),
    });
    const rawTimeoutHarness = await createHarness({ fetchImpl: rawTimeout.fetchImpl });

    try {
      const { token } = seedCompletedRun(rawTimeoutHarness);
      const response = await fileRequest(rawTimeoutHarness, token, "?path=generated%2Fcafe.png");

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "upstream_timeout" });
    } finally {
      rawTimeoutHarness.cleanup();
    }

    const statTimeout = createFilesUpstream({ stat: () => ({ status: 504 }) });
    const statTimeoutHarness = await createHarness({ fetchImpl: statTimeout.fetchImpl });

    try {
      const { token } = seedCompletedRun(statTimeoutHarness);
      const response = await fileRequest(statTimeoutHarness, token, "?path=generated%2Fcafe.png");

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "upstream_timeout" });
    } finally {
      statTimeoutHarness.cleanup();
    }
  });

  test("他のキーは run を見られない", async () => {
    const upstream = createFilesUpstream();
    const harness = await createHarness({ fetchImpl: upstream.fetchImpl });

    try {
      const { connectionId } = seedCompletedRun(harness);
      const other = harness.keys.create({ name: "別キー", connectionId });
      const response = await fileRequest(harness, other.token);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "run_not_found" });
    } finally {
      harness.cleanup();
    }
  });

  test("同時ダウンロードは接続先ごとに制限する", async () => {
    let releaseBody!: () => void;
    const gate = new Promise<void>((resolve) => (releaseBody = resolve));
    const upstream = createFilesUpstream({
      raw: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await gate;
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Length": "1" } },
        ),
    });
    const harness = await createHarness({ fetchImpl: upstream.fetchImpl, filesOptions: { maxConcurrent: 1 } });

    try {
      const { token } = seedCompletedRun(harness);
      const first = await fileRequest(harness, token, "?path=generated%2Fcafe.png");
      const second = await fileRequest(harness, token, "?path=generated%2Fcafe.png");

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "too_many_downloads" });

      await first.body?.cancel();
      releaseBody();

      const third = await fileRequest(harness, token, "?path=generated%2Fcafe.png");

      expect(third.status).toBe(200);
      await third.body?.cancel();
    } finally {
      harness.cleanup();
    }
  });
});
