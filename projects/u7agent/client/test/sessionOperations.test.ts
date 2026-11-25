// 会話の操作（改名 / 削除 / 分岐 / 引き継ぎ / クリア）の手順。
// 確認を取ってから投げること、成否に関わらず一覧を取り直すこと、移り先の選び方、
// 履歴の世代を控えてからクリアすることを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatch } from "react";
import type { ChatAction } from "../src/lib/chatState";
import {
  branchSession,
  clearSessionHistory,
  moveSession,
  removeSession,
  renameSessionTitle,
  type ClearHistoryDeps,
  type DeleteSessionDeps,
} from "../src/hooks/sessionOperations";
import type { ConfirmRequest, PromptRequest } from "../src/lib/confirmDialog";
import type { SessionMoveResponse, SessionPayload, SessionSummary } from "../src/types";

const session = (sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId,
  title: sessionId,
  agentId: "agent",
  status: "idle",
  queueDepth: 0,
  messageCount: 0,
  createdAt: 1,
  lastUsedAt: 1,
  titleSummary: { origin: "auto" },
  notify: false,
  canHandoff: true,
  hasRawLog: false,
  serveCommand: null,
  pinned: false,
  ...overrides,
});

function payload(sessionId: string, overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId,
    piSessionId: `pi-${sessionId}`,
    cwd: "",
    eventGeneration: "gen-1",
    historyGeneration: "",
    titleSummary: { origin: "auto" },
    pendingSends: [],
    notify: false,
    networkAccess: { mode: "allow", approved: false },
    status: "idle",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    serverNow: 1,
    queueDepth: 0,
    pinned: false,
    lastSeq: 1,
    run: null,
    messages: [],
    compactions: [],
    ...overrides,
  };
}

function actionRecorder() {
  const actions: ChatAction[] = [];
  const dispatch: Dispatch<ChatAction> = (action) => {
    actions.push(action as ChatAction);
  };
  return { actions, dispatch };
}

/** 確認・入力の記録。既定は「確定した」 */
function dialog(answer: { confirm?: boolean; prompt?: string | null } = {}) {
  const requests: (ConfirmRequest | PromptRequest)[] = [];
  return {
    requests,
    confirm: async (request: ConfirmRequest) => {
      requests.push(request);
      return answer.confirm ?? true;
    },
    prompt: async (request: PromptRequest) => {
      requests.push(request);
      return answer.prompt === undefined ? null : answer.prompt;
    },
  };
}

// --- 改名 ---

test("改名は現在のタイトルを初期値にして、応答のタイトルを一覧へ反映する", async () => {
  const { actions, dispatch } = actionRecorder();
  const dialogs = dialog({ prompt: "新しい名前" });
  const titles: [string, string][] = [];
  const renamed: [string, string][] = [];

  await renameSessionTitle("s-1", {
    sessionsRef: { current: [session("s-0"), session("s-1", { title: "今の名前" })] },
    prompt: dialogs.prompt,
    applyTitle: (id, title) => titles.push([id, title]),
    rename: async (id, title) => {
      renamed.push([id, title]);
      return { sessionId: id, title: `${title}!` };
    },
    dispatch,
  });

  assert.deepEqual(renamed, [["s-1", "新しい名前"]], "確定した値だけを送る");
  assert.equal((dialogs.requests[0] as PromptRequest).defaultValue, "今の名前", "初期値は現在のタイトル");
  assert.deepEqual(titles, [["s-1", "新しい名前!"]], "応答のタイトルを正とする");
  assert.deepEqual(actions, []);
});

test("改名は取り消し・未変更ならサーバーへ送らない", async () => {
  for (const value of [null, "", "今の名前"]) {
    const dialogs = dialog({ prompt: value });
    const renamed: string[] = [];
    await renameSessionTitle("s-1", {
      sessionsRef: { current: [session("s-1", { title: "今の名前" })] },
      prompt: dialogs.prompt,
      applyTitle: () => assert.fail("反映しない"),
      rename: async (id) => {
        renamed.push(id);
        return { sessionId: id, title: "" };
      },
      dispatch: () => assert.fail("状態行を触らない"),
    });
    assert.deepEqual(renamed, [], `${value} では送らない`);
  }
});

