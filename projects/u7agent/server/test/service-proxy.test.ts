import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { createServiceProxy, rewriteLocation } from "../src/service-proxy";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** 上流 (サンドボックスの 8080 で待つアプリ) を立てる。実ポートはカーネルに任せる */
async function startUpstream(handler: Handler) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("上流のポートを解決できません");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("メソッド / パス / クエリ / ボディを透過する", async () => {
  const seen: { method?: string; url?: string; body?: string } = {};
  const upstream = await startUpstream(async (req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.body = await readBody(req);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const res = await proxy.request("http://service.test/items?x=1&y=%2F", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(seen, { method: "POST", url: "/items?x=1&y=%2F", body: "hello" });
  } finally {
    await upstream.close();
  }
});

test("上流の Cache-Control / Expires を落として no-store に揃える", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, {
      "cache-control": "public, max-age=600",
      expires: "Wed, 21 Oct 2026 07:28:00 GMT",
    });
    res.end("body");
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const res = await proxy.request("http://service.test/");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("expires"), null);
    assert.equal(await res.text(), "body");
  } finally {
    await upstream.close();
  }
});

test("上流がキャッシュ ヘッダを返さなくても no-store を付ける", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200);
    res.end("body");
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const res = await proxy.request("http://service.test/");
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    await upstream.close();
  }
});

test("GET / HEAD の再検証ヘッダだけを落とし、書き込みの前提条件は透過する", async () => {
  const seen: { method?: string; ifNoneMatch?: string; ifModifiedSince?: string } = {};
  const upstream = await startUpstream(async (req, res) => {
    seen.method = req.method;
    seen.ifNoneMatch = req.headers["if-none-match"] as string | undefined;
    seen.ifModifiedSince = req.headers["if-modified-since"] as string | undefined;
    await readBody(req);
    res.writeHead(200);
    res.end("ok");
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  const validators = {
    "if-none-match": 'W/"v1"',
    "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
  };
  try {
    await (await proxy.request("http://service.test/", { headers: validators })).text();
    assert.equal(seen.method, "GET");
    assert.equal(seen.ifNoneMatch, undefined);
    assert.equal(seen.ifModifiedSince, undefined);

    // Last-Modified が同じでも 304 を成立させない (ブラウザは古い本文を持っている)
    await (await proxy.request("http://service.test/", { method: "HEAD", headers: validators })).text();
    assert.equal(seen.method, "HEAD");
    assert.equal(seen.ifNoneMatch, undefined);
    assert.equal(seen.ifModifiedSince, undefined);

    await (
      await proxy.request("http://service.test/save", { method: "POST", headers: { "if-none-match": "*" }, body: "x" })
    ).text();
    assert.equal(seen.method, "POST");
    assert.equal(seen.ifNoneMatch, "*");
  } finally {
    await upstream.close();
  }
});

test("内部ホストを指す Location をブラウザから見たオリジンへ直す", async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.url === "/external") {
      res.writeHead(302, { location: "https://example.com/keep" });
    } else {
      res.writeHead(302, { location: "http://127.0.0.1:8080/dash?q=1#frag" });
    }
    res.end();
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const internal = await proxy.request("http://lan:8016/start");
    assert.equal(internal.status, 302);
    assert.equal(internal.headers.get("location"), "http://lan:8016/dash?q=1#frag");

    const external = await proxy.request("http://lan:8016/external");
    assert.equal(external.headers.get("location"), "https://example.com/keep");
  } finally {
    await upstream.close();
  }
});

test("rewriteLocation は内部ホスト (サンドボックス名 / ループバック) だけを書き換える", () => {
  assert.equal(
    rewriteLocation("http://u7agent-sandbox:8080/a?b=1", "http://lan:8016", "u7agent-sandbox"),
    "http://lan:8016/a?b=1",
  );
  assert.equal(rewriteLocation("//127.0.0.1:8080/a", "http://lan:8016", undefined), "http://lan:8016/a");
  assert.equal(rewriteLocation("http://[::1]:8080/a", "http://lan:8016", undefined), "http://lan:8016/a");
  assert.equal(rewriteLocation("/relative", "http://lan:8016", undefined), "/relative");
  assert.equal(rewriteLocation("https://example.com/a", "http://lan:8016", "u7agent-sandbox"), "https://example.com/a");
});

