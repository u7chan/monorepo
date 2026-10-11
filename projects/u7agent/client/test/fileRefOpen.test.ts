import assert from "node:assert/strict";
import test from "node:test";
import {
  createFileRefOpener,
  classifyFileRefFailure,
  fileRefCheckPath,
  fileRefFailureMessage,
  type FileRefCheck,
  type FileRefSelection,
} from "../src/lib/fileRefOpen";
import type { FileRefTarget } from "../src/lib/fileRef";

test("確認 API の失敗 status は 404 だけを不存在、400 を拒否、それ以外を確認不能にする", () => {
  assert.equal(classifyFileRefFailure(404), "missing");
  // 400 は不正入力・root 外・通常ファイル以外 (ディレクトリ等) で、実在の確認には使えない
  assert.equal(classifyFileRefFailure(400), "refused");
  // 502 / 503 と通信失敗 (status を持たない) は不存在と混同しない
  for (const status of [0, 401, 409, 413, 500, 502, 503]) {
    assert.equal(classifyFileRefFailure(status), "unavailable", String(status));
  }
});

test("失敗理由の文言は 3 つに分かれ、別の面へ誘導しない", () => {
  assert.equal(fileRefFailureMessage("missing"), "ファイルが見つかりません");
  assert.equal(fileRefFailureMessage("refused"), "このパスは開けません");
  assert.equal(fileRefFailureMessage("unavailable"), "ファイルを確認できませんでした。もう一度お試しください");
  for (const failure of ["missing", "refused", "unavailable"] as const) {
    assert.ok(!fileRefFailureMessage(failure).includes("スキル"), failure);
  }
});

test("確認 API の path は参照の面の座標からワークスペース root 相対へ写す", () => {
  assert.equal(
    fileRefCheckPath({ kind: "work", path: "index.html" }, "projects/u7agent"),
    "projects/u7agent/index.html",
  );
  assert.equal(fileRefCheckPath({ kind: "work", path: "a.txt" }, ".u7agent/sessions/s1"), ".u7agent/sessions/s1/a.txt");
  // スキル面の root もワークスペース root 相対なので、そのまま連結できる
  assert.equal(
    fileRefCheckPath({ kind: "skill", root: ".agents/skills/alpha", path: "assets/a.png" }, "projects/u7agent"),
    ".agents/skills/alpha/assets/a.png",
  );
});

test("確認が例外を投げた結果は確認不能として扱い、開かない", async () => {
  let opened = 0;
  const opener = createFileRefOpener({
    check: async () => {
      throw new Error("サンドボックスへ接続できません");
    },
    open: () => {
      opened += 1;
    },
    selection: () => ({ sessionId: "a", switchSeq: 0 }),
  });
  assert.deepEqual(await opener.open({ kind: "work", path: "a.txt" }), {
    kind: "failed",
    message: "ファイルを確認できませんでした。もう一度お試しください",
  });
  assert.equal(opened, 0);
});

test("セッション未確定のクリックは開かない (要求を登録できない)", async () => {
  let opened = 0;
  const opener = createFileRefOpener({
    check: async () => "exists",
    open: () => {
      opened += 1;
    },
    selection: () => ({ sessionId: "", switchSeq: 0 }),
  });
  assert.deepEqual(await opener.open({ kind: "work", path: "a.txt" }), { kind: "discarded" });
  assert.equal(opened, 0);
});

/** 切替世代で失効させる。ID の一致で見ると、切替をまたいで同じ ID へ戻ったときに失効が巻き戻る */
test("確認中にセッションを A→B→A と切り替えた結果も失効する", async () => {
  let selection: FileRefSelection = { sessionId: "a", switchSeq: 0 };
  const opened: FileRefTarget[] = [];
  const pending: Array<(result: FileRefCheck) => void> = [];
  const opener = createFileRefOpener({
    check: () => new Promise<FileRefCheck>((resolve) => pending.push(resolve)),
    open: (target) => opened.push(target),
    selection: () => selection,
  });
  const click = opener.open({ kind: "work", path: "a.txt" });
  // 切替 (selectSession / newChat は要求の clear と同時に世代を進める)。ID は a へ戻る
  selection = { sessionId: "b", switchSeq: 1 };
  selection = { sessionId: "a", switchSeq: 2 };
  pending[0]?.("exists");
  assert.deepEqual(await click, { kind: "discarded" }, "同じ ID へ戻った結果が開いている");
  assert.deepEqual(opened, []);
});
