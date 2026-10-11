import assert from "node:assert/strict";

import test from "node:test";
import type { FileRefTarget } from "../src/lib/fileRef";
import { createFileRefOpener, type FileRefCheck } from "../src/lib/fileRefOpen";
import {
  createFileRefRequests,
  DEFAULT_FILES_MODE,
  fileRefRequestForKind,
  fileRefRequestForSession,
  filesModeForTarget,
  filesModeScopeChanged,
  type FilesMode,
  type FilesModeScope,
} from "../src/lib/fileRefRequest";

const work = (path: string): FileRefTarget => ({ kind: "work", path });
const skill = (name: string, path: string): FileRefTarget => ({ kind: "skill", root: `.agents/skills/${name}`, path });

test("未消費の要求は 1 件だけで、新しい要求が最新優先で残る", () => {
  const store = createFileRefRequests();
  assert.equal(store.snapshot(), null);
  store.request("a", work("index.html"));
  const first = store.snapshot();
  assert.deepEqual(first, { seq: 1, sessionId: "a", kind: "work", path: "index.html" });
  store.request("a", work("nested/a.png"));
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "a", kind: "work", path: "nested/a.png" });
  assert.ok((store.snapshot()?.seq ?? 0) > (first?.seq ?? 0), "seq が進んでいない");
});

test("要求は面の種別を持ち、スキル面は root も持つ", () => {
  const store = createFileRefRequests();
  store.request("a", skill("alpha", "assets/a.png"));
  assert.deepEqual(store.snapshot(), {
    seq: 1,
    sessionId: "a",
    kind: "skill",
    root: ".agents/skills/alpha",
    path: "assets/a.png",
  });
  // 作業フォルダ面は root を持たない (面の座標は cwd 相対だけ)
  store.request("a", work("SKILL.md"));
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "a", kind: "work", path: "SKILL.md" });
});

test("面ごとの消費可否: 自分宛ての種別の要求だけを渡す", () => {
  const store = createFileRefRequests();
  store.request("a", skill("alpha", "SKILL.md"));
  assert.equal(fileRefRequestForKind(store.snapshot(), "work"), null, "作業フォルダ面がスキル要求を消費した");
  assert.deepEqual(fileRefRequestForKind(store.snapshot(), "skill"), store.snapshot());
  assert.equal(fileRefRequestForKind(null, "work"), null);
  store.request("a", work("index.html"));
  assert.equal(fileRefRequestForKind(store.snapshot(), "skill"), null, "スキル面が作業フォルダの要求を消費した");
  assert.deepEqual(fileRefRequestForKind(store.snapshot(), "work"), store.snapshot());
  assert.equal(fileRefRequestForKind(null, "work"), null);
});

test("ack は現在の要求と seq が一致するときだけ消す (request1 → request2 → ack1)", () => {
  const store = createFileRefRequests();
  store.request("a", work("index.html"));
  store.request("a", work("nested/a.png"));
  store.ack(1);
  assert.deepEqual(
    store.snapshot(),
    { seq: 2, sessionId: "a", kind: "work", path: "nested/a.png" },
    "古い ack で消えた",
  );
  store.ack(2);
  assert.equal(store.snapshot(), null);
});

test("選択変更で破棄した後は、同じセッションに戻っても復活しない", () => {
  const store = createFileRefRequests();
  store.request("a", work("index.html"));
  store.clear();
  assert.equal(fileRefRequestForSession(store.snapshot(), "a"), null);
});

test("切替後に旧 ack が来ても新しい要求を消さない", () => {
  const store = createFileRefRequests();
  store.request("a", work("index.html"));
  store.clear();
  store.request("b", work("b.png"));
  store.ack(1);
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "b", kind: "work", path: "b.png" });
});

test("sessionId が一致するときだけ子へ渡す", () => {
  const store = createFileRefRequests();
  store.request("a", work("index.html"));
  assert.deepEqual(fileRefRequestForSession(store.snapshot(), "a"), store.snapshot());
  assert.equal(fileRefRequestForSession(store.snapshot(), "b"), null);
  assert.equal(fileRefRequestForSession(null, "a"), null);
});