test("Range と Content-Encoding をそのまま透過する", async () => {
  const payload = Buffer.from("0123456789");
  const upstream = await startUpstream((req, res) => {
    if (req.headers.range === "bytes=0-4") {
      res.writeHead(206, { "content-range": "bytes 0-4/10", "content-length": "5" });
      res.end(payload.subarray(0, 5));
      return;
    }
    res.writeHead(200, { "content-encoding": "gzip", "content-length": String(payload.length) });
    res.end(payload);
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const ranged = await proxy.request("http://service.test/file", { headers: { range: "bytes=0-4" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 0-4/10");
    assert.equal(await ranged.text(), "01234");

    // BFF 側で復号すると、Content-Encoding / Content-Length と本文が食い違う
    const encoded = await proxy.request("http://service.test/file");
    assert.equal(encoded.headers.get("content-encoding"), "gzip");
    assert.equal(Buffer.from(await encoded.arrayBuffer()).toString("utf8"), "0123456789");
  } finally {
    await upstream.close();
  }
});

test("本文を持てない 205 でも空ボディで返し、プロセスを落とさない", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(205);
    res.end();
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const res = await proxy.request("http://service.test/reset", { method: "POST", body: "x" });
    assert.equal(res.status, 205);
    assert.equal(await res.text(), "");
  } finally {
    await upstream.close();
  }
});

test("上流の応答をバッファせずストリームで返す", async () => {
  const upstream = await startUpstream(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    // バッファする実装では 1 回目の read がここまで返らない
    await sleep(300);
    res.write("data: 2\n\n");
    res.end();
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const res = await proxy.request("http://service.test/events");
    const reader = res.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(decoder.decode(first.value), "data: 1\n\n");
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value);
    }
    assert.equal(rest, "data: 2\n\n");
  } finally {
    await upstream.close();
  }
});

test("ホップバイホップ ヘッダは上流へ渡さず、応答からも落とす", async () => {
  const seen: Record<string, string | string[] | undefined> = {};
  const upstream = await startUpstream(async (req, res) => {
    seen.connection = req.headers.connection;
    seen.keepAlive = req.headers["keep-alive"];
    seen.te = req.headers.te;
    seen.xHop = req.headers["x-hop"];
    await readBody(req);
    res.setHeader("te", "trailers");
    res.setHeader("keep-alive", "timeout=5");
    res.writeHead(200);
    res.end("ok");
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  try {
    const res = await proxy.request("http://service.test/", {
      headers: { connection: "x-hop", "x-hop": "1", te: "trailers", "keep-alive": "timeout=5" },
    });
    assert.equal(await res.text(), "ok");
    // Node のクライアントが張る Connection: keep-alive は新しい接続の値。元の要求の値と、それが名指したヘッダは渡らない
    assert.notEqual(seen.connection, "x-hop");
    assert.equal(seen.keepAlive, undefined);
    assert.equal(seen.te, undefined);
    assert.equal(seen.xHop, undefined);
    assert.equal(res.headers.get("te"), null);
    assert.equal(res.headers.get("keep-alive"), null);
  } finally {
    await upstream.close();
  }
});

test("上流へ到達できないときは短い 502 を返す", async () => {
  const upstream = await startUpstream((_req, res) => res.end("x"));
  const port = upstream.port;
  await upstream.close();
  const proxy = createServiceProxy({ host: "127.0.0.1", port });
  const res = await proxy.request("http://service.test/");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "サービスに接続できません" });
});

test("転送先が未設定 (PI_SANDBOX_URL なし) のときも 502 を返す", async () => {
  const proxy = createServiceProxy({});
  const res = await proxy.request("http://service.test/");
  assert.equal(res.status, 502);
});

/** app.request ではなく実リスナー越しの経路。Node のサーバが加えるヘッダと混ざっても契約が保たれることを見る */
test("実リスナー経由でも Connection が名指ししたヘッダを落とし、no-store を返す", async () => {
  const seen: Record<string, string | string[] | undefined> = {};
  const upstream = await startUpstream(async (req, res) => {
    seen.connection = req.headers.connection;
    seen.xHop = req.headers["x-hop"];
    await readBody(req);
    res.writeHead(200, { "cache-control": "max-age=600" });
    res.end("ok");
  });
  const proxy = createServiceProxy({ host: "127.0.0.1", port: upstream.port });
  const server = createAdaptorServer({ fetch: proxy.fetch });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("プロキシのポートを解決できません");
  try {
    const response = await new Promise<{ body: string; cacheControl?: string }>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: address.port, path: "/", headers: { Connection: "x-hop", "X-Hop": "1" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ body: Buffer.concat(chunks).toString("utf8"), cacheControl: res.headers["cache-control"] }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.body, "ok");
    assert.equal(response.cacheControl, "no-store");
    assert.notEqual(seen.connection, "x-hop");
    assert.equal(seen.xHop, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await upstream.close();
  }
});
