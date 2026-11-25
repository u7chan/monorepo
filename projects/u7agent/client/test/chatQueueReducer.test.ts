// 送信キュー (エコーと送信IDの対応付け / 待機の表示 / 取り消し / 再送 / pending の復元) の回帰テスト。
import assert from "node:assert/strict";
import test from "node:test";
import { initialChatState } from "../src/lib/chatState";
import { chatReducer } from "../src/hooks/chatReducer";
import { chatRenderItems } from "../src/lib/chatItems";
import { queuedSendsOf } from "../src/lib/queueWait";
import type { ChatState } from "../src/lib/chatState";
import type { PendingSend, SessionPayload } from "../src/types";

/** 実行中・モデル・ツール付きの resync / GET /api/sessions/:id 相当 */
function runningPayload(): SessionPayload {
  return {
    sessionId: "session-a",
    piSessionId: "pi-session-a",
    cwd: "",
    eventGeneration: "gen-1",
    historyGeneration: "",
    titleSummary: { origin: "auto" },
    pendingSends: [],
    notify: false,
    networkAccess: { mode: "allow", approved: false },
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    status: "running",
    title: "README をレビューして",
    createdAt: 1,
    lastUsedAt: 2,
    serverNow: 2,
    queueDepth: 2,
    pinned: false,
    lastSeq: 7,
    run: null,
    messages: [
      { role: "user", text: "こんにちは" },
      { role: "assistant", text: "はい" },
    ],
    compactions: [],
  };
}

/** 圧縮中の payload。開始時刻は payload の compactionStartedAt だけを正とする */
function compactingPayload(): SessionPayload {
  return {
    ...runningPayload(),
    status: "compacting",
    compactionStartedAt: 1700000005000,
    run: null,
  };
}

/** 履歴 item から作った entryId 付きの user パブル 1 件だけを持つ状態 */
function stateWithHistoryUser(runId: string) {
  return chatReducer(initialChatState, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [{ kind: "message", id: "entry-1", context: "active", role: "user", text: "履歴の本文", runId }],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "entry-1",
      messageCount: 1,
      summarizedMessageCount: 0,
    },
  });
}

/** 履歴 API が使える状態 (保持分 1 件)。resync で live のエコーを残すために要る */
function historyWithOld() {
  return chatReducer(initialChatState, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [{ kind: "message", id: "old", context: "active", role: "user", text: "old", runId: "run-old" }],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "old",
      messageCount: 1,
      summarizedMessageCount: 0,
    },
  });
}

/** 送信のエコーへ応答の run id と待機の順位 (queued の queueDepth) を結び付ける */
function queuedEcho(state: ChatState, text: string, runId: string, position?: number) {
  const echoed = chatReducer(state, { type: "localUser", text, at: 10 });
  return chatReducer(echoed, {
    type: "echoSendId",
    sendId: runId,
    runId,
    ...(position === undefined ? {} : { queuePosition: position }),
  });
}

/** 待機 / 実行中 / 未送信が並ぶ payload (status と queueDepth は呼び出し側が決める) */
function pendingPayload(
  pendingSends: PendingSend[],
  status: SessionPayload["status"] = "running",
  queueDepth = pendingSends.length,
) {
  const payload = runningPayload();
  payload.status = status;
  payload.queueDepth = queueDepth;
  payload.pendingSends = pendingSends;
  payload.messages = [];
  return payload;
}

/** 描画の並び (`chatRenderItems`)。待機中の送信はここに現れない */
function renderOrder(state: ChatState): string[] {
  return chatRenderItems({ bubbles: state.bubbles, markers: [], compactions: [], activeContextStartId: null }).map(
    (item) => (item.kind === "message" ? `${item.bubble.role}:${item.bubble.text}` : item.kind),
  );
}

test("sendSeq は送信 (localUser) でだけ増える", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "聞いて", at: 1 });
  assert.equal(sent.sendSeq, initialChatState.sendSeq + 1);
  assert.equal(chatReducer(sent, { type: "localUser", text: "もう一度", at: 2 }).sendSeq, 2);
});

test("sendSeq は resync / run_start / echo の破棄で変わらない", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "聞いて", at: 1 });

  // 履歴を全置換する再接続。末尾が user でも送信と誤読しない
  const resynced = chatReducer(sent, { type: "resync", payload: runningPayload() });
  assert.equal(resynced.sendSeq, 1);
  assert.equal(chatReducer(resynced, { type: "resync", payload: runningPayload() }).sendSeq, 1);

  // サーバー側の受信 (run_start) は送信ではない
  assert.equal(chatReducer(sent, { type: "runStart", prompt: "聞いて", at: 2, startedAt: 2 }).sendSeq, 1);

  // post に失敗して echo を戻しても減らさない (最下部へ戻したままにする)
  assert.equal(chatReducer(sent, { type: "dropLocalUser" }).sendSeq, 1);
});