test("セッション未確定 (sessionId が空) の要求は捨てる", () => {
  const store = createFileRefRequests();
  store.request("", work("index.html"));
  assert.equal(store.snapshot(), null);
  store.request("", skill("alpha", "SKILL.md"));
  assert.equal(store.snapshot(), null);
});

test("購読は変更のたびに届き、解除後は届かない", () => {
  const store = createFileRefRequests();
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  store.request("a", work("index.html"));
  store.ack(1);
  store.clear();
  assert.equal(notified, 2, "request と ack の両方で通知されていない");
  unsubscribe();
  store.request("a", work("b.png"));
  assert.equal(notified, 2);
});

test("面のモードは要求の種別で決まり、閉じた後は既定へ戻る", () => {
  assert.deepEqual(filesModeForTarget(work("index.html")), { kind: "work" });
  assert.deepEqual(filesModeForTarget(skill("alpha", "SKILL.md")), { kind: "skill", root: ".agents/skills/alpha" });
  // 逆向きの参照はモードを切り替えてから消費する (消費されない要求を残さない)
  assert.deepEqual(filesModeForTarget(skill("beta", "notes.md")), { kind: "skill", root: ".agents/skills/beta" });
  assert.deepEqual(DEFAULT_FILES_MODE, { kind: "work" });
});

test("面のモードを既定へ戻す契機は、セッション切替 / 画面の移動 / layout の切替", () => {
  const base: FilesModeScope = { compact: false, view: "chat", sessionId: "a" };
  assert.equal(filesModeScopeChanged(base, { ...base }), false, "同じ契機で戻している");
  // 同一プロジェクトのセッション切替 (cwd が同じ) と新規チャットは sessionId で拾う
  assert.equal(filesModeScopeChanged(base, { ...base, sessionId: "b" }), true);
  assert.equal(filesModeScopeChanged(base, { ...base, sessionId: "" }), true);
  assert.equal(filesModeScopeChanged(base, { ...base, view: "settings" }), true);
  assert.equal(filesModeScopeChanged(base, { ...base, compact: true }), true);
});

/**
 * クリック → 確認 → 面を開く、の順序を見る小さなハーネス。確認はテストが手動で完了させ、面のモードは
 * App と同じ filesModeForTarget、要求は実物の store へ入れる (確認が完了するまでどちらも動かさない)。
 */
function createClickFlow() {
  const store = createFileRefRequests();
  const opened: FileRefTarget[] = [];
  /** 飛んでいる確認。同じ参照への連続クリックで打ち消し合わないよう、到着順に積む */
  const checks: Array<{ target: FileRefTarget; resolve: (result: FileRefCheck) => void }> = [];
  let mode: FilesMode = DEFAULT_FILES_MODE;
  let session = "a";
  const opener = createFileRefOpener({
    check: (target) =>
      new Promise<FileRefCheck>((resolve) => {
        checks.push({ target, resolve });
      }),
    open: (target) => {
      opened.push(target);
      mode = filesModeForTarget(target);
      store.request(session, target);
    },
    sessionId: () => session,
  });
  return {
    /** クリック 1 回。結果は戻り値の Promise で見る */
    click: (target: FileRefTarget) => opener.open(target),
    /** その参照への一番古い飛んでいる確認を完了させる (遅い応答の逆転を作る) */
    answer: (target: FileRefTarget, result: FileRefCheck) => {
      const index = checks.findIndex((check) => check.target === target);
      assert.notEqual(index, -1, `${target.path} の確認が飛んでいない`);
      const [check] = checks.splice(index, 1);
      check?.resolve(result);
    },
    opened,
    snapshot: () => store.snapshot(),
    mode: () => mode,
    switchSession: (next: string) => {
      session = next;
    },
  };
}

test("クリック: 実在を確認できた参照だけを要求として登録し、面のモードもその種別にする", async () => {
  const flow = createClickFlow();
  const target = skill("alpha", "SKILL.md");
  const click = flow.click(target);
  assert.deepEqual(flow.opened, [], "確認の完了前に面を開いている");
  assert.equal(flow.snapshot(), null);
  flow.answer(target, "exists");
  assert.deepEqual(await click, { kind: "opened" });
  assert.deepEqual(flow.opened, [target]);
  assert.deepEqual(flow.mode(), { kind: "skill", root: ".agents/skills/alpha" });
  assert.deepEqual(flow.snapshot(), {
    seq: 1,
    sessionId: "a",
    kind: "skill",
    root: ".agents/skills/alpha",
    path: "SKILL.md",
  });
});

