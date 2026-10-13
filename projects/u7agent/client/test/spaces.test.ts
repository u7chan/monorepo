import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpaceSelectionStore,
  initialSpaceSelection,
  moveDestinationSpaces,
  ownerLinkSpace,
  selectedSpace,
  selectionAfterSpaceDelete,
  spaceSelectionStore,
  DEFAULT_SPACE_ID,
  SPACE_SELECTION_KEY,
  type SpaceSelectionStorage,
} from "../src/lib/spaceSelection";
import { spaceDeleteConfirmRequest, spaceRowActions } from "../src/lib/spaceSettings";
import { removeSpaceAndApply } from "../src/lib/spaceDelete";
import { createSessionCreation } from "../src/hooks/sessionCreation";
import { sendChatMessage, type SendChatMessageDeps } from "../src/hooks/sessionActions";
import { createRequestGate } from "../src/hooks/requestGate";
import type { ChatAction } from "../src/hooks/chatReducer";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { createSpaceApi, getCatalog, getFiles, listSpaces, createSpace } = await import("../src/api");
const normal = { id: "default", name: "既定", createdAt: 0 };
const demo = { id: "space-1111111111111111", name: "デモ", createdAt: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("選択欠落だけ既定を選び、不正・未知の保存値や未取得一覧は既定へ戻さない", () => {
  assert.equal(selectedSpace([normal, demo], null), normal);
  assert.equal(selectedSpace([normal, demo], demo.id), demo);
  for (const value of ["", "../bad", "unknown"]) assert.equal(selectedSpace([normal, demo], value), undefined);
  assert.equal(selectedSpace([], null), undefined);
});

test("引っ越し先の候補は現在のスペースを除き、1 つしか無ければ空になる", () => {
  assert.deepEqual(moveDestinationSpaces([normal, demo], "default"), [demo]);
  assert.deepEqual(moveDestinationSpaces([normal, demo], demo.id), [normal]);
  // 既定スペースしか無いときは候補 0 件 (ダイアログは確定を無効にする)
  assert.deepEqual(moveDestinationSpaces([normal], "default"), []);
  assert.deepEqual(moveDestinationSpaces([], "default"), []);
});

test("削除後の選択は、選択中を消したときだけ既定へ倒し、選択していないスペースの削除では変えない", () => {
  assert.equal(selectionAfterSpaceDelete(demo.id, demo.id), DEFAULT_SPACE_ID);
  // 非選択の削除は一覧から外すだけ (復旧画面にも別の追加スペースにも移らない)
  assert.equal(selectionAfterSpaceDelete(normal.id, demo.id), null);
  // 復旧画面になる未知の選択値でも、消したのが別のスペースなら選択は動かさない
  assert.equal(selectionAfterSpaceDelete("unknown", demo.id), null);
});

/** 削除の成功後処理の呼び出しを順に記録する。選択は await の後に読まれる (呼び出し時の値を閉じ込めない) */
function spaceDeleteRecorder(selectedAtStart: string, selectedAfterAwait?: string) {
  const calls: string[] = [];
  let selectedId = selectedAtStart;
  const deps = {
    removeSpace: async (id: string) => {
      calls.push(`delete:${id}`);
      if (selectedAfterAwait !== undefined) selectedId = selectedAfterAwait;
    },
    selectedId: () => {
      calls.push("read-selection");
      return selectedId;
    },
    forget: (id: string) => {
      calls.push(`forget:${id}`);
    },
    navigateToChat: () => {
      calls.push("navigate");
    },
    persistSelection: (id: string) => {
      calls.push(`persist:${id}`);
    },
    select: (id: string) => {
      calls.push(`select:${id}`);
    },
  };
  return { calls, deps };
}

test("選択中のスペースの削除は、成功時点の選択で既定へ倒し、URL → 保存値 → 選択の順に適用する", async () => {
  const { calls, deps } = spaceDeleteRecorder(demo.id);
  assert.deepEqual(await removeSpaceAndApply(demo.id, deps), { selectionReset: true });
  // 会話を持たない chat への導線を先に呼ぶ (選択を変えると App が作り直され、その時点の URL が画面になる)
  assert.deepEqual(calls, [
    `delete:${demo.id}`,
    `forget:${demo.id}`,
    "read-selection",
    "navigate",
    `persist:${DEFAULT_SPACE_ID}`,
    `select:${DEFAULT_SPACE_ID}`,
  ]);
});

test("選択していないスペースの削除は一覧だけを更新し、選択・URL・保存値を変えない", async () => {
  const { calls, deps } = spaceDeleteRecorder(normal.id);
  assert.deepEqual(await removeSpaceAndApply(demo.id, deps), { selectionReset: false });
  assert.deepEqual(calls, [`delete:${demo.id}`, `forget:${demo.id}`, "read-selection"]);
});

test("削除の待ち中に選択が動いても、成功時点の選択で判定し新しい選択を巻き戻さない", async () => {
  // A を選択して A の削除を待つ間に B を選ぶ → 後着の応答で B の保存値・選択を default へ上書きしない
  const switched = spaceDeleteRecorder(demo.id, normal.id);
  assert.deepEqual(await removeSpaceAndApply(demo.id, switched.deps), { selectionReset: false });
  assert.deepEqual(switched.calls, [`delete:${demo.id}`, `forget:${demo.id}`, "read-selection"]);

  // 既定を選択して非選択の A の削除を待つ間に A を選ぶ → 自分で削除した選択中スペースは既定へ倒す
  const selectedDuringDelete = spaceDeleteRecorder(normal.id, demo.id);
  assert.deepEqual(await removeSpaceAndApply(demo.id, selectedDuringDelete.deps), { selectionReset: true });
  assert.deepEqual(selectedDuringDelete.calls, [
    `delete:${demo.id}`,
    `forget:${demo.id}`,
    "read-selection",
    "navigate",
    `persist:${DEFAULT_SPACE_ID}`,
    `select:${DEFAULT_SPACE_ID}`,
  ]);
});

test("削除が失敗したときは一覧以外の状態を変えず、理由をそのまま伝える", async () => {
  const calls: string[] = [];
  const { deps } = spaceDeleteRecorder(demo.id);
  await assert.rejects(
    removeSpaceAndApply(demo.id, {
      ...deps,
      removeSpace: async () => {
        calls.push("delete");
        throw Object.assign(new Error("公開中のサービスがあります"), { status: 409 });
      },
      forget: () => {
        calls.push("forget");
      },
    }),
    { message: "公開中のサービスがあります", status: 409 },
  );
  assert.deepEqual(calls, ["delete"], "失敗時は一覧も選択も変えない");
});

test("行の ⋯ は既定スペースに項目を持たず、追加スペースだけに削除を出す", () => {
  // 空配列は「その行に出せる操作が無い」印で、呼び出し側は ⋯ ごと出さない
  assert.deepEqual(spaceRowActions(true), []);
  assert.deepEqual(spaceRowActions(false), [{ kind: "delete", label: "スペースを削除", danger: true }]);
});

test("削除の確認はスペース名と消える対象、実行中の停止、選択中なら既定へ切り替わることを示す", () => {
  const request = spaceDeleteConfirmRequest(demo);
  assert.equal(request.title, "会話スペースを削除");
  assert.deepEqual(request.subject, { label: "削除する会話スペース", value: "デモ" });
  assert.equal(request.confirmLabel, "削除する");
  assert.ok(request.danger, "削除は danger にする");
  // 件数は出さず、消える対象の列挙で判断できるようにする
  const text = [...(request.body ?? []), ...(request.notes ?? [])].join("");
  for (const target of ["会話", "履歴", "作業フォルダのファイル", "添付", "環境変数", "サービス実績"]) {
    assert.ok(text.includes(target), `消える対象が無い: ${target}`);
  }
  assert.ok(text.includes("実行中") && text.includes("停止"), "実行中の会話が止まることが無い");
  assert.ok(text.includes("既定スペースへ切り替わ"), "選択中なら既定へ切り替わることが無い");
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

  // 読み取りの例外は呼び出し側 (SpacesApp) が受け取り、既定スペースを黙って出さない
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
  // window が無い / storage を渡さない場合は、既定スペースを選ばずに読み取りを失敗させる
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
  // 未知の値は既定へ黙って落とさない (一覧との突き合わせは selectedSpace が持つ)
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