test("sendSeq は新規チャットへ引き継ぎ、単調に保つ", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "聞いて", at: 1 });
  const reset = chatReducer(sent, { type: "newChat" });

  // 減らすと、新規チャットへの切替を「送信」と誤読させる
  assert.equal(reset.sendSeq, 1);
  assert.equal(chatReducer(reset, { type: "localUser", text: "次の会話", at: 2 }).sendSeq, 2);
});

// --- メッセージ時刻 ---

test("ローカル生成のバブルは action で受け取った時刻を使う", () => {
  const user = chatReducer(initialChatState, { type: "localUser", text: "送信中", at: 100 });
  assert.equal(user.bubbles[0]?.at, 100);

  // runStart はローカルエコー済みの user バブルを重複させない (時刻は最初のバブルのまま)
  const echoed = chatReducer(user, { type: "runStart", prompt: "送信中", at: 200, startedAt: 200 });
  assert.deepEqual(
    echoed.bubbles.map((bubble) => bubble.at),
    [100],
  );

  const started = chatReducer(initialChatState, { type: "runStart", prompt: "新しい会話", at: 200, startedAt: 200 });
  assert.equal(started.bubbles[0]?.at, 200);

  // 応答中のバブルは生成元イベントの時刻で作り、以後の delta では上書きしない
  const streaming = chatReducer(started, { type: "text", delta: "応答", at: 300 });
  assert.equal(streaming.bubbles[1]?.at, 300);
  const more = chatReducer(streaming, { type: "text", delta: "の続き", at: 400 });
  assert.equal(more.bubbles[1]?.at, 300);

  // 本文が無くツールだけの assistant も同じ経路で時刻を持つ
  const toolOnly = chatReducer(initialChatState, {
    type: "toolStart",
    startedAt: 500,
    id: "tool-1",
    name: "read",
    args: "README.md",
    at: 500,
  });
  assert.equal(toolOnly.bubbles[0]?.at, 500);
  assert.equal(toolOnly.bubbles[0]?.text, "");
});

test("runStart は添付の注記をローカルエコーと同一視し、注記込みの本文へ差し替える", () => {
  const prompt = ["これを見て", "", "<attached_files>", "- ./uploads/a.png", "</attached_files>"].join("\n");
  const echoed = chatReducer(initialChatState, { type: "localUser", text: "これを見て", at: 100 });

  const started = chatReducer(echoed, { type: "runStart", prompt, at: 200, startedAt: 200 });
  assert.equal(started.bubbles.length, 1, "バブルを重複させない");
  assert.equal(started.bubbles[0]?.text, prompt, "注記込みの本文へ差し替える");
  assert.equal(started.bubbles[0]?.at, 100, "ローカルエコーの時刻を保つ");

  // 同じ本文の別メッセージを二重に足さない
  const repeated = chatReducer(started, { type: "runStart", prompt, at: 300, startedAt: 300 });
  assert.equal(repeated.bubbles.length, 1);

  // 添付の無い通常送信は従来どおり (本文が同じなら足さない)
  const plain = chatReducer(initialChatState, { type: "localUser", text: "ふつうの本文", at: 100 });
  const plainStarted = chatReducer(plain, { type: "runStart", prompt: "ふつうの本文", at: 200, startedAt: 200 });
  assert.equal(plainStarted.bubbles.length, 1);
  assert.equal(plainStarted.bubbles[0]?.text, "ふつうの本文");
});

test("runStart は展開済みのスキルブロックをローカルエコーと同一視し、展開後の本文へ差し替える", () => {
  // /skill: は BFF が展開してから届くため、run_start の本文はブロック込みになる
  const block = [
    '<skill name="writer" location="/workspace/.agents/skills/writer/SKILL.md">',
    "References are relative to /workspace/.agents/skills/writer.",
    "",
    "本文です。",
    "</skill>",
    "",
    "短く書いて",
  ].join("\n");
  const echoed = chatReducer(initialChatState, { type: "localUser", text: "/skill:writer 短く書いて", at: 100 });

  const started = chatReducer(echoed, { type: "runStart", prompt: block, at: 200, startedAt: 200 });
  assert.equal(started.bubbles.length, 1, "バブルを重複させない");
  assert.equal(started.bubbles[0]?.text, block, "展開後の本文へ差し替える");
  assert.equal(started.bubbles[0]?.at, 100, "ローカルエコーの時刻を保つ");

  // 未知の名前は展開されない (本文がそのまま届く) ので、通常の送信と同じ扱い
  const unknown = chatReducer(chatReducer(initialChatState, { type: "localUser", text: "/skill:ghost", at: 100 }), {
    type: "runStart",
    prompt: "/skill:ghost",
    at: 200,
    startedAt: 200,
  });
  assert.equal(unknown.bubbles.length, 1);
  assert.equal(unknown.bubbles[0]?.text, "/skill:ghost");
});

