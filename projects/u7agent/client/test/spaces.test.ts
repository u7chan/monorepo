import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpaceSelectionStore,
  initialSpaceSelection,
  ownerLinkSpace,
  selectedSpace,
  spaceSelectionStore,
  SPACE_SELECTION_KEY,
  type SpaceSelectionStorage,
} from "../src/lib/spaceSelection";
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
});

/** 保存領域 1 つ分。window が無い Node でも store を検査できるよう注入する */
function fakeStorage(): SpaceSelectionStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

test("注入した Storage で往復し、書き込みの失敗は握り、読み取りの失敗は握らない", () => {
  const storage = fakeStorage();
  const store = createSpaceSelectionStore(storage);
  assert.equal(store.read(), null);
  store.write(demo.id);
  assert.equal(store.read(), demo.id);
  assert.equal(storage.data.get(SPACE_SELECTION_KEY), demo.id);

  // 読み取りの例外は呼び出し側 (SpacesApp) が受け取り、通常スペースを黙って出さない
  const blocked = createSpaceSelectionStore({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {},
  });
  assert.throws(() => blocked.read(), /blocked/);

  // 書き込みの失敗 (SecurityError / quota 等) は切替を塞がない。次の起動では前の値に戻り得る
  const failing = createSpaceSelectionStore({
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  });
  failing.write(demo.id);
});

test("既定の保存先は都度 window.localStorage を解決し、解決できないときは fail-closed にする", () => {
  const data = new Map<string, string>();
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    },
  };
  try {
    // import 時に解決せず、呼び出しごとに引く (accessor が例外になる環境がある)
    assert.equal(spaceSelectionStore.read(), null);
    spaceSelectionStore.write(demo.id);
    assert.equal(spaceSelectionStore.read(), demo.id);
    assert.equal(data.get(SPACE_SELECTION_KEY), demo.id);
  } finally {
    globals.window = previous;
  }
  // window が無い / storage を渡さない場合は、通常スペースを選ばずに読み取りを失敗させる
  assert.throws(() => spaceSelectionStore.read());
  assert.throws(() => createSpaceSelectionStore(null).read());
  createSpaceSelectionStore(null).write(demo.id);
});

test("初期選択は URL の space → 保存値 → 既定の順に決め、一覧に無い値は復旧画面へ回す", () => {
  assert.equal(initialSpaceSelection(null, null).id, "default");
  assert.deepEqual(initialSpaceSelection(null, null), { id: "default", fromUrl: false });
  assert.deepEqual(initialSpaceSelection(null, demo.id), { id: demo.id, fromUrl: false });
  // URL の明示指定は保存値に勝ち、確定後に保存値も更新する (開いたスペースが次の初期表示になる)
  assert.deepEqual(initialSpaceSelection(demo.id, normal.id), { id: demo.id, fromUrl: true });
  assert.deepEqual(initialSpaceSelection(demo.id, null), { id: demo.id, fromUrl: true });
  // 未知の値は通常へ黙って落とさない (一覧との突き合わせは selectedSpace が持つ)
  const unknown = initialSpaceSelection("unknown", normal.id);
  assert.deepEqual(unknown, { id: "unknown", fromUrl: true });
  assert.equal(selectedSpace([normal, demo], unknown.id), undefined);
});

test("起動元リンクは所属が一覧にある別スペースだけ切り替え、不明・現在と同じ・一覧に無い所属は現在のスペースに留まる", () => {
  assert.equal(ownerLinkSpace(demo.id, normal.id, [normal, demo]), demo.id);
  assert.equal(ownerLinkSpace(normal.id, normal.id, [normal, demo]), null);
  assert.equal(ownerLinkSpace(undefined, normal.id, [normal, demo]), null);
  assert.equal(ownerLinkSpace("unknown", normal.id, [normal, demo]), null);
  assert.equal(ownerLinkSpace(demo.id, normal.id, [normal]), null);
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