test("クリック: A→B と続けたら最後のクリックだけが開く", async () => {
  const flow = createClickFlow();
  const a = work("a.txt");
  const b = work("b/c.png");
  const first = flow.click(a);
  const second = flow.click(b);
  // 先のクリックの確認が遅れて届いても、後から押した参照の結果だけを適用する
  flow.answer(a, "exists");
  assert.deepEqual(await first, { kind: "discarded" });
  assert.deepEqual(flow.opened, []);
  assert.equal(flow.snapshot(), null);
  flow.answer(b, "exists");
  assert.deepEqual(await second, { kind: "opened" });
  assert.deepEqual(flow.opened, [b]);
  assert.deepEqual(flow.snapshot(), { seq: 1, sessionId: "a", kind: "work", path: "b/c.png" });
});

test("クリック: A→B→A と戻っても最後のクリックの参照だけが開く", async () => {
  const flow = createClickFlow();
  const a = work("a.txt");
  const b = work("b.txt");
  const first = flow.click(a);
  const second = flow.click(b);
  const third = flow.click(a);
  flow.answer(a, "exists");
  assert.deepEqual(await first, { kind: "discarded" }, "1 回目の A が開いている");
  flow.answer(b, "exists");
  assert.deepEqual(await second, { kind: "discarded" }, "B が開いている");
  assert.deepEqual(flow.opened, []);
  assert.equal(flow.snapshot(), null);
  flow.answer(a, "exists");
  assert.deepEqual(await third, { kind: "opened" }, "最後のクリックが開いていない");
  assert.deepEqual(flow.opened, [a]);
  assert.deepEqual(flow.snapshot(), { seq: 1, sessionId: "a", kind: "work", path: "a.txt" });
});

test("クリック: 確認中にセッションが切り替わった結果は失効する", async () => {
  const flow = createClickFlow();
  const target = work("a.txt");
  const click = flow.click(target);
  flow.switchSession("b");
  flow.answer(target, "exists");
  assert.deepEqual(await click, { kind: "discarded" });
  // 遅い結果を新しいセッションの要求として登録しない (面のモードも動かさない)
  assert.deepEqual(flow.opened, []);
  assert.equal(flow.snapshot(), null);
  assert.deepEqual(flow.mode(), DEFAULT_FILES_MODE);
});

test("クリック: 不存在と分かった参照は要求を登録せず、開いている面のモードと要求も変えない", async () => {
  const flow = createClickFlow();
  const opened = skill("alpha", "SKILL.md");
  const first = flow.click(opened);
  flow.answer(opened, "exists");
  await first;
  assert.deepEqual(flow.mode(), { kind: "skill", root: ".agents/skills/alpha" });

  const missing = work("gone.md");
  const second = flow.click(missing);
  flow.answer(missing, "missing");
  assert.deepEqual(await second, { kind: "failed", message: "ファイルが見つかりません" });
  assert.deepEqual(flow.opened, [opened], "不存在の参照で面を開いている");
  assert.deepEqual(flow.mode(), { kind: "skill", root: ".agents/skills/alpha" }, "不存在でモードが変わっている");
  assert.deepEqual(
    flow.snapshot(),
    { seq: 1, sessionId: "a", kind: "skill", root: ".agents/skills/alpha", path: "SKILL.md" },
    "不存在で既存の要求が入れ替わっている",
  );
});

test("クリック: 拒否 (400) と確認不能 (502 / 503) は不存在と区別して開かない", async () => {
  const cases: [FileRefCheck, string][] = [
    ["refused", "このパスは開けません"],
    ["unavailable", "ファイルを確認できませんでした。もう一度お試しください"],
  ];
  for (const [result, message] of cases) {
    const flow = createClickFlow();
    const target = work("a.txt");
    const click = flow.click(target);
    flow.answer(target, result);
    assert.deepEqual(await click, { kind: "failed", message }, result);
    assert.deepEqual(flow.opened, [], result);
    assert.equal(flow.snapshot(), null, result);
  }
});