test("同一本文・異なる添付を続けて送っても run_start は送信順のバブルを差し替える", () => {
  const note = (path: string) => ["同じ本文", "", "<attached_files>", `- ./${path}`, "</attached_files>"].join("\n");
  const firstPrompt = note("uploads/a.png");
  const secondPrompt = note("uploads/b.png");

  // 実行中に同じ本文を送ると、2 つ目のエコーがキューに積まれる
  let state = chatReducer(initialChatState, { type: "localUser", text: "同じ本文", at: 100 });
  state = chatReducer(state, { type: "localUser", text: "同じ本文", at: 200 });
  assert.equal(state.bubbles.length, 2, "ローカルエコーは 2 つ出る");

  // 先に届く run_start は先に送ったバブルへ、次は後ろのバブルへ割り当たる
  const first = chatReducer(state, { type: "runStart", prompt: firstPrompt, at: 300, startedAt: 300 });
  assert.deepEqual(
    first.bubbles.map((bubble) => bubble.text),
    [firstPrompt, "同じ本文"],
    "先頭のバブルだけを差し替える",
  );
  assert.deepEqual(first.pendingEchoIds, [state.bubbles[1]?.id], "2 つ目のエコーは順番待ちのまま");
  const second = chatReducer(first, { type: "runStart", prompt: secondPrompt, at: 400, startedAt: 400 });
  assert.deepEqual(
    second.bubbles.map((bubble) => bubble.text),
    [firstPrompt, secondPrompt],
  );
  assert.deepEqual(second.pendingEchoIds, []);
  assert.equal(second.bubbles[0]?.at, 100, "時刻はエコーのものを保つ");
  assert.equal(second.bubbles[1]?.at, 200);
});

test("送信に失敗したエコーを戻し、次の同一本文が正しく割り当たる", () => {
  const prompt = ["同じ本文", "", "<attached_files>", "- ./uploads/a.png", "</attached_files>"].join("\n");

  const echoed = chatReducer(initialChatState, { type: "localUser", text: "同じ本文", at: 100 });
  const dropped = chatReducer(echoed, { type: "dropLocalUser" });
  assert.deepEqual(dropped.bubbles, [], "失敗したエコーは残さない");
  assert.deepEqual(dropped.pendingEchoIds, []);
  // 待ち行列が空のときに戻しても何も起きない
  assert.equal(chatReducer(dropped, { type: "dropLocalUser" }), dropped);

  const retried = chatReducer(dropped, { type: "localUser", text: "同じ本文", at: 200 });
  const started = chatReducer(retried, { type: "runStart", prompt, at: 300, startedAt: 300 });
  assert.equal(started.bubbles.length, 1, "失敗分のバブルが残っていない");
  assert.equal(started.bubbles[0]?.text, prompt, "再送のバブルが自分の注記を受け取る");
  assert.equal(started.bubbles[0]?.at, 200);
});

test("圧縮中に届いた queued は compacting を維持し、文言も圧縮中として出す", () => {
  const compacting = chatReducer(initialChatState, { type: "resync", payload: compactingPayload() });
  const queued = chatReducer(compacting, { type: "queued", position: 1, queueDepth: 1 });

  assert.equal(queued.runStatus, "compacting");
  assert.equal(queued.compactionStartedAt, 1700000005000);
  assert.equal(queued.activity, "圧縮中…", "件数はコンポーザー直上のブロックが正なので状態行は活動の語だけ");
  assert.equal(queued.queueDepth, 1);

  // 圧縮でないときは従来どおり running
  const running = chatReducer(chatReducer(initialChatState, { type: "runStart", prompt: "p", at: 1, startedAt: 1 }), {
    type: "queued",
    position: 1,
    queueDepth: 1,
  });
  assert.equal(running.runStatus, "running");
  assert.equal(running.activity, "実行中…");
});