test("改名の失敗は理由を状態行へ出し、一覧を書き換えない", async () => {
  const { actions, dispatch } = actionRecorder();
  await renameSessionTitle("s-1", {
    sessionsRef: { current: [session("s-1")] },
    prompt: async () => "新しい名前",
    applyTitle: () => assert.fail("失敗では反映しない"),
    rename: async () => {
      throw new Error("保存できませんでした");
    },
    dispatch,
  });

  assert.deepEqual(actions, [
    { type: "setActivity", text: "セッション名を変更できませんでした。保存できませんでした" },
  ]);
});

// --- 削除 ---

function deleteDeps(overrides: Partial<DeleteSessionDeps> = {}) {
  const { actions, dispatch } = actionRecorder();
  const removed: string[] = [];
  const selected: string[] = [];
  let newChats = 0;
  const deps: DeleteSessionDeps = {
    sessionIdRef: { current: "s-1" },
    sessionsRef: { current: [session("s-1", { title: "消す会話" }), session("s-2")] },
    spaceIdRef: { current: "default" },
    refreshSessionsNow: async () => [session("s-2")],
    selectSession: async (id) => {
      selected.push(id);
      return "opened";
    },
    newChat: () => {
      newChats += 1;
    },
    confirm: async () => true,
    remove: async (id) => {
      removed.push(id);
    },
    ...overrides,
  };
  return { deps, actions, dispatch, removed, selected, newChatCount: () => newChats };
}

test("削除は確認の後に投げ、一覧の先頭へ移る", async () => {
  const harness = deleteDeps();
  const dialogs = dialog();
  const { deps } = harness;
  deps.confirm = dialogs.confirm;

  await removeSession("s-1", deps);

  assert.deepEqual((dialogs.requests[0] as ConfirmRequest).subject, { label: "削除するセッション", value: "消す会話" });
  assert.deepEqual(harness.removed, ["s-1"]);
  assert.deepEqual(harness.selected, ["s-2"], "現在のスペースの先頭へ移る");
  assert.equal(harness.newChatCount(), 0);
});

test("削除の確認を取り消したら何もしない", async () => {
  const harness = deleteDeps({ confirm: async () => false });
  await removeSession("s-1", harness.deps);
  assert.deepEqual(harness.removed, []);
  assert.deepEqual(harness.selected, []);
  assert.equal(harness.newChatCount(), 0);
});

test("削除の応答が失敗しても一覧を取り直し、消えていれば移り先を決める", async () => {
  const refreshed: number[] = [];
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (error: unknown) => logged.push(error);
  const harness = deleteDeps({
    remove: async () => {
      throw new Error("応答が失われました");
    },
    refreshSessionsNow: async () => {
      refreshed.push(1);
      return [session("s-2")];
    },
  });

  try {
    await removeSession("s-1", harness.deps);
  } finally {
    console.error = original;
  }

  assert.equal(refreshed.length, 1, "成否に関わらず確かめる");
  assert.equal(logged.length, 1, "応答の失敗は握りつぶさずに残す");
  assert.deepEqual(harness.selected, ["s-2"]);
});

test("一覧を取り直せなくても前回の一覧で移り先を決め、残りが無ければ新規チャットへ移る", async () => {
  const harness = deleteDeps({
    refreshSessionsNow: async () => null,
    sessionsRef: { current: [session("s-1"), session("s-3")] },
  });
  await removeSession("s-1", harness.deps);
  // 前の一覧には消した会話がまだ残っている。掴んでも selectSession が移す
  assert.deepEqual(harness.selected, ["s-1"]);

  const empty = deleteDeps({ refreshSessionsNow: async () => [], sessionsRef: { current: [session("s-1")] } });
  await removeSession("s-1", empty.deps);
  assert.deepEqual(empty.selected, []);
  assert.equal(empty.newChatCount(), 1);
});

test("表示していない会話を削除しても選択を動かさない", async () => {
  const harness = deleteDeps({ sessionIdRef: { current: "s-2" } });
  await removeSession("s-1", harness.deps);
  assert.deepEqual(harness.selected, []);
  assert.equal(harness.newChatCount(), 0);
});

test("削除の移り先は現在のスペースから選ぶ", async () => {
  const harness = deleteDeps({
    spaceIdRef: { current: "work" },
    refreshSessionsNow: async () => [session("other", { spaceId: "default" }), session("mine", { spaceId: "work" })],
  });
  await removeSession("s-1", harness.deps);
  assert.deepEqual(harness.selected, ["mine"]);
});

