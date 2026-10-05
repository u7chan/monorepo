import assert from "node:assert/strict";

import test from "node:test";
import type { FileRefTarget } from "../src/lib/fileRef";
import {
  createFileRefRequests,
  DEFAULT_FILES_MODE,
  fileRefRequestForKind,
  fileRefRequestForSession,
  filesModeForTarget,
  filesModeScopeChanged,
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