test("未送信へ切り替わる経路と再送は、前のランの所要時間を消す", () => {
  const ended = chatReducer(stateWithHistoryUser("run-h"), {
    type: "runEnd",
    runId: "run-h",
    status: "stopped",
    queueDepth: 0,
    durationMs: 80_000,
  });
  assert.equal(ended.bubbles[0]?.runDurationMs, 80_000);

  // 停止で待機キューを破棄した (queue_cleared)
  const cleared = chatReducer(ended, { type: "queueCleared", sendIds: ["run-h"] });
  assert.deepEqual(
    cleared.bubbles.map((bubble) => [bubble.unsent === true, bubble.runDurationMs, bubble.runOutcome]),
    [[true, undefined, undefined]],
  );

  // payload が未送信として配った (再起動後)
  const payload = runningPayload();
  payload.sessionId = "session-a";
  payload.messages = [];
  payload.pendingSends = [{ sendId: "run-h", runId: "run-h", text: "履歴の本文", at: 1, state: "unsent" }];
  const unsent = chatReducer(ended, { type: "resync", payload });
  assert.deepEqual(
    unsent.bubbles.map((bubble) => [bubble.unsent === true, bubble.runDurationMs, bubble.runOutcome]),
    [[true, undefined, undefined]],
  );

  // 再送は pending へ戻すときに古い値を消し、再送失敗でも戻さない
  const resent = chatReducer(unsent, { type: "resendUnsent", sendId: "run-h" });
  assert.deepEqual(
    resent.bubbles.map((bubble) => [bubble.unsent === true, bubble.runDurationMs, bubble.runOutcome]),
    [[false, undefined, undefined]],
  );
  const failed = chatReducer(resent, { type: "resendFailed", sendId: "run-h" });
  assert.deepEqual(
    failed.bubbles.map((bubble) => [bubble.unsent === true, bubble.runDurationMs, bubble.runOutcome]),
    [[true, undefined, undefined]],
  );
});

// --- 待機キューの表示 (チップ / リング / 状態行) ---

test("送信応答が queued を返したら待機の表示になり、実行を始めた応答ではならない", () => {
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 2);
  const bubble = queued.bubbles.find((item) => item.runId === "run-b");
  assert.deepEqual([bubble?.queued, bubble?.queuePosition], [true, 2], "順位は応答の queueDepth");

  const direct = queuedEcho(initialChatState, "すぐ実行", "run-1");
  assert.equal(direct.bubbles.find((item) => item.runId === "run-1")?.queued, undefined);
});

test("run_start が応答より先に届いた run は、遅れて届いた queued の応答で待機中にしない", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "待機する本文", at: 10 });
  const started = chatReducer(sent, {
    type: "runStart",
    runId: "run-b",
    prompt: "待機する本文",
    at: 11,
    startedAt: 11,
  });
  const assigned = chatReducer(started, { type: "echoSendId", sendId: "run-b", runId: "run-b", queuePosition: 1 });

  assert.equal(assigned.bubbles.find((item) => item.runId === "run-b")?.queued, undefined);
  assert.equal(assigned.startingRunId, undefined, "開始の合図は run_start が立てる (応答では立てない)");
});

test("実行中に送ったエコーは配列の末尾に留まり、実行中ターンの本文は前のバブルへ積まれる", () => {
  // What: 送信のエコーで currentAssistantId を落とすと、次に届く delta がエコーより後ろへ新しいバブルを作り、
  // 実行に移った待機中の送信が実行中ターンの応答の途中に見える
  const running = chatReducer(initialChatState, { type: "runStart", prompt: "長いターン", at: 1, startedAt: 1 });
  const firstHalf = chatReducer(running, { type: "text", delta: "前半", at: 2 });
  const sent = chatReducer(firstHalf, { type: "localUser", text: "待機する本文", at: 3 });
  const queued = chatReducer(sent, { type: "echoSendId", sendId: "run-b", runId: "run-b", queuePosition: 1 });
  const secondHalf = chatReducer(queued, { type: "text", delta: "後半", at: 4 });

  assert.deepEqual(
    secondHalf.bubbles.map((bubble) => [bubble.role, bubble.text, bubble.queued === true]),
    [
      ["user", "長いターン", false],
      ["assistant", "前半後半", false],
      ["user", "待機する本文", true],
    ],
    "応答は実行中のバブルへ続けて積み、待機中のエコーは末尾に留まる",
  );

  // 待機が実行に移ったら、その応答はエコーの後ろの新しいバブルになる
  const startedB = chatReducer(secondHalf, {
    type: "runStart",
    runId: "run-b",
    prompt: "待機する本文",
    at: 5,
    startedAt: 5,
  });
  assert.deepEqual(
    chatReducer(startedB, { type: "text", delta: "B の応答", at: 6 }).bubbles.map((bubble) => bubble.text),
    ["長いターン", "前半後半", "待機する本文", "B の応答"],
  );
});

