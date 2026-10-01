// 左バーのセッション行の表示導出 (live / 未見 / idle) と、既読 (seen) の run id ストア。
// client に DOM テスト基盤が無いため、分岐の組み合わせと保存値の扱いを純関数 + MemoryStorage で
// 網羅し、配線は client/test/sidebarStatusWiring.test.ts がソース走査で固定する。
//   1. 優先順位は live > 未見 > idle。queued は running へ畳み、compacting だけ別のラベルにする
//   2. 未見は seen だけを正とする (status からは推測しない)。再起動後に status が idle へ戻っても
//      lastRun から未見が出る
//   3. mark は保存値を読み直してから和集合で書く (read-modify-write)。2 タブが別々の会話を
//      既読にしても片方が落ちない
//   4. storage イベントは合流のみ。key === null (clear) / newValue === null (removeItem) /
//      別キーでは状態を変えない
//   5. 保存領域が使えない環境はメモリだけへフォールバックし、操作を止めない
import assert from "node:assert/strict";
import test from "node:test";
import {
  applySeenStorageEvent,
  createSeenRunsStore,
  decodeSeenRuns,
  encodeSeenRuns,
  endedRunId,
  isRunSeen,
  mergeSeenRuns,
  SEEN_RUNS_KEY,
  SEEN_RUNS_PER_SESSION_LIMIT,
  SEEN_RUNS_SESSION_LIMIT,
  SEEN_RUNS_VERSION,
  sidebarStatus,
  type SeenRuns,
  type SeenRunsEventTarget,
  type SeenRunsStorage,
  type SeenStorageEvent,
} from "../src/lib/sidebarStatus";
import type { SessionSummary } from "../src/types";

const IDLE = { word: "", label: "", tone: "idle" } as const;

function row(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s-1",
    title: "テスト",
    agentId: "agent-general",
    status: "idle",
    queueDepth: 0,
    messageCount: 2,
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  };
}

function lastRun(id: string, status: "completed" | "stopped" | "error" = "completed") {
  return { id, status, endedAt: 1 };
}

/** localStorage の代わり。getItem / setItem だけを使う (キーの削除はしない) */
class MemoryStorage implements SeenRunsStorage {
  value: string | null = null;
  writes = 0;

  getItem(): string | null {
    return this.value;
  }

  setItem(_key: string, next: string): void {
    this.value = next;
    this.writes += 1;
  }
}

/**
 * read と write の間に別タブの write を差し込む MemoryStorage。Web Storage には
 * read-modify-write の排他が無いため、getItem が返す値を確定してから `interleave` を呼ぶ
 */
class RacyStorage implements SeenRunsStorage {
  value: string | null = null;
  interleave?: () => void;

  getItem(): string | null {
    const value = this.value;
    const interleave = this.interleave;
    this.interleave = undefined;
    interleave?.();
    return value;
  }

  setItem(_key: string, next: string): void {
    this.value = next;
  }
}

/** window の代わり。storage イベントを手で配る */
class MemoryEvents implements SeenRunsEventTarget {
  listeners = new Set<(event: SeenStorageEvent) => void>();

