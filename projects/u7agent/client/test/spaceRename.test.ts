import assert from "node:assert/strict";
import test from "node:test";
import type { Space } from "server";

globalThis.location ??= { origin: "http://localhost" } as Location;
// spaceRename は api を（ApiError のために）読むので、location を用意した後で読む
const { ApiError } = await import("../src/api");
const { createSpaceRenameFlow, spaceRenameNoteText } = await import("../src/lib/spaceRename");

const normal: Space = { id: "default", name: "既定", createdAt: 0 };
const demo: Space = { id: "space-1111111111111111", name: "デモ", createdAt: 1 };
const alpha: Space = { id: "space-aaaaaaaaaaaaaaaa", name: "アルファ", createdAt: 2 };
const gamma: Space = { id: "space-cccccccccccccccc", name: "ガンマ", createdAt: 3 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 改名の flow（client/src/lib/spaceRename.ts）を組む。一覧は配列を差し替えて観察する */
function renameFlowRecorder(rows: Space[], save: (id: string, name: string) => Promise<Space>) {
  const notes: string[] = [];
  const sent: [string, string][] = [];
  let table = [...rows];
  const flow = createSpaceRenameFlow({
    save: (id, name) => {
      sent.push([id, name]);
      return save(id, name);
    },
    apply: (space) => {
      table = table.map((row) => (row.id === space.id ? space : row));
    },
    note: (kind, message) => notes.push(`${kind}:${message}`),
  });
  return {
    flow,
    notes,
    sent,
    rows: () => table,
    setRows: (next: Space[]) => {
      table = next;
    },
  };
}

test("2 回の改名が重なっても送信は直列化され、先行の成功が後の失敗で消えない", async () => {
  const first = deferred<Space>();
  let attempts = 0;
  const recorder = renameFlowRecorder([normal, demo], async (_id, _name) => {
    attempts += 1;
    if (attempts === 1) return first.promise;
    throw new ApiError("Invalid request body", 400);
  });
  // prompt は確定で閉じ、API の完了は待たないため、同じスペースへの改名が重なり得る
  const one = recorder.flow.rename(demo.id, "一回目");
  const two = recorder.flow.rename(demo.id, "あ".repeat(81));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(recorder.sent, [[demo.id, "一回目"]], "後の改名は前の応答を待つ");
  first.resolve({ ...demo, name: "一回目" });
  await Promise.all([one, two]);
  assert.deepEqual(recorder.sent, [
    [demo.id, "一回目"],
    [demo.id, "あ".repeat(81)],
  ]);
  assert.equal(recorder.rows()[1].name, "一回目", "後の失敗で先行の成功を巻き戻さない");
  assert.deepEqual(recorder.notes, ["rejected:Invalid request body"]);
});

test("改名の応答は届いた順に一覧の該当行だけへ反映し、他の行を巻き戻さない", async () => {
  const pending = deferred<Space>();
  const recorder = renameFlowRecorder([normal, demo, alpha], () => pending.promise);
  const renamed = recorder.flow.rename(demo.id, "改名後");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 応答待ちの間の作成・並べ替えは応答で巻き戻さない（rename は id が一致する行だけを差し替える）
  recorder.setRows([normal, alpha, demo, gamma]);
  pending.resolve({ ...demo, name: "改名後" });
  await renamed;
  assert.deepEqual(
    recorder.rows().map((row) => [row.id, row.name]),
    [
      [normal.id, "既定"],
      [alpha.id, "アルファ"],
      [demo.id, "改名後"],
      [gamma.id, "ガンマ"],
    ],
  );

  // 続けて別の行を改名すると、両方の応答がそれぞれの行へ入る
  const both = renameFlowRecorder([normal, demo, alpha], async (id, name) =>
    id === demo.id ? { ...demo, name } : { ...alpha, name },
  );
  await Promise.all([both.flow.rename(demo.id, "デモ改"), both.flow.rename(alpha.id, "アルファ改")]);
  assert.deepEqual(
    both.rows().map((row) => [row.id, row.name]),
    [
      [normal.id, "既定"],
      [demo.id, "デモ改"],
      [alpha.id, "アルファ改"],
    ],
  );
});

// 400 → 200 の順に完結しても、成功の反映で先行の失敗通知が消えることを見る (What)
test("先行の改名が 400 で失敗して後続が成功すると、失敗の通知は残らない", async () => {
  const second = deferred<Space>();
  let note = "";
  let rows: Space[] = [normal, demo];
  const flow = createSpaceRenameFlow({
    save: async (_id, name) => {
      if (name.length > 80) throw new ApiError("Invalid request body", 400);
      return second.promise;
    },
    // SpacesApp と同じ配線: 応答の行だけを差し替え、成功したら前の失敗の通知を消す
    apply: (space) => {
      rows = rows.map((row) => (row.id === space.id ? space : row));
      note = "";
    },
    note: (kind, message) => {
      note = spaceRenameNoteText(kind, message);
    },
  });
  // prompt は確定で閉じるので、81 文字の改名の応答を待たずに次の改名を確定できる
  const failing = flow.rename(demo.id, "あ".repeat(81));
  const succeeding = flow.rename(demo.id, "改名後");
  await failing;
  assert.match(note, /名前を変更できませんでした/, "先行の失敗は通知する");
  second.resolve({ ...demo, name: "改名後" });
  await succeeding;
  assert.equal(rows[1].name, "改名後");
  assert.equal(note, "", "後続の成功で先行の失敗通知を消す");
});

test("改名の失敗は HTTP エラーと結果不明を分け、文言を 1 回だけ渡して次の改名を妨げない", async () => {
  // HTTP エラーの応答は保存されていないので、一覧は変えずに理由だけを渡す
  const rejected = renameFlowRecorder([normal, demo], async () => {
    throw new ApiError("Invalid request body", 400);
  });
  await rejected.flow.rename(demo.id, "x");
  assert.deepEqual(rejected.rows(), [normal, demo]);
  assert.deepEqual(rejected.notes, ["rejected:Invalid request body"]);

  const unknown = renameFlowRecorder([normal, demo], async () => {
    throw new Error("接続が切れました");
  });
  await unknown.flow.rename(demo.id, "x");
  assert.deepEqual(unknown.rows(), [normal, demo]);
  assert.deepEqual(unknown.notes, ["unknown:接続が切れました"]);

  // 失敗しても待ち行列は切らない（同じスペースをもう一度改名できる）
  let attempts = 0;
  const retried = renameFlowRecorder([normal, demo], async (_id, name) => {
    attempts += 1;
    if (attempts === 1) throw new ApiError("boom", 503);
    return { ...demo, name };
  });
  await retried.flow.rename(demo.id, "一回目");
  await retried.flow.rename(demo.id, "二回目");
  assert.equal(retried.rows()[1].name, "二回目");
  assert.deepEqual(retried.notes, ["rejected:boom"]);
});

test("改名の失敗の文言は、保存されたかどうかで伝えることを分ける", () => {
  assert.equal(
    spaceRenameNoteText("rejected", "Invalid request body"),
    "スペースの名前を変更できませんでした。Invalid request body",
  );
  const unknown = spaceRenameNoteText("unknown", "接続が切れました");
  assert.match(unknown, /名前を変更できたか確認できません/);
  assert.match(unknown, /再読み込み/);
  assert.ok(unknown.includes("接続が切れました"), "原因を落とさない");
});