test("実行中ターンの応答より前に積まれた待機は、実行に移った時点で末尾へ移る", () => {
  // What: 最初の delta より前に 2 通目を送ると、前のターンの応答が待機のエコーより後ろに作られる。
  // run_start で待機を末尾へ移さないと、実行に移った送信が前のターンの応答の途中に現れる
  let state = chatReducer(initialChatState, { type: "localUser", text: "A", at: 1 });
  state = chatReducer(state, { type: "runStart", runId: "run-a", prompt: "A", at: 2, startedAt: 2 });
  state = chatReducer(state, { type: "echoSendId", sendId: "run-a", runId: "run-a" });
  state = chatReducer(state, { type: "localUser", text: "B", at: 3 });
  state = chatReducer(state, { type: "echoSendId", sendId: "run-b", runId: "run-b", queuePosition: 1 });
  state = chatReducer(state, { type: "text", delta: "A の応答", at: 4 });
  state = chatReducer(state, { type: "runEnd", runId: "run-a", status: "completed", queueDepth: 1, durationMs: 1000 });

  // 待機中は transcript に出ないため、応答が後ろにあっても描画は [A, 応答] のまま
  assert.deepEqual(renderOrder(state), ["user:A", "assistant:A の応答"]);
  assert.deepEqual(
    state.bubbles.map((bubble) => `${bubble.role}:${bubble.text}`),
    ["user:A", "user:B", "assistant:A の応答"],
    "窓の中では待機のエコーより後ろに応答が積まれる",
  );

  const started = chatReducer(state, {
    type: "runStart",
    runId: "run-b",
    initialSendId: "run-b",
    prompt: "B",
    at: 5,
    startedAt: 5,
  });

  assert.deepEqual(
    renderOrder(started),
    ["user:A", "assistant:A の応答", "user:B"],
    "実行に移った送信は直前のターンの応答の後ろに現れる",
  );
  assert.deepEqual(
    started.bubbles.map((bubble) => `${bubble.role}:${bubble.text}`),
    ["user:A", "assistant:A の応答", "user:B"],
    "他のバブルの相対順は変えない",
  );
});

test("payload の pendingSends が待機と順位を配り、一覧から消えた run は待機を解除する", () => {
  const resynced = chatReducer(historyWithOld(), {
    type: "resync",
    payload: pendingPayload([
      { sendId: "run-a", runId: "run-a", text: "A", at: 1, state: "queued", position: 2 },
      { sendId: "run-b", runId: "run-b", text: "B", at: 2, state: "queued", position: 1 },
      { sendId: "run-c", runId: "run-c", text: "C", at: 3, state: "running" },
      { sendId: "run-d", runId: "run-d", text: "D", at: 4, state: "unsent" },
    ]),
  });
  assert.deepEqual(
    resynced.bubbles
      .filter((bubble) => bubble.runId !== undefined)
      .map((bubble) => [bubble.runId, bubble.queued === true, bubble.queuePosition, bubble.unsent === true]),
    [
      ["run-old", false, undefined, false],
      ["run-a", true, 2, false],
      ["run-b", true, 1, false],
      ["run-c", false, undefined, false],
      ["run-d", false, undefined, true],
    ],
    "待機だけが順位を持ち、実行中 / 未送信は持たない",
  );

  // 先頭が実行に移り entry が保存された (payload から消える)。古い順位を残さない
  const advanced = chatReducer(resynced, {
    type: "resync",
    payload: pendingPayload([{ sendId: "run-b", runId: "run-b", text: "B", at: 2, state: "queued", position: 1 }]),
  });
  assert.deepEqual(
    advanced.bubbles
      .filter((bubble) => bubble.runId === "run-a" || bubble.runId === "run-b")
      .map((bubble) => [bubble.runId, bubble.queued === true, bubble.queuePosition]),
    [
      ["run-a", false, undefined],
      ["run-b", true, 1],
    ],
  );
});

// What: エコーは送信応答より先に描画される。payload が先に同じ送信を配ったときに新しいバブルを

// 足すと、応答が届くまで同じ発言が 2 件並び、追従中のスクロールが跳ねる
test("payload が先に配った pending 送信は、同じ本文のエコーへ寄せて二重にしない", () => {
  const echoed = chatReducer(initialChatState, { type: "localUser", text: "考えて", at: 10 });
  const resynced = chatReducer(echoed, {
    type: "resync",
    payload: pendingPayload([{ sendId: "send-1", runId: "run-1", text: "考えて", at: 10, state: "running" }]),
  });

  assert.deepEqual(
    resynced.bubbles
      .filter((bubble) => bubble.role === "user")
      .map((bubble) => [bubble.text, bubble.sendId, bubble.runId]),
    [["考えて", "send-1", "run-1"]],
    "エコーへ送信IDと run id を結び付け、バブルを増やさない",
  );

  // 送信応答が遅れて届いても、同じバブルのまま受け取る
  const echoedBack = chatReducer(resynced, { type: "echoSendId", sendId: "send-1", runId: "run-1" });
  assert.equal(echoedBack.bubbles.filter((bubble) => bubble.role === "user").length, 1);
});