// --- 分岐 / 引き継ぎ ---

test("分岐は成功したら一覧を取り直し、子の payload を返す", async () => {
  let refreshed = 0;
  const child = payload("child");
  const result = await branchSession(
    "s-1",
    { agentId: "agent-2" },
    {
      fork: async (id, request) => {
        assert.equal(id, "s-1");
        assert.deepEqual(request, { agentId: "agent-2" });
        return child;
      },
      refreshSessionsNow: async () => {
        refreshed += 1;
        return [];
      },
    },
  );
  assert.equal(result, child);
  assert.equal(refreshed, 1);
});

test("分岐の失敗は投げ直し、一覧を取り直さない", async () => {
  let refreshed = 0;
  await assert.rejects(
    branchSession(
      "s-1",
      {},
      {
        fork: async () => {
          throw new Error("分岐できませんでした");
        },
        refreshSessionsNow: async () => {
          refreshed += 1;
          return [];
        },
      },
    ),
    /分岐できませんでした/,
  );
  assert.equal(refreshed, 0, "失敗の理由はダイアログが持つ");
});

test("引き継ぎは移動先を body で渡し、成功したら一覧を取り直して応答を返す", async () => {
  const moved: SessionMoveResponse = {
    sessionId: "s-1",
    spaceId: "work",
  } as SessionMoveResponse;
  let refreshed = 0;
  const result = await moveSession(
    "s-1",
    { spaceId: "work", memo: true },
    {
      handoff: async (id, request) => {
        assert.equal(id, "s-1");
        assert.deepEqual(request, { spaceId: "work", memo: true });
        return moved;
      },
      refreshSessionsNow: async () => {
        refreshed += 1;
        return [];
      },
    },
  );
  assert.equal(result, moved);
  assert.equal(refreshed, 1);
});

test("引き継ぎの失敗は投げ直し、一覧を取り直さない", async () => {
  let refreshed = 0;
  await assert.rejects(
    moveSession(
      "s-1",
      { spaceId: "work", memo: false },
      {
        handoff: async () => {
          throw new Error("移動できませんでした");
        },
        refreshSessionsNow: async () => {
          refreshed += 1;
          return [];
        },
      },
    ),
    /移動できませんでした/,
  );
  assert.equal(refreshed, 0);
});

// --- 履歴のクリア ---

function clearDeps(overrides: Partial<ClearHistoryDeps> = {}) {
  const { actions, dispatch } = actionRecorder();
  const cleared: { id: string; historyGeneration: string }[] = [];
  const selected: { id: string; options?: { fallbackOnFailure?: boolean; discardHistory?: boolean } }[] = [];
  const history = {
    reset: () => {},
    resetForCleanup: () => {},
  };
  const deps: ClearHistoryDeps = {
    sessionIdRef: { current: "s-1" },
    sessionsRef: { current: [session("s-1", { title: "消す履歴" })] },
    refreshSessionsNow: async () => [session("s-1")],
    selectSession: async (id, _isCurrent, options) => {
      selected.push({ id, ...(options ? { options } : {}) });
      return "opened";
    },
    confirm: async () => true,
    getSession: async () => payload("s-1", { historyGeneration: "gen-1" }),
    clear: async (id, request) => {
      cleared.push({ id, historyGeneration: request.historyGeneration });
      return { sessionId: id, title: "", changed: true, historyGeneration: "gen-2", cleanupPending: false };
    },
    history,
    dispatch,
    ...overrides,
  };
  return { deps, actions, dispatch, cleared, selected, history };
}

test("履歴のクリアは確認の前に世代を控え、成功したら同じ URL のまま開き直す", async () => {
  const harness = clearDeps();
  const dialogs = dialog();
  harness.deps.confirm = dialogs.confirm;

  await clearSessionHistory("s-1", harness.deps);

  assert.deepEqual(harness.cleared, [{ id: "s-1", historyGeneration: "gen-1" }], "確認の時点の世代を送る");
  assert.deepEqual((dialogs.requests[0] as ConfirmRequest).subject, { label: "対象の会話", value: "消す履歴" });
  assert.deepEqual(harness.selected, [{ id: "s-1", options: { fallbackOnFailure: false, discardHistory: true } }]);
  assert.deepEqual(harness.actions, [{ type: "setActivity", text: "会話履歴をクリアしました" }]);
});

