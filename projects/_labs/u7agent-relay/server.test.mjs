import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { configFromEnv, createRelay } from "./server.mjs";

const SESSION_ID = "0123456789";
const SPACE_ID = "space-0123456789abcdef";
const RUN_ID = "1234567890abcdef";
const OTHER_RUN = "abcdef0123456789";
const TOKEN = "a".repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const env = {
  U7AGENT_SESSION_URL: `https://agent.example.com/s/${SESSION_ID}?space=${SPACE_ID}`,
  U7AGENT_RELAY_TOKEN: TOKEN,
};

async function listen(t, relay) {
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => new Promise((resolve) => relay.close(resolve)));
  return `http://127.0.0.1:${relay.address().port}`;
}

async function fixture(t) {
  const config = configFromEnv(env);
  const stub = {
    calls: [],
    session: { sessionId: SESSION_ID, spaceId: SPACE_ID, status: "idle", queueDepth: 0 },
    accepted: { sessionId: SESSION_ID, queued: false, runId: RUN_ID },
  };
  const relay = createRelay(config, async (url, options) => {
    stub.calls.push({ url: String(url), ...options });
    if (options.method === "POST") {
      await stub.beforePost?.();
      return Response.json(stub.accepted, { status: 202 });
    }
    return Response.json(stub.session);
  });
  return { base: await listen(t, relay), stub };
}

function post(base, body = { text: "ping" }, auth = AUTH, path = "/messages") {
  return fetch(base + path, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function reply(base, runId = RUN_ID) {
  return fetch(`${base}/replies/${runId}`, { headers: AUTH });
}

test("health-only mode returns a fixed health response and never talks to an upstream", async (t) => {
  const base = await listen(t, createRelay(null, () => assert.fail("upstream called")));
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/plain/);
  assert.equal(await response.text(), "u7agent-relay-ok\n");
  assert.equal((await post(base)).status, 404);
  assert.equal((await reply(base)).status, 404);
});

test("relay mode requires a session URL and a sufficiently long bearer token", () => {
  assert.throws(() => configFromEnv({}), /U7AGENT_SESSION_URL/);
  assert.throws(() => configFromEnv({ ...env, U7AGENT_RELAY_TOKEN: "short" }), /U7AGENT_RELAY_TOKEN/);
  assert.throws(() => configFromEnv({ ...env, U7AGENT_SESSION_URL: env.U7AGENT_SESSION_URL.replace("https:", "http:") }), /HTTPS/);
});

test("only authorized, well-formed requests to the two relay routes can reach u7agent", async (t) => {
  const { base, stub } = await fixture(t);
  assert.equal((await post(base, { text: "ping" }, {})).status, 401);
  assert.equal((await fetch(`${base}/replies/${RUN_ID}`)).status, 401);
  assert.equal((await fetch(`${base}/api/sessions`, { headers: AUTH })).status, 404);
  assert.equal((await post(base, { text: "ping" }, AUTH, "/messages?spaceId=default")).status, 404);
  assert.equal((await post(base, { text: "ping", sessionId: "other" })).status, 400);
  assert.equal((await post(base, { text: " " })).status, 400);
  assert.equal((await post(base, { text: "x".repeat(70_000) })).status, 413);
  assert.equal((await reply(base)).status, 404);
  assert.deepEqual(stub.calls, []);
});

test("a post targets only the configured session, and a reply contains only its final text", async (t) => {
  const { base, stub } = await fixture(t);
  const accepted = await post(base, { text: "  ping  " });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { runId: RUN_ID });
  assert.deepEqual(stub.calls.map(({ method, url, body }) => [method, url, body]), [
    ["GET", `https://agent.example.com/api/sessions/${SESSION_ID}?spaceId=${SPACE_ID}`, undefined],
    ["POST", `https://agent.example.com/api/sessions/${SESSION_ID}/messages?spaceId=${SPACE_ID}`, '{"text":"ping"}'],
  ]);
  assert.ok(stub.calls.every(({ headers, redirect }) => !headers.Authorization && redirect === "error"));

  stub.session.status = "running";
  stub.session.run = { id: RUN_ID, status: "running", toolCalls: [] };
  assert.deepEqual(await (await reply(base)).json(), { status: "running" });
  stub.session.run.toolCalls.push({ done: false, questions: [{ question: "not relayed" }] });
  assert.deepEqual(await (await reply(base)).json(), {
    status: "awaiting_answer",
    sessionUrl: env.U7AGENT_SESSION_URL,
  });

  stub.session.status = "completed";
  stub.session.run.status = "completed";
  stub.session.messages = [
    { role: "assistant", assistantId: `${RUN_ID}:1`, text: "earlier" },
    { role: "assistant", assistantId: `${RUN_ID}:2`, text: "final reply", tools: [{ output: "not relayed" }] },
    { role: "assistant", assistantId: `${OTHER_RUN}:1`, text: "other run" },
  ];
  assert.deepEqual(await (await reply(base)).json(), { status: "completed", text: "final reply" });
  assert.equal((await reply(base, OTHER_RUN)).status, 404);
  stub.session.run.id = OTHER_RUN;
  assert.equal((await reply(base)).status, 404);
});

test("a busy session and a mismatched space cannot receive a post", async (t) => {
  const { base, stub } = await fixture(t);
  stub.session.status = "running";
  assert.equal((await post(base)).status, 409);
  stub.session.status = "idle";
  stub.session.spaceId = "default";
  assert.equal((await post(base)).status, 502);
  assert.deepEqual(stub.calls.map(({ method }) => method), ["GET", "GET"]);
});

test("overlapping relay submissions do not send a second post", async (t) => {
  const { base, stub } = await fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  stub.beforePost = async () => {
    started.resolve();
    await release.promise;
  };
  const first = post(base);
  try {
    await Promise.race([started.promise, first.then(() => assert.fail("post was not sent upstream"))]);
    assert.equal((await post(base)).status, 409);
  } finally {
    release.resolve();
  }
  assert.equal((await first).status, 202);
  assert.deepEqual(stub.calls.map(({ method }) => method), ["GET", "POST"]);
});

test("a post accepted into the upstream queue is not reported as a trackable run", async (t) => {
  const { base, stub } = await fixture(t);
  stub.accepted = { sessionId: SESSION_ID, queued: true, sendId: "ignored" };
  const response = await post(base);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "queued", sessionUrl: env.U7AGENT_SESSION_URL });
  assert.equal((await reply(base)).status, 404);
});