test("payload の pending 送信は、本文が違うエコーへ送信IDを結び付けない", () => {
  const echoed = chatReducer(initialChatState, { type: "localUser", text: "自分の本文", at: 10 });
  const resynced = chatReducer(echoed, {
    type: "resync",
    payload: pendingPayload([{ sendId: "send-other", runId: "run-x", text: "別の本文", at: 9, state: "running" }]),
  });

  assert.deepEqual(
    resynced.bubbles.filter((bubble) => bubble.role === "user").map((bubble) => [bubble.text, bubble.sendId]),
    [
      ["自分の本文", undefined],
      ["別の本文", "send-other"],
    ],
    "別クライアントの送信をエコーへ結び付けない",
  );
});

test("run_start はその run の待機を解除し、開始の合図は状態イベントでは落とさない", () => {
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 1);
  const started = chatReducer(queued, {
    type: "runStart",
    runId: "run-b",
    initialSendId: "run-b",
    prompt: "待機する本文",
    at: 11,
    startedAt: 11,
  });

  assert.equal(started.startingRunId, "run-b");
  assert.equal(started.bubbles.find((bubble) => bubble.runId === "run-b")?.queued, undefined);

  // run_start の直後に届く状態イベントと同じ描画にまとまっても合図は残す。ここで落とすと
  // 演出が 1 フレームも出ない / 広がりが途中で切れる (tester の再現)
  assert.deepEqual(
    [
      chatReducer(started, { type: "status", state: "thinking", text: "考え中…" }),
      chatReducer(started, { type: "usage" }),
      chatReducer(started, { type: "toolStart", startedAt: 12, id: "t1", name: "read", args: "", at: 12 }),
      chatReducer(started, { type: "text", delta: "あ", at: 12 }),
    ].map((state) => state.startingRunId),
    ["run-b", "run-b", "run-b", "run-b"],
  );

  // リングの広がりの終端は DOM 側で受ける。演出が無いときに落としても状態は変えない
  assert.equal(chatReducer(started, { type: "startFlashEnd" }).startingRunId, undefined);
  assert.equal(chatReducer(initialChatState, { type: "startFlashEnd" }), initialChatState);
});

test("待機していない run_start では開始の合図を立てない", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "すぐ実行", at: 10 });
  const started = chatReducer(sent, { type: "runStart", runId: "run-1", prompt: "すぐ実行", at: 11, startedAt: 11 });

  assert.equal(started.startingRunId, undefined, "待機列の先頭が動いたときだけ光らせる");
});

test("run_end は残りの件数を数えず、開始の合図とその run の待機を落とす", () => {
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 1);
  const started = chatReducer(queued, {
    type: "runStart",
    runId: "run-b",
    initialSendId: "run-b",
    prompt: "待機する本文",
    at: 11,
    startedAt: 11,
  });
  const ended = chatReducer(started, {
    type: "runEnd",
    runId: "run-b",
    status: "completed",
    queueDepth: 2,
    durationMs: 1000,
  });

  assert.equal(ended.startingRunId, undefined);
  assert.equal(ended.runStatus, "queued");
  assert.equal(ended.activity, "完了", "件数は直上ブロックが正。状態行は活動の語だけ");

  // 実行されなかった待機は run_end では消さない (次の実行の開始送信になる)。停止は queue_cleared が担う
  const interrupted = chatReducer(queued, {
    type: "runEnd",
    durationMs: 1_000,
    runId: "run-b",
    status: "stopped",
    queueDepth: 0,
  });
  assert.equal(interrupted.bubbles.find((bubble) => bubble.sendId === "run-b")?.queued, true);
  const cleared = chatReducer(interrupted, { type: "queueCleared", sendIds: ["run-b"] });
  assert.equal(cleared.bubbles.find((bubble) => bubble.sendId === "run-b")?.queued, undefined);
});

test("queue_cleared は待機の表示を消し、runIds が無くても解除する", () => {
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 1);
  const cleared = chatReducer(queued, { type: "queueCleared", sendIds: ["run-b"] });
  assert.deepEqual(
    cleared.bubbles
      .filter((bubble) => bubble.runId === "run-b")
      .map((bubble) => [bubble.queued, bubble.queuePosition, bubble.unsent === true]),
    [[undefined, undefined, true]],
  );
  assert.equal(cleared.startingRunId, undefined);

  // 旧サーバー (runIds 無し) は未送信へは切り替えないが、キューは空なので待機の表示は戻す
  const legacy = chatReducer(queued, { type: "queueCleared" });
  assert.deepEqual(
    legacy.bubbles
      .filter((bubble) => bubble.runId === "run-b")
      .map((bubble) => [bubble.queued, bubble.unsent === true]),
    [[undefined, false]],
  );
});

