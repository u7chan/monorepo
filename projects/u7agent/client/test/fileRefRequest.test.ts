// ファイル参照の要求管理。client に DOM テスト基盤が無いため、store と純関数を直接検証し、
// useSessions / App / FileBrowser への配線 (選択変更での破棄、seq ガード、ack) はソース走査で固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFileRefRequests, fileRefRequestForSession } from "../src/lib/fileRefRequest";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("未消費の要求は 1 件だけで、新しい要求が最新優先で残る", () => {
  const store = createFileRefRequests();
  assert.equal(store.snapshot(), null);
  store.request("a", "index.html");
  const first = store.snapshot();
  assert.deepEqual(first, { seq: 1, sessionId: "a", path: "index.html" });
  store.request("a", "nested/a.png");
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "a", path: "nested/a.png" });
  assert.ok((store.snapshot()?.seq ?? 0) > (first?.seq ?? 0), "seq が進んでいない");
});

test("ack は現在の要求と seq が一致するときだけ消す (request1 → request2 → ack1)", () => {
  const store = createFileRefRequests();
  store.request("a", "index.html");
  store.request("a", "nested/a.png");
  store.ack(1);
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "a", path: "nested/a.png" }, "古い ack で消えた");
  store.ack(2);
  assert.equal(store.snapshot(), null);
});

test("選択変更で破棄した後は、同じセッションに戻っても復活しない", () => {
  const store = createFileRefRequests();
  store.request("a", "index.html");
  store.clear();
  assert.equal(fileRefRequestForSession(store.snapshot(), "a"), null);
});

test("切替後に旧 ack が来ても新しい要求を消さない", () => {
  const store = createFileRefRequests();
  store.request("a", "index.html");
  store.clear();
  store.request("b", "b.png");
  store.ack(1);
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "b", path: "b.png" });
});

test("sessionId が一致するときだけ子へ渡す", () => {
  const store = createFileRefRequests();
  store.request("a", "index.html");
  assert.deepEqual(fileRefRequestForSession(store.snapshot(), "a"), store.snapshot());
  assert.equal(fileRefRequestForSession(store.snapshot(), "b"), null);
  assert.equal(fileRefRequestForSession(null, "a"), null);
});

test("セッション未確定 (sessionId が空) の要求は捨てる", () => {
  const store = createFileRefRequests();
  store.request("", "index.html");
  assert.equal(store.snapshot(), null);
});

test("購読は変更のたびに届き、解除後は届かない", () => {
  const store = createFileRefRequests();
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  store.request("a", "index.html");
  store.ack(1);
  store.clear();
  assert.equal(notified, 2, "request と ack の両方で通知されていない");
  unsubscribe();
  store.request("a", "b.png");
  assert.equal(notified, 2);
});

test("配線: 選択が変わる経路 (selectSession / newChat / 選択確定) で要求を破棄する", () => {
  const source = read("src/hooks/useSessions.ts");
  assert.ok(source.includes("useSyncExternalStore(fileRefRequests.subscribe, fileRefRequests.snapshot)"));
  const clears = source.match(/fileRefRequests\.clear\(\)/g) ?? [];
  assert.equal(clears.length, 3, "selectSession / newChat / applySelectedSession の 3 箇所で破棄していない");
  assert.ok(source.includes("fileRefRequests.request(sessionIdRef.current, path)"), "要求の作成がない");
  assert.ok(source.includes("fileRefRequests.ack(seq)"), "ack の照合がない");
  // 確定時は選択が変わるときだけ落とす (同一セッションの snapshot 更新では落とさない)
  assert.ok(
    source.includes("if (sessionIdRef.current !== payload.sessionId) fileRefRequests.clear();"),
    "選択確定時の破棄がない",
  );
});

test("配線: App は選択中セッションの要求だけをパネル / sheet へ渡し、ack で消す", () => {
  const source = read("src/App.tsx");
  assert.ok(
    source.includes("fileRefRequestForSession(app.fileRefRequest, app.sessionId)"),
    "sessionId の一致判定がない",
  );
  assert.equal(
    (source.match(/openRequest=\{pendingFileRef\}/g) ?? []).length,
    2,
    "パネルと sheet の両方へ渡していない",
  );
  assert.equal((source.match(/onHandled=\{app\.ackFileRef\}/g) ?? []).length, 2);
  assert.ok(source.includes("returnFocus={fileRefOriginRef.current}"), "focus の戻し先を渡していない");
  assert.ok(
    source.includes("fileRefOriginRef.current = origin"),
    "クリック時に起点要素を保持していない (document.activeElement 依存)",
  );
});

test("配線: FileBrowser は mount 後の effect で適用し、seq ガードと onHandled を持つ", () => {
  const source = read("src/components/FileBrowser.tsx");
  const record = source.indexOf("appliedRequestRef.current = openRequest.seq");
  const apply = source.indexOf("setTabs((prev) => openFileTab(prev, openRequest.path))");
  assert.ok(source.includes("appliedRequestRef.current === openRequest.seq"), "seq のガードがない");
  assert.ok(record !== -1 && apply !== -1 && record < apply, "適用の印を setTabs より後に置いている");
  assert.ok(source.includes("onHandled?.(openRequest.seq)"), "onHandled を返していない");
  assert.ok(
    read("src/components/SessionFilesPanel.tsx").includes(
      "<FileBrowser\n        root={root}\n        reloadToken={reloadToken}\n        excludeNames={excludeNames}\n        openRequest={openRequest}\n        onHandled={onHandled}\n        canRef={!compact}\n      />",
    ),
    "パネルから FileBrowser へ渡していない",
  );
});

test("配線: compact の sheet は起点要素があれば生存確認して focus を戻す", () => {
  const source = read("src/components/SessionFilesPanel.tsx");
  assert.ok(source.includes("const origin = returnFocus ?? (document.activeElement as HTMLElement | null)"));
  assert.ok(source.includes("if (origin?.isConnected) origin.focus();"), "起点の生存確認がない");
});
