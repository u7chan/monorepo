/**
 * self-test 用のループバック fixture。HTTP (HTML / 302) と WebSocket の echo を 1 つの port 0 で受ける。
 * 302 は「route が redirect 先で呼ばれない」経路を proxy だけで止められるかの検査に使う。
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const FIXTURE_HTML = `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8"><title>u7agent-browser fixture</title></head>
  <body>
    <div id="probe">loopback-ok</div>
    <p id="label">日本語のラベルと絵文字 🎉🚀</p>
  </body>
</html>
`;

export interface LoopbackFixture {
  origin: string;
  wsUrl: string;
  /** 外部 URL へ 302 を返す入口 (path は `redirects` のキー) */
  redirect(path: string): string;
  close(): Promise<void>;
}

interface WebSocketFrame {
  opcode: number;
  payload: Buffer;
  consumed: number;
}

/** クライアント → サーバーの 1 フレーム。届いていなければ undefined (呼び出し元が次の data を待つ) */
function readFrame(buffer: Buffer): WebSocketFrame | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { opcode, payload, consumed: offset + maskLength + length };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** 送られた本文をそのまま返す。テストで使う短いテキスト 1 フレームだけを想定する */
function echoFrames(socket: Socket): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = readFrame(buffer);
      if (!frame) return;
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) socket.write(encodeFrame(frame.opcode, frame.payload));
    }
  });
  socket.on("error", () => socket.destroy());
}

/** `Host` を信頼せず、実際に待受した loopback のアドレスだけを URL に使う */
function originOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("fixture のポートを取得できません");
  return `http://127.0.0.1:${address.port}`;
}

export async function startLoopbackFixture(
  options: { redirects?: Record<string, string> } = {},
): Promise<LoopbackFixture> {
  const redirects = options.redirects ?? {};
  const server = createServer((req: IncomingMessage, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const target = redirects[path];
    if (target) {
      res.writeHead(302, { location: target, "content-length": 0 });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE_HTML);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    const key = req.headers["sec-websocket-key"];
    if ((req.url ?? "").split("?")[0] !== "/ws" || typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    echoFrames(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = originOf(server);
  return {
    origin,
    wsUrl: origin.replace(/^http/, "ws") + "/ws",
    redirect: (path: string) => `${origin}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