test("queueCanceled は対象の待機だけを未送信へ戻し、他の待機を変えない", () => {
  const queued = queuedEcho(queuedEcho(historyWithOld(), "先に積む本文", "run-a", 1), "取り消す本文", "run-b", 2);
  const waiting = chatReducer(queued, { type: "queued", position: 2, queueDepth: 2 });
  const keptEchoId = waiting.bubbles.find((bubble) => bubble.runId === "run-a")?.id;
  const target = waiting.bubbles.find((bubble) => bubble.runId === "run-b");
  assert.ok(keptEchoId !== undefined && target !== undefined);
  assert.deepEqual(waiting.pendingEchoIds, [keptEchoId, target.id], "待機中のエコーは履歴への吸収を待つ");

  const canceled = chatReducer(waiting, { type: "queueCanceled", sendId: "run-b" });
  assert.deepEqual(
    canceled.bubbles.map((bubble) => [
      bubble.runId,
      bubble.queued === true,
      bubble.queuePosition,
      bubble.unsent === true,
      bubble.accepted === true,
      bubble.confirmed === true,
    ]),
    [
      ["run-old", false, undefined, false, false, false],
      ["run-a", true, 1, false, false, false],
      ["run-b", false, undefined, true, false, false],
    ],
    "取り消した送信だけが未送信になり、他の待機と順位はそのまま",
  );
  assert.deepEqual(canceled.pendingEchoIds, [keptEchoId], "未送信は吸収待ちに残さない (再送で同じ id を二重にしない)");
  assert.equal(canceled.queueDepth, 2, "件数はサーバーの payload が正で、ローカルでは減らさない");
  assert.equal(canceled.activity, waiting.activity, "成功時の文言は足さない (バブルが変わるのが結果の提示)");

  // resync が成功応答より先に届く経路がある。既に未送信なら状態を作り直さない
  assert.equal(chatReducer(canceled, { type: "queueCanceled", sendId: "run-b" }), canceled);
  assert.equal(
    chatReducer(canceled, { type: "queueCanceled", sendId: "ghost" }),
    canceled,
    "未知の run id では何もしない",
  );
});

test("resync の status === queued は件数も理由も状態行に出さず、run の実行中では開始の合図を残す", () => {
  // What: run が無くキューだけの過渡で語れる事実は直上ブロックの件数だけなので、活動の文言は空にする
  const waiting = chatReducer(historyWithOld(), { type: "resync", payload: pendingPayload([], "queued", 2) });
  assert.equal(waiting.runStatus, "queued");
  assert.equal(waiting.activity, "");

  // 開始直後の復帰。payload が同じ run の実行中を示す間は演出を残す (初回描画で消さない)
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 1);
  const started = chatReducer(queued, {
    type: "runStart",
    runId: "run-b",
    initialSendId: "run-b",
    prompt: "待機する本文",
    at: 11,
    startedAt: 11,
  });
  const sameRun = chatReducer(started, {
    type: "resync",
    payload: {
      ...pendingPayload([], "running", 0),
      // payload が同じ run を実行中として載せる (resync 経路の開始の合図)
      run: { id: "run-b", status: "running", startedAt: 11, prompt: "待機する本文", toolCalls: [], totalRetryCount: 0 },
    },
  });
  assert.equal(sameRun.startingRunId, "run-b");

  // 別の run へ移った / run が終わった復帰では残さない
  const ended = chatReducer(sameRun, { type: "resync", payload: pendingPayload([], "idle", 0) });
  assert.equal(ended.startingRunId, undefined);
});

test("pendingSends の steering は待機のまま反映中として持ち、running は待機一覧から外す", () => {
  // What: SDK が取り出した入力 (steering) は取消できず、注入済み (running) は待機に出さない
  const payload = runningPayload();
  payload.pendingSends = [
    { sendId: "send-q", text: "待機", at: 1, state: "queued", position: 1 },
    { sendId: "send-s", text: "反映中", at: 2, state: "steering", position: 2 },
    { sendId: "send-r", text: "実行中", at: 3, runId: "run-1", state: "running" },
  ];
  const state = chatReducer(initialChatState, { type: "resync", payload });
  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.sendId !== undefined)
      .map((bubble) => [bubble.sendId, bubble.queued === true, bubble.queuedState, bubble.queuePosition]),
    [
      ["send-q", true, "queued", 1],
      ["send-s", true, "steering", 2],
      ["send-r", false, undefined, undefined],
    ],
  );
});