test("世代を控えられなければ確認もクリアもせず、理由だけを出す", async () => {
  const dialogs = dialog();
  const harness = clearDeps({
    getSession: async () => {
      throw new Error("セッションを取得できませんでした");
    },
  });
  harness.deps.confirm = dialogs.confirm;

  await clearSessionHistory("s-1", harness.deps);

  assert.deepEqual(dialogs.requests, []);
  assert.deepEqual(harness.cleared, []);
  assert.deepEqual(harness.actions, [
    { type: "setActivity", text: "会話履歴をクリアできませんでした。セッションを取得できませんでした" },
  ]);
});

test("履歴のクリアは確認を取り消したら送らない", async () => {
  const harness = clearDeps({ confirm: async () => false });
  await clearSessionHistory("s-1", harness.deps);
  assert.deepEqual(harness.cleared, []);
  assert.deepEqual(harness.actions, []);
});

test("履歴のクリアの失敗は理由を状態行へ出し、開き直さない", async () => {
  const harness = clearDeps({
    clear: async () => {
      throw new Error("実行中はクリアできません");
    },
  });
  await clearSessionHistory("s-1", harness.deps);
  assert.deepEqual(harness.selected, []);
  assert.deepEqual(harness.actions, [
    { type: "setActivity", text: "会話履歴をクリアできませんでした。実行中はクリアできません" },
  ]);
});

test("クリアしていない会話は一覧だけを取り直し、状態行を乱さない", async () => {
  const harness = clearDeps({
    clear: async (id) => ({
      sessionId: id,
      title: "",
      changed: false,
      historyGeneration: "gen-2",
      cleanupPending: false,
    }),
  });
  await clearSessionHistory("s-1", harness.deps);
  assert.deepEqual(harness.selected, []);
  assert.deepEqual(harness.actions, [{ type: "setActivity", text: "消す会話履歴はありませんでした" }]);
});

test("開いていない会話のクリアは、一覧を取り直すだけで状態行も選択も動かさない", async () => {
  let refreshed = 0;
  const harness = clearDeps({
    sessionIdRef: { current: "s-2" },
    refreshSessionsNow: async () => {
      refreshed += 1;
      return [];
    },
  });
  await clearSessionHistory("s-1", harness.deps);
  assert.equal(refreshed, 1);
  assert.deepEqual(harness.actions, []);
  assert.deepEqual(harness.selected, []);
});

test("片付け待ちのクリアは開き直さず、手元の履歴だけを捨てて警告を出す", async () => {
  const cleanup: { sessionId: string; generation: string }[] = [];
  const harness = clearDeps({
    clear: async (id) => ({
      sessionId: id,
      title: "",
      changed: true,
      historyGeneration: "gen-2",
      cleanupPending: true,
    }),
  });
  harness.deps.confirm = async () => true;
  harness.deps.history = {
    reset: () => assert.fail("開き直しの経路は使わない"),
    resetForCleanup: (sessionId, generation) => cleanup.push({ sessionId, generation }),
  };

  await clearSessionHistory("s-1", harness.deps);

  assert.deepEqual(cleanup, [{ sessionId: "s-1", generation: "gen-2" }]);
  assert.deepEqual(harness.selected, [], "開き直すと 409 になる");
  assert.deepEqual(
    harness.actions.map((action) => action.type),
    ["setActivity"],
  );
  const [activity] = harness.actions;
  assert.equal(
    activity.type === "setActivity" && activity.text.includes("片付け"),
    true,
    "片付けが残ったことを状態行へ出す",
  );
});

test("開き直しに失敗したら、リンク先が見つからないときの理由を出す", async () => {
  const harness = clearDeps({
    selectSession: async () => "fallback",
  });
  await clearSessionHistory("s-1", harness.deps);

  const [activity] = harness.actions;
  assert.equal(activity.type === "setActivity" && activity.text.includes("見つかりません"), true);
});

test("開き直しが別の選択に奪われたら状態行を触らない", async () => {
  const harness = clearDeps({ selectSession: async () => "superseded" });
  await clearSessionHistory("s-1", harness.deps);
  assert.deepEqual(harness.actions, []);
});
