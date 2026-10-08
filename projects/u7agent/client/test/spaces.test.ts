import assert from "node:assert/strict";
import test from "node:test";
import { readSpaceSelection, selectedSpace, writeSpaceSelection, SPACE_SELECTION_KEY } from "../src/lib/spaceSelection";
import { createSessionCreation } from "../src/hooks/sessionCreation";
import { sendChatMessage, type SendChatMessageDeps } from "../src/hooks/sessionActions";
import { createRequestGate } from "../src/hooks/requestGate";
import type { ChatAction } from "../src/hooks/chatReducer";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { createSpaceApi, getCatalog, getFiles, listSpaces, createSpace } = await import("../src/api");
const normal = { id: "default", name: "通常", createdAt: 0 };
const demo = { id: "space-1111111111111111", name: "デモ", createdAt: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("選択欠落だけ通常を選び、不正・未知の保存値や未取得一覧は通常へ戻さない", () => {
  assert.equal(selectedSpace([normal, demo], null), normal);
  assert.equal(selectedSpace([normal, demo], demo.id), demo);
  for (const value of ["", "../bad", "unknown"]) assert.equal(selectedSpace([normal, demo], value), undefined);
  assert.equal(selectedSpace([], null), undefined);
  assert.throws(
    () =>
      readSpaceSelection({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    /blocked/,
  );
});

test("選択はタブ固有のストレージへ保存し、他タブの変更やリロードと混ざらない", () => {
  const tab = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      data,
    };
  };
  const a = tab();
  const b = tab();
  writeSpaceSelection(a, demo.id);
  writeSpaceSelection(b, normal.id);
  assert.equal(readSpaceSelection(a), demo.id);
  assert.equal(readSpaceSelection(b), normal.id);
  assert.equal(a.data.get(SPACE_SELECTION_KEY), demo.id);
});

test("会話・プロジェクト・作業環境の全操作へ固定スペースを渡し、共通 API は分割しない", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({});
  });
  const api = createSpaceApi(demo.id);
  const id = "0123456789";
  const scope = { sessionId: id };
  const controller = new AbortController();
  await api.listSessions();
  await api.createSession(undefined, { notify: true });
  await api.getSession(id);
  await api.getSessionHistory(id, { before: "entry/?日本語", limit: 20 });
  await api.deleteSession(id);
  await api.updateSessionSettings(id, { thinkingLevel: "low" });
  await api.updateSessionNotify(id, true);
  await api.updateSessionTitle(id, "名前");
  await api.stopSession(id);
  await api.compactSession(id);
  await api.postMessage(id, "本文");
  await api.resendMessage(id, "run");
  await api.discardUnsentMessage(id, "run");
  await api.answerQuestion(id, "tool", []);
  await api.uploadSessionFile(id, new File(["a"], "日本語.txt"));
  await api.getSessionSkills(id);
  await api.getSessionSkillsPreview({ projectId: "", agentId: "" });
  await api.listProjects();
  await api.createProject({ cwd: "p" });
  await api.deleteProject("p");
  await api.getServeStatus(id, controller.signal);
  await api.startServe({ ...scope, generation: null }, controller.signal);
  await api.stopServe({ ...scope, generation: null });
  await api.getSecrets(scope, controller.signal);
  await api.getSecretDetail(scope, "secret", controller.signal);
  await api.createSecret({ ...scope, kind: "variable", name: "X", value: "v" });
  await api.updateSecret(scope, "secret", "v");
  await api.deleteSecret(scope, "secret");
  assert.equal(requests.length, 28);
  for (const request of requests) assert.equal(new URL(request.url).searchParams.get("spaceId"), demo.id);
  assert.deepEqual(await requests[1].json(), { spaceId: demo.id, notify: true });
  assert.equal(new URL(requests[3].url).searchParams.get("before"), "entry/?日本語");
  assert.equal(new URL(requests[14].url).searchParams.get("name"), "日本語.txt");
  assert.equal(await requests[14].text(), "a");
  assert.ok(requests[20].signal);
  const boundary = requests.length;
  await getCatalog();
  await getFiles();
  await listSpaces();
  await createSpace("別デモ");
  for (const request of requests.slice(boundary)) assert.equal(new URL(request.url).searchParams.has("spaceId"), false);
});

test("作成待ちの送信・添付は切替後も開始元の会話 ID とスペースで続行する", async (t) => {
  const requests: Request[] = [];
  const created = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "POST" && new URL(request.url).pathname === "/api/sessions") return created.promise;
    return Response.json({ queued: false, queueDepth: 0 });
  });
  const originApi = createSpaceApi(demo.id);
  const creation = createSessionCreation<string>();
  const ensureSession = () => creation.start(async () => (await originApi.createSession()).sessionId);
  const actions: ChatAction[] = [];
  const busy: boolean[] = [];
  const deps: SendChatMessageDeps = {
    health: { ready: true },
    busy: false,
    sessionIdRef: { current: "" },
    opsRef: { current: 0 },
    runStatusRef: { current: "idle" },
    runEndSeqRef: { current: 0 },
    ensureSession,
    refreshSessions: async () => [],
    post: originApi.postMessage,
    dispatch: (action) => {
      actions.push(action);
    },
    setSending: (value) => {
      busy.push(value);
    },
    setRuntimeStatus: () => {},
  };
  const sending = sendChatMessage("開始元の下書き", deps);
  const uploading = ensureSession().then((id) => originApi.uploadSessionFile(id, new File(["a"], "a.txt")));
  const destinationApi = createSpaceApi("default");
  await destinationApi.listSessions();
  created.resolve(Response.json({ sessionId: "0123456789" }));
  await Promise.all([sending, uploading]);
  const originRequests = requests.filter((request) => new URL(request.url).searchParams.get("spaceId") === demo.id);
  assert.deepEqual(originRequests.map((request) => new URL(request.url).pathname).sort(), [
    "/api/sessions",
    "/api/sessions/0123456789/files",
    "/api/sessions/0123456789/messages",
  ]);
  assert.equal(originRequests.filter((request) => new URL(request.url).pathname === "/api/sessions").length, 1);
  assert.deepEqual(actions, []);
  assert.deepEqual(busy, [true, false]);
});

test("旧スペース一覧の遅い応答を破棄し、切替先の一覧と fallback 候補を保つ", async () => {
  const pending = deferred<string[]>();
  const begin = createRequestGate();
  let originMounted = true;
  let visible = ["destination-session"];
  const canApply = begin(() => originMounted);
  const old = pending.promise.then((list) => {
    if (canApply()) visible = list;
  });
  originMounted = false;
  pending.resolve(["origin-session"]);
  await old;
  assert.deepEqual(visible, ["destination-session"]);
});