test("要求後に新しい状態が届いた待機スナップショットは queued へ戻さない", () => {
  // What: 後着の 202 が、終端 resync で注入・保存済みになった送信を再び待機中に見せる退行を防ぐ
  // (履歴対応済みの会話では resync 後もライブのエコーを残すため、sendId の対応付けだけが残る)
  const sent = chatReducer(historyWithOld(), { type: "localUser", text: "追加入力", at: 1 });
  const requestSeq = sent.stateSeq;
  const payload = runningPayload();
  payload.status = "completed";
  payload.queueDepth = 0;
  payload.pendingSends = [];
  const ended = chatReducer(sent, { type: "resync", payload });
  assert.ok(ended.stateSeq !== requestSeq, "resync で世代が進む");

  const late = chatReducer(ended, {
    type: "echoSendId",
    sendId: "send-late",
    stateSeq: requestSeq,
    queuePosition: 1,
  });
  assert.deepEqual(
    late.bubbles
      .filter((bubble) => bubble.sendId !== undefined)
      .map((bubble) => [bubble.sendId, bubble.queued === true, bubble.queuePosition]),
    [["send-late", false, undefined]],
    "ID は対応付けるが、古い待機スナップショットは適用しない",
  );

  // 世代が一致していれば (要求後に新しい状態が届いていなければ) 待機として適用する
  const current = chatReducer(ended, {
    type: "echoSendId",
    sendId: "send-current",
    stateSeq: ended.stateSeq,
    queuePosition: 1,
  });
  assert.deepEqual(
    current.bubbles
      .filter((bubble) => bubble.sendId !== undefined)
      .map((bubble) => [bubble.sendId, bubble.queued === true, bubble.queuePosition]),
    [["send-current", true, 1]],
  );
});

test("queued が 202 応答より先に届いても、同じ送信IDの待機位置をエコーへ引き継ぐ", () => {
  // What: 送信IDの結び付く前の queued で世代が進んでも、応答が待機スナップショットを捨てない
  const sent = chatReducer(historyWithOld(), { type: "localUser", text: "待機する本文", at: 1 });
  const requestSeq = sent.stateSeq;
  const queued = chatReducer(sent, { type: "queued", sendId: "send-1", position: 1, queueDepth: 1 });
  const echoed = chatReducer(queued, {
    type: "echoSendId",
    sendId: "send-1",
    stateSeq: requestSeq,
    queuePosition: 1,
  });

  assert.deepEqual(
    queuedSendsOf(echoed.bubbles).map((send) => [send.sendId, send.text, send.state, send.index]),
    [["send-1", "待機する本文", "queued", undefined]],
    "待機 1 件・順位 1 として取消の対象になる",
  );
  assert.equal(echoed.queueDepth, 1);
  assert.equal(
    chatRenderItems({ bubbles: echoed.bubbles, markers: [], compactions: [], activeContextStartId: null }).some(
      (item) => item.kind === "message" && item.bubble.text === "待機する本文",
    ),
    false,
    "待機中は transcript に出さない",
  );
  assert.equal(echoed.queuedSnapshots["send-1"], undefined, "引き継いだスナップショットは残さない");
});

test("echo が queued より先でも最終状態は同じで、同じ送信IDの queued を重複させない", () => {
  // What: 応答→queued の順と、queued が 2 回届く経路でも待機表示が 1 件に収まる
  const sent = chatReducer(historyWithOld(), { type: "localUser", text: "待機する本文", at: 1 });
  const echoed = chatReducer(sent, {
    type: "echoSendId",
    sendId: "send-1",
    stateSeq: sent.stateSeq,
    queuePosition: 1,
  });
  const queued = chatReducer(echoed, { type: "queued", sendId: "send-1", position: 1, queueDepth: 1 });
  const duplicated = chatReducer(queued, { type: "queued", sendId: "send-1", position: 1, queueDepth: 1 });

  assert.deepEqual(
    queuedSendsOf(duplicated.bubbles).map((send) => [send.sendId, send.state, send.index]),
    [["send-1", "queued", undefined]],
  );
  assert.equal(duplicated.bubbles.filter((bubble) => bubble.sendId === "send-1").length, 1);
  assert.equal(duplicated.queueDepth, 1, "件数は累積しない");
  assert.equal(duplicated.queuedSnapshots["send-1"], undefined, "結び付いた後はスナップショットを持たない");
});

test("送信IDが結び付く前の queued も、注入・保存を示す新しい resync で捨てる", () => {
  // What: 先行した待機イベントが、その後の注入・保存を巻き戻さない (前回の後着 202 と同方向)
  const sent = chatReducer(historyWithOld(), { type: "localUser", text: "待機する本文", at: 1 });
  const requestSeq = sent.stateSeq;
  const queued = chatReducer(sent, { type: "queued", sendId: "send-1", position: 1, queueDepth: 1 });

  const payload = runningPayload();
  payload.status = "running";
  payload.queueDepth = 0;
  payload.pendingSends = [];
  const injected = chatReducer(queued, { type: "resync", payload });
  assert.equal(injected.queuedSnapshots["send-1"], undefined, "resync が待機を否定したら捨てる");

  const late = chatReducer(injected, {
    type: "echoSendId",
    sendId: "send-1",
    stateSeq: requestSeq,
    queuePosition: 1,
  });
  assert.deepEqual(queuedSendsOf(late.bubbles), [], "古い待機スナップショットで queued に戻さない");
  assert.equal(late.bubbles.find((bubble) => bubble.sendId === "send-1")?.queued, undefined);
});