  addEventListener(_type: "storage", listener: (event: SeenStorageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "storage", listener: (event: SeenStorageEvent) => void): void {
    this.listeners.delete(listener);
  }

  emit(event: SeenStorageEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

test("保存キー・version・上限は export 定数で固定する", () => {
  assert.equal(SEEN_RUNS_KEY, "u7agent-seen-runs");
  assert.equal(SEEN_RUNS_VERSION, 1);
  assert.equal(SEEN_RUNS_PER_SESSION_LIMIT, 8);
  assert.equal(SEEN_RUNS_SESSION_LIMIT, 500);
});

test("live は seen より優先し、queued は実行中へ畳む", () => {
  const seen: SeenRuns = new Map([["s-1", ["run-1"]]]);
  assert.deepEqual(sidebarStatus(row({ status: "running" }), seen), {
    word: "running",
    label: "実行中",
    tone: "accent",
  });
  assert.deepEqual(sidebarStatus(row({ status: "queued" }), seen), {
    word: "running",
    label: "実行中",
    tone: "accent",
  });
  assert.deepEqual(sidebarStatus(row({ status: "compacting" }), seen), {
    word: "compacting",
    label: "圧縮中",
    tone: "accent",
  });
  // 未見の結果を持っていても、実行中の行は live を出す (優先順位は live > 未見)
  const running = row({ status: "running", lastRun: lastRun("run-2", "error") });
  assert.equal(sidebarStatus(running, new Map()).word, "running");
});

test("終端は seen に無いときだけ未見で出し、lastRun の status を使う", () => {
  assert.deepEqual(sidebarStatus(row({ status: "completed", lastRun: lastRun("run-1") }), new Map()), {
    word: "completed",
    label: "完了",
    tone: "ok",
  });
  assert.deepEqual(sidebarStatus(row({ status: "stopped", lastRun: lastRun("run-1", "stopped") }), new Map()), {
    word: "stopped",
    label: "停止",
    tone: "warn",
  });
  assert.deepEqual(sidebarStatus(row({ status: "error", lastRun: lastRun("run-1", "error") }), new Map()), {
    word: "error",
    label: "エラー",
    tone: "danger",
  });
});

test("既読 / lastRun 無し / 別会話の既読は未見にしない", () => {
  const completed = row({ status: "completed", lastRun: lastRun("run-1") });
  assert.deepEqual(sidebarStatus(completed, new Map([["s-1", ["run-1"]]])), IDLE, "既読の run を未見にしている");
  assert.deepEqual(sidebarStatus(row({ status: "completed" }), new Map()), IDLE, "lastRun 無しを未見にしている");
  assert.deepEqual(sidebarStatus(row({ status: "idle" }), new Map()), IDLE);
  assert.equal(
    sidebarStatus(completed, new Map([["s-2", ["run-1"]]])).word,
    "completed",
    "別の会話の既読で未見が消えている",
  );
  assert.equal(isRunSeen(new Map([["s-1", ["run-1"]]]), "s-1", "run-2"), false);
  assert.equal(isRunSeen(new Map([["s-1", ["run-1"]]]), "s-1", undefined), false);
});

test("再起動で status が idle に戻っても lastRun から未見が出る", () => {
  // SWEEP / 再起動後はサーバーが status: "idle" + meta.lastRun を返す
  const restored = row({ status: "idle", lastRun: lastRun("run-1", "error") });
  assert.deepEqual(sidebarStatus(restored, new Map([["s-1", ["run-0"]]])), {
    word: "error",
    label: "エラー",
    tone: "danger",
  });
  // 新しい run が始まれば live が勝ち、終わって見た後にまた未見へ戻らない
  assert.equal(sidebarStatus(row({ status: "running", lastRun: lastRun("run-0") }), new Map()).word, "running");
});

test("既読にしてよい run は終端のときだけ", () => {
  assert.equal(endedRunId({ id: "run-1", status: "completed" }), "run-1");
  assert.equal(endedRunId({ id: "run-1", status: "stopped" }), "run-1");
  assert.equal(endedRunId({ id: "run-1", status: "error" }), "run-1");
  // 実行中は未確定なので既読にしない
  assert.equal(endedRunId({ id: "run-1", status: "running" }), undefined);
  assert.equal(endedRunId({ id: "run-1", status: "queued" }), undefined);
  assert.equal(endedRunId({ id: "run-1", status: "idle" }), undefined);
  assert.equal(endedRunId(null), undefined);
  assert.equal(endedRunId(undefined), undefined);
});

test("encode / decode は会話 id と run id の並びを往復し、壊れた値は 1 件ずつ落とす", () => {
  const state: SeenRuns = new Map([
    ["s-1", ["run-1", "run-2"]],
    ["s-2", ["run-3"]],
  ]);
  assert.deepEqual(decodeSeenRuns(encodeSeenRuns(state)), state);
  assert.equal(
    encodeSeenRuns(state),
    JSON.stringify({
      version: SEEN_RUNS_VERSION,
      sessions: [
        { sessionId: "s-1", runIds: ["run-1", "run-2"] },
        { sessionId: "s-2", runIds: ["run-3"] },
      ],
    }),
    "保存する形 (version 付き) が変わっている",
  );
  // 保存値が無い / 空 / JSON が壊れている / version が無い・違う / sessions が配列でない
  assert.deepEqual(decodeSeenRuns(null), new Map());
  assert.deepEqual(decodeSeenRuns(""), new Map());
  assert.deepEqual(decodeSeenRuns("{"), new Map());
  assert.deepEqual(decodeSeenRuns(JSON.stringify({ sessions: [] })), new Map());
  assert.deepEqual(decodeSeenRuns(JSON.stringify({ version: SEEN_RUNS_VERSION + 1, sessions: [] })), new Map());
  assert.deepEqual(decodeSeenRuns(JSON.stringify({ version: SEEN_RUNS_VERSION, sessions: {} })), new Map());
  // 会話ごとの形 / 非文字列・空文字・重複の run id は 1 件ずつ落とす
  const mixed = JSON.stringify({
    version: SEEN_RUNS_VERSION,
    sessions: [
      { sessionId: "s-1", runIds: ["run-1", 1, "", null, "run-1", "run-2"] },
      { sessionId: "", runIds: ["run-3"] },
      { sessionId: "s-2", runIds: [] },
      "x",
      { sessionId: "s-1", runIds: ["run-9"] },
    ],
  });
  assert.deepEqual(decodeSeenRuns(mixed), new Map([["s-1", ["run-1", "run-2"]]]));
});

test("会話あたり 8 件 / 全体 500 件で古い方から落とす", () => {
  const storage = new MemoryStorage();
  const store = createSeenRunsStore(storage, null);
  const runs = Array.from({ length: SEEN_RUNS_PER_SESSION_LIMIT + 3 }, (_, index) => `run-${index}`);
  for (const runId of runs) store.mark("s-1", runId);
  assert.deepEqual(store.snapshot().get("s-1"), runs.slice(-SEEN_RUNS_PER_SESSION_LIMIT));

  // 会話の上限は「最近既読にした会話を残す」(更新した会話は末尾へ移る)
  const many = createSeenRunsStore(new MemoryStorage(), null);
  for (let index = 0; index < SEEN_RUNS_SESSION_LIMIT + 1; index++) many.mark(`s-${index}`, "run-1");
  assert.equal(many.snapshot().has("s-0"), false, "最も古い会話が残っている");
  assert.deepEqual(many.snapshot().get("s-500"), ["run-1"]);
  many.mark("s-2", "run-2");
  many.mark("s-999", "run-1");
  const snapshot = many.snapshot();
  assert.equal(snapshot.size, SEEN_RUNS_SESSION_LIMIT);
  assert.deepEqual(snapshot.get("s-2"), ["run-1", "run-2"], "既読にし直した会話が落ちている");
  assert.deepEqual(snapshot.get("s-999"), ["run-1"]);
  assert.equal(snapshot.has("s-1"), false, "更新していない古い会話が残っている");
  // 読み込み側も上限を守る (手で書いた保存値で無制限に増やさない)
  const oversized = new Map(
    Array.from({ length: SEEN_RUNS_SESSION_LIMIT + 5 }, (_, index) => [`s-${index}`, ["run-1"]] as const),
  );
  assert.equal(decodeSeenRuns(encodeSeenRuns(oversized)).size, SEEN_RUNS_SESSION_LIMIT);
});

test("mark は保存値へ和集合で書き、既読の run では書かない", () => {
  const storage = new MemoryStorage();
  const store = createSeenRunsStore(storage, null);
  store.mark("s-1", "run-1");
  assert.deepEqual(decodeSeenRuns(storage.value).get("s-1"), ["run-1"]);
  assert.equal(storage.writes, 1);
  store.mark("s-1", "run-1");
  assert.equal(storage.writes, 1, "既読の run を書き直している");
  // 空の会話 id / run id は無視する
  store.mark("", "run-1");
  store.mark("s-1", undefined);
  store.mark("s-1", "");
  assert.equal(storage.writes, 1);
  assert.deepEqual(store.snapshot().get("s-1"), ["run-1"]);
});

test("mark は保存値を読み直してから合流する (2 タブが別々の会話を既読にしても片方が落ちない)", () => {
  const storage = new MemoryStorage();
  const tabA = createSeenRunsStore(storage, null);
  const tabB = createSeenRunsStore(storage, null);
  // B が先に書いた後、A は自分のメモリ (古い保存値) をそのまま上書きしない
  tabB.mark("s-y", "run-y");
  tabA.mark("s-x", "run-x");
  const stored = decodeSeenRuns(storage.value);
  assert.deepEqual(stored.get("s-x"), ["run-x"]);
  assert.deepEqual(stored.get("s-y"), ["run-y"]);
  // A の snapshot も保存値の既読を含む (合流)
  assert.deepEqual(tabA.snapshot().get("s-y"), ["run-y"]);
  assert.equal(storage.writes, 2);
});

test("storage イベントは合流のみで、別キー / clear / removeItem では状態を変えない", () => {
  const state: SeenRuns = new Map([["s-1", ["run-1"]]]);
  const applied = applySeenStorageEvent(state, {
    key: SEEN_RUNS_KEY,
    newValue: encodeSeenRuns(new Map([["s-2", ["run-2"]]])),
  });
  assert.deepEqual(applied.get("s-1"), ["run-1"], "置換して手元の既読を消している");
  assert.deepEqual(applied.get("s-2"), ["run-2"], "別タブの既読を取り込んでいない");
  // 取り込む値が無い / 関係ないイベントは同じ参照を返す (再描画と書き込みを起こさない)
  for (const event of [
    { key: "other", newValue: encodeSeenRuns(new Map([["s-3", ["run-3"]]])) },
    { key: null, newValue: null },
    { key: SEEN_RUNS_KEY, newValue: null },
  ]) {
    assert.equal(applySeenStorageEvent(state, event), state, `${JSON.stringify(event)} で状態を作り直している`);
  }
  assert.deepEqual(applySeenStorageEvent(state, { key: SEEN_RUNS_KEY, newValue: "{" }), state);
});

test("storage イベントの購読は最初の購読者で張り、最後の解除で外す", () => {
  const events = new MemoryEvents();
  const store = createSeenRunsStore(new MemoryStorage(), events);
  const notified: number[] = [];
  const unsubscribeA = store.subscribe(() => notified.push(store.snapshot().size));
  assert.equal(events.listeners.size, 1);
  const unsubscribeB = store.subscribe(() => {});
  assert.equal(events.listeners.size, 1, "購読者ごとに listener を張っている");
  store.mark("s-1", "run-1");
  events.emit({ key: SEEN_RUNS_KEY, newValue: encodeSeenRuns(new Map([["s-2", ["run-2"]]])) });
  assert.deepEqual(store.snapshot().get("s-2"), ["run-2"]);
  // 同じように見えるイベント (取り込む値が無い) では通知しない
  const notifiedAt = notified.length;
  events.emit({ key: "other", newValue: null });
  assert.equal(notified.length, notifiedAt, "取り込む値が無いイベントで再描画している");
  unsubscribeA();
  assert.equal(events.listeners.size, 1, "購読者が残っているのに listener を外している");
  unsubscribeB();
  assert.equal(events.listeners.size, 0, "最後の購読解除で listener を外していない");
});

test("2 タブの write が重なっても、合流した既読が保存値へ収束する (リロードで戻らない)", () => {
  const storage = new RacyStorage();
  const events = new MemoryEvents();
  const tabA = createSeenRunsStore(storage, events);
  const tabB = createSeenRunsStore(storage, events);
  const unsubA = tabA.subscribe(() => {});
  const unsubB = tabB.subscribe(() => {});
  // 両タブが空の保存値を読む
  assert.deepEqual(tabA.snapshot(), new Map());
  assert.deepEqual(tabB.snapshot(), new Map());
  // A の read と write の間に B の write (Y) を挟む = 後勝ちで保存値は A の X だけになる
  storage.interleave = () => {
    tabB.mark("s-y", "run-y");
  };
  tabA.mark("s-x", "run-x");
  assert.equal(decodeSeenRuns(storage.value).has("s-y"), false, "前提: 競合で保存値から Y が落ちている");
  // 遅れて届いた B の write をイベントで取り込み、合流結果を保存値へ収束させる
  events.emit({ key: SEEN_RUNS_KEY, newValue: encodeSeenRuns(new Map([["s-y", ["run-y"]]])) });
  const reloaded = createSeenRunsStore(storage, null).snapshot();
  assert.deepEqual(reloaded.get("s-x"), ["run-x"]);
  assert.deepEqual(reloaded.get("s-y"), ["run-y"], "リロードで Y のバッジが復活する");
  unsubA();
  unsubB();
});

test("storage イベントで取り込んだ既読も保存値へ収束する (競合した write の修復)", () => {
  const storage = new MemoryStorage();
  const events = new MemoryEvents();
  const tab = createSeenRunsStore(storage, events);
  tab.subscribe(() => {});
  // このタブは X を既読にして保存値にも X がある
  tab.mark("s-x", "run-x");
  assert.equal(decodeSeenRuns(storage.value).has("s-y"), false);
  // 競合した write で保存値から落ちていた他タブの既読 (Y) が storage イベントで届く。
  // メモリだけでなく保存値も合流結果へ直さないと、リロードで Y のバッジが戻る
  events.emit({ key: SEEN_RUNS_KEY, newValue: encodeSeenRuns(new Map([["s-y", ["run-y"]]])) });
  assert.deepEqual(tab.snapshot().get("s-y"), ["run-y"]);
  const stored = decodeSeenRuns(storage.value);
  assert.deepEqual(stored.get("s-x"), ["run-x"]);
  assert.deepEqual(stored.get("s-y"), ["run-y"], "取り込んだ既読が保存値へ書かれていない");
});

test("購読を張り直すと、外れている間の別タブの既読を取り込む (ドロワーを閉じた間)", () => {
  const storage = new MemoryStorage();
  const events = new MemoryEvents();
  const sidebar = createSeenRunsStore(storage, events);
  const other = createSeenRunsStore(storage, null);
  const unsubscribe = sidebar.subscribe(() => {});
  assert.equal(events.listeners.size, 1);
  // React は描画で snapshot を読むため、購読中にメモリが初始化されている
  assert.deepEqual(sidebar.snapshot(), new Map());
  // overlay 配置ではドロワーを閉じると Sidebar が unmount し、最後の購読解除で listener も外れる
  unsubscribe();
  assert.equal(events.listeners.size, 0);
  // その間の別タブの既読は storage イベントを受け取れない
  other.mark("s-x", "run-x");
  // 再購読では listener を張り直すだけでなく、保存値を読み直して合流する
  const resubscribe = sidebar.subscribe(() => {});
  assert.deepEqual(sidebar.snapshot().get("s-x"), ["run-x"]);
  assert.equal(events.listeners.size, 1, "listener を張り直していない");
  resubscribe();
});

test("保存領域が使えない環境はメモリだけへフォールバックする", () => {
  const store = createSeenRunsStore(null, null);
  store.mark("s-1", "run-1");
  assert.deepEqual(store.snapshot().get("s-1"), ["run-1"], "保存領域が無いとメモリにも残らない");
  // localStorage の accessor / 読み書きが例外になる環境でも操作を止めない
  const denied: SeenRunsStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  const deniedStore = createSeenRunsStore(denied, null);
  deniedStore.mark("s-1", "run-1");
  deniedStore.mark("s-1", "run-2");
  assert.deepEqual(deniedStore.snapshot().get("s-1"), ["run-1", "run-2"]);
});

test("mergeSeenRuns は既読が増えないとき同じ参照を返す", () => {
  const state: SeenRuns = new Map([["s-1", ["run-1"]]]);
  assert.equal(mergeSeenRuns(state, new Map([["s-1", ["run-1"]]])), state);
  assert.equal(mergeSeenRuns(state, new Map()), state);
  // 空文字の会話 id は無視する
  assert.equal(mergeSeenRuns(state, new Map([["", ["run-2"]]])), state);
  assert.deepEqual(mergeSeenRuns(state, new Map([["s-1", ["run-2"]]])).get("s-1"), ["run-1", "run-2"]);
});
