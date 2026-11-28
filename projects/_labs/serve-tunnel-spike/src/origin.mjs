import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MARKER = "serve-tunnel-spike-origin";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function websocketAccept(key) {
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}

function websocketFrame(text) {
  const payload = Buffer.from(text);
  // この検証のメッセージは 125 バイト未満なので、拡張長は扱わない
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function readWebsocketText(buffer) {
  if (buffer.length < 6) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  const length = buffer[1] & 0x7f;
  if (length >= 126 || !masked || buffer.length < 6 + length) return null;
  const mask = buffer.subarray(2, 6);
  const payload = Buffer.from(buffer.subarray(6, 6 + length));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, text: payload.toString("utf8") };
}

export async function startOrigin(port = 0) {
  const stats = { total: 0, inFlight: 0, peakInFlight: 0, websocketUpgrades: 0 };
  const server = createServer(async (req, res) => {
    stats.total += 1;
    stats.inFlight += 1;
    stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
    res.on("close", () => {
      stats.inFlight -= 1;
    });

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/echo") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          marker: MARKER,
          path: url.pathname,
          headers: req.headers,
          remoteAddress: req.socket.remoteAddress,
        }),
      );
      return;
    }

    if (url.pathname === "/stats") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(stats));
      return;
    }

    if (url.pathname === "/hold") {
      await sleep(Number(url.searchParams.get("ms") ?? 1000));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`held ${url.searchParams.get("ms") ?? 1000}ms\n`);
      return;
    }

    if (url.pathname === "/sse") {
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      for (let i = 0; i < 6; i++) {
        if (closed) return;
        res.write(`id: ${i}\ndata: ${Date.now()}\n\n`);
        await sleep(400);
      }
      res.end();
      return;
    }

    if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(1024 * 1024, 0x61));
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><title>${MARKER}</title><h1>${MARKER}</h1>`);
  });

  server.on("upgrade", (req, socket) => {
    stats.websocketUpgrades += 1;
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
        "",
        "",
      ].join("\r\n"),
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const frame = readWebsocketText(pending);
      if (!frame) return;
      pending = Buffer.alloc(0);
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x1) socket.write(websocketFrame(frame.text));
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    port: server.address().port,
    stats,
    resetStats() {
      stats.total = 0;
      stats.inFlight = 0;
      stats.peakInFlight = 0;
      stats.websocketUpgrades = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = await startOrigin(Number(process.argv[2] ?? 0));
  console.log(`origin: http://127.0.0.1:${origin.port}/`);
}
