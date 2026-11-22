import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const RUN_ID = /^[0-9a-f]{16}$/;
const REPLY_PATH = /^\/replies\/([0-9a-f]{16})$/;
const IDLE_STATUSES = new Set(["idle", "completed", "stopped", "error"]);
const MAX_BODY_BYTES = 64 * 1024;

class RelayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

export function configFromEnv(env) {
  const url = URL.parse(env.U7AGENT_SESSION_URL ?? "");
  const sessionId = /^\/s\/([0-9a-f]{10})$/.exec(url?.pathname ?? "")?.[1];
  const spaceId = url?.searchParams.get("space") ?? "default";
  if (
    url?.protocol !== "https:" || url.username || url.password || !sessionId ||
    !/^(default|space-[0-9a-f]{16})$/.test(spaceId)
  ) {
    throw new Error("U7AGENT_SESSION_URL must be an HTTPS u7agent conversation URL");
  }
  const token = env.U7AGENT_RELAY_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error("U7AGENT_RELAY_TOKEN must have at least 32 URL-safe characters");
  }
  const sessionPath = `/api/sessions/${sessionId}`;
  const sessionApi = new URL(`${sessionPath}?spaceId=${spaceId}`, url.origin);
  const messagesApi = new URL(`${sessionPath}/messages?spaceId=${spaceId}`, url.origin);
  const sessionUrl = new URL(`/s/${sessionId}?space=${spaceId}`, url.origin).href;
  return { token, sessionId, spaceId, sessionUrl, sessionApi, messagesApi };
}

function send(res, status, body) {
  const plainText = typeof body === "string";
  res.writeHead(status, {
    "Content-Type": plainText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(plainText ? body : JSON.stringify(body));
}

async function readMessage(req) {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RelayError(415, "json_required");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new RelayError(413, "message_too_large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new RelayError(400, "invalid_json");
  }
  if (!body || Object.keys(body).length !== 1 || typeof body.text !== "string" || !body.text.trim()) {
    throw new RelayError(400, "text_required");
  }
  const text = body.text.trim();
  if (text.length > 20_000) throw new RelayError(413, "message_too_large");
  return text;
}

export function createRelay(config = null, upstreamFetch = fetch) {
  const bearer = config && Buffer.from(`Bearer ${config.token}`);
  let submitting = false;
  let latestRunId;

  async function requestUpstream(url, text) {
    const posting = text !== undefined;
    const signal = AbortSignal.timeout(8_000);
    try {
      const response = await upstreamFetch(url, {
        method: posting ? "POST" : "GET",
        headers: posting
          ? { Accept: "application/json", "Content-Type": "application/json" }
          : { Accept: "application/json" },
        body: posting ? JSON.stringify({ text }) : undefined,
        redirect: "error",
        signal,
      });
      if (response.status !== (posting ? 202 : 200)) {
        void response.body?.cancel().catch(() => {});
        throw new RelayError(502, "upstream_rejected");
      }
      const result = await response.json();
      if (result?.sessionId !== config.sessionId) throw new RelayError(502, "upstream_mismatch");
      return result;
    } catch (error) {
      if (error instanceof RelayError) throw error;
      if (signal.aborted) throw new RelayError(504, "upstream_timeout");
      throw new RelayError(502, "upstream_unavailable");
    }
  }

  async function getSession() {
    const session = await requestUpstream(config.sessionApi);
    if (session.spaceId !== config.spaceId) throw new RelayError(502, "upstream_mismatch");
    return session;
  }

  async function postMessage(req) {
    const text = await readMessage(req);
    if (submitting) throw new RelayError(409, "session_busy");
    submitting = true;
    try {
      const session = await getSession();
      if (!IDLE_STATUSES.has(session.status) || session.queueDepth !== 0) {
        throw new RelayError(409, "session_busy");
      }
      const accepted = await requestUpstream(config.messagesApi, text);
      latestRunId = undefined;
      if (accepted.queued === true) return { status: "queued", sessionUrl: config.sessionUrl };
      if (accepted.queued !== false || typeof accepted.runId !== "string" || !RUN_ID.test(accepted.runId)) {
        throw new RelayError(502, "upstream_reply_invalid");
      }
      latestRunId = accepted.runId;
      return { runId: latestRunId };
    } finally {
      submitting = false;
    }
  }

  async function getReply(runId) {
    if (runId !== latestRunId) throw new RelayError(404, "run_not_found");
    const { run, messages } = await getSession();
    if (run?.id !== runId || runId !== latestRunId) throw new RelayError(404, "run_not_found");
    switch (run.status) {
      case "running": {
        const waiting = run.toolCalls?.some((tool) =>
          tool.done === false && tool.questions?.length > 0 && tool.answers === undefined
        );
        return waiting ? { status: "awaiting_answer", sessionUrl: config.sessionUrl } : { status: "running" };
      }
      case "completed": {
        const reply = messages.findLast((msg) =>
          msg.role === "assistant" && msg.assistantId?.startsWith(`${runId}:`) && msg.text?.trim()
        );
        return { status: "completed", text: reply?.text ?? "" };
      }
      case "stopped":
      case "error":
        return { status: run.status };
      default:
        throw new RelayError(502, "upstream_reply_invalid");
    }
  }

  async function handle(req, res) {
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, "u7agent-relay-ok\n");
    const posting = req.method === "POST" && req.url === "/messages";
    const runId = req.method === "GET" ? REPLY_PATH.exec(req.url)?.[1] : undefined;
    if (!bearer || (!posting && !runId)) throw new RelayError(404, "not_found");
    const credential = Buffer.from(req.headers.authorization ?? "");
    if (credential.length !== bearer.length || !timingSafeEqual(credential, bearer)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      throw new RelayError(401, "unauthorized");
    }
    if (posting) return send(res, 202, await postMessage(req));
    return send(res, 200, await getReply(runId));
  }

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.destroyed) return;
      const known = error instanceof RelayError;
      send(res, known ? error.status : 500, { error: known ? error.message : "internal_error" });
    });
  });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const healthOnly = args.length === 1 && args[0] === "--health-only";
    if (args.length && !healthOnly) throw new Error("Usage: node server.mjs [--health-only]");
    const port = Number(process.env.RELAY_PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid RELAY_PORT");
    const server = createRelay(healthOnly ? null : configFromEnv(process.env));
    server.on("error", (error) => {
      console.error(`Unable to start relay: ${error.code ?? "unknown_error"}`);
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Relay listening at http://localhost:${port}${healthOnly ? " (health only)" : ""}`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
