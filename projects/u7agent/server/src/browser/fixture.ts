/**
 * ループバック fixture。HTTP (HTML / 302 / 任意の status) と WebSocket の echo を 1 つの port 0 で受ける。
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

/** fixture が返す 1 つの応答。`hang` は応答も切断もせず、遷移 timeout の検査に使う */
export interface FixtureResponse {
  status?: number;
  contentType?: string;
  body?: string;
  hang?: boolean;
}

/** 応答を組み立てる側で判明する値を渡す (origin / wsUrl は listen しないと決まらない) */
export interface FixtureRequestContext {
  origin: string;
  wsUrl: string;
  path: string;
}

export type FixtureHandler = (context: FixtureRequestContext) => FixtureResponse;

export interface LoopbackFixtureOptions {
  redirects?: Record<string, string>;
  responses?: Record<string, FixtureHandler>;
}

/** `check` の分類を起こす fixture の path。入力 (ページ) を self-test とテストで同じにする */
export const CHECK_FIXTURE_PATHS = {
  status404: "/check/status-404",
  status500: "/check/status-500",
  pageerror: "/check/pageerror",
  requestFailed: "/check/request-failed",
  iconWarning: "/check/icon-warning",
  icon: "/check/favicon.svg",
  late: "/check/late",
  webSocket: "/check/ws",
  hang: "/check/hang",
} as const;

function htmlPage(body: string): string {
  return `<!doctype html>\n<html lang="ja">\n  <head><meta charset="utf-8"><title>check fixture</title></head>\n  <body>${body}</body>\n</html>\n`;
}

/**
 * 分類ごとに 1 つだけ error を起こすページ一式。requestfailed は閉じたポートへの script で起こす。
 * favicon は headless では要求されないため、明示的に読ませて 404 を警告へ分類できるか見る。
 */
export function checkFixtureResponses(closedPort: number): Record<string, FixtureHandler> {
  return {
    [CHECK_FIXTURE_PATHS.status404]: () => ({ status: 404, body: htmlPage("<p>404</p>") }),
    [CHECK_FIXTURE_PATHS.status500]: () => ({ status: 500, body: htmlPage("<p>500</p>") }),
    [CHECK_FIXTURE_PATHS.pageerror]: () => ({
      body: htmlPage('<script>throw new Error("fixture-pageerror");</script>'),
    }),
    [CHECK_FIXTURE_PATHS.requestFailed]: () => ({
      body: htmlPage(`<script src="http://127.0.0.1:${closedPort}/missing.js"></script>`),
    }),
    [CHECK_FIXTURE_PATHS.iconWarning]: () => ({ body: htmlPage(`<img src="${CHECK_FIXTURE_PATHS.icon}">`) }),
    [CHECK_FIXTURE_PATHS.icon]: () => ({ status: 404, contentType: "image/svg+xml" }),
    [CHECK_FIXTURE_PATHS.late]: () => ({
      body: htmlPage(
        '<div id="late">waiting</div><script>setTimeout(() => { document.getElementById("late").textContent = "rendered"; throw new Error("fixture-late"); }, 100)</script>',
      ),
    }),
    [CHECK_FIXTURE_PATHS.webSocket]: ({ wsUrl }) => ({
      body: htmlPage(
        `<script>\n  const socket = new WebSocket(${JSON.stringify(wsUrl)});\n  socket.onopen = () => socket.send("ping");\n  socket.onmessage = () => {\n    const ok = document.createElement("div");\n    ok.id = "ws-ok";\n    ok.textContent = "echoed";\n    document.body.append(ok);\n  };\n</script>`,
      ),
    }),
    // 応答を返さない。遷移の timeout を検証失敗として分類できるか見る
    [CHECK_FIXTURE_PATHS.hang]: () => ({ hang: true }),
  };
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

/** 一度 bind してから閉じた loopback のポート。接続が必ず失敗する宛先を作る (requestfailed の検査用) */
export async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("閉じたポートを取得できません");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function startLoopbackFixture(options: LoopbackFixtureOptions = {}): Promise<LoopbackFixture> {
  const redirects = options.redirects ?? {};
  const responses = options.responses ?? {};
  let requestContext: Omit<FixtureRequestContext, "path"> | undefined;
  const server = createServer((req: IncomingMessage, res) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    const target = redirects[path];
    if (target) {
      res.writeHead(302, { location: target, "content-length": 0 });
      res.end();
      return;
    }
    const handler = responses[path];
    const response =
      handler === undefined || requestContext === undefined ? undefined : handler({ ...requestContext, path });
    // 応答も end もしない。close() の closeAllConnections で切れるまで接続を保持する
    if (response?.hang) return;
    res.writeHead(response?.status ?? 200, { "content-type": response?.contentType ?? "text/html; charset=utf-8" });
    res.end(response?.body ?? FIXTURE_HTML);
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
  const wsUrl = origin.replace(/^http/, "ws") + "/ws";
  requestContext = { origin, wsUrl };
  return {
    origin,
    wsUrl,
    redirect: (path: string) => `${origin}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
