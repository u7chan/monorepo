/**
 * deny-all proxy。標準経路の本命の境界で、ブラウザのネットワーク層で非ループバックの通信を止める。
 * route は redirect 先で呼ばれないため、これが無いと link-local などへ抜けられる (docs/sandbox.md#配布イメージと起動契約)。
 * ループバックは `--proxy-bypass-list` で明示的にバイパスさせるので、この proxy には到達しない。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface DenyAllProxy {
  /** ブラウザへ渡す `--proxy-server` の値 */
  server: string;
  port: number;
  close(): Promise<void>;
}

const BLOCKED_BODY = "u7agent-browser: ループバック以外への通信は拒否します\n";

function refuseSocket(socket: Socket, onDeny: (target: string) => void, target: string): void {
  onDeny(target);
  socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

/**
 * 127.0.0.1 の一時ポート (port 0) で待受する。ポートを固定しないのは、同時実行の別の呼び出しと
 * 衝突させないため (設計は docs/sandbox.md の serve と同じ「実割当ポートを使う」方針)。
 */
export async function startDenyAllProxy(options: { onDeny?: (target: string) => void } = {}): Promise<DenyAllProxy> {
  const onDeny = options.onDeny ?? (() => {});
  const denyRequest = (req: IncomingMessage, res: ServerResponse): void => {
    onDeny(req.url ?? "");
    res.writeHead(403, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(BLOCKED_BODY),
    });
    res.end(BLOCKED_BODY);
  };
  const server = createServer(denyRequest);
  // CONNECT (https / wss) と Upgrade (ws) は HTTP のリクエストとして来ないため、別々に受ける
  server.on("connect", (req: IncomingMessage, socket: Socket) => refuseSocket(socket, onDeny, req.url ?? ""));
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => refuseSocket(socket, onDeny, req.url ?? ""));
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("deny-all proxy のポートを取得できません");
  return {
    server: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
