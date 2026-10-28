// 設定 → ファイル のドラッグ＆ドロップの受付規則と同時実行。DOM は使わず、純関数の契約だけを見る。

import assert from "node:assert/strict";
import test from "node:test";
import {
  isFileDrag,
  mergeUploadTasks,
  planUploads,
  runTaskPool,
  UPLOAD_CONCURRENCY,
  type UploadTaskStatus,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_MAX_LABEL,
} from "../src/lib/fileUpload";

function file(name: string, size: number): { name: string; size: number } {
  return { name, size };
}

test("planUploads: 件数とサイズの上限を超えた分だけを理由つきで拒否する", () => {
  const files = Array.from({ length: UPLOAD_MAX_FILES + 2 }, (_, index) => file(`f${index}.txt`, 10));
  const plan = planUploads(files);
  assert.equal(plan.accepted.length, UPLOAD_MAX_FILES);
  assert.deepEqual(
    plan.rejected.map(({ file: rejected, reason }) => [rejected.name, reason]),
    [
      ["f10.txt", `一度にアップロードできるのは最大 ${UPLOAD_MAX_FILES} 件までです`],
      ["f11.txt", `一度にアップロードできるのは最大 ${UPLOAD_MAX_FILES} 件までです`],
    ],
  );
});

test("planUploads: サイズ超過は件数の枠を消費せず、上限ちょうどと 0 バイトは受け付ける", () => {
  const plan = planUploads([
    file("huge.bin", UPLOAD_MAX_BYTES + 1),
    file("empty.txt", 0),
    file("limit.bin", UPLOAD_MAX_BYTES),
  ]);
  assert.deepEqual(
    plan.accepted.map((entry) => entry.name),
    ["empty.txt", "limit.bin"],
  );
  assert.deepEqual(
    plan.rejected.map(({ file: rejected, reason }) => [rejected.name, reason]),
    [["huge.bin", `${UPLOAD_MAX_LABEL} を超えるファイルはアップロードできません`]],
  );
});

test("isFileDrag: OS から運ばれたファイルだけを対象にし、社内の参照ドラッグは通さない", () => {
  assert.equal(isFileDrag(["Files"]), true);
  assert.equal(isFileDrag(["text/plain", "Files"]), true);
  assert.equal(isFileDrag(["application/x-u7agent-file-mention"]), false);
  assert.equal(isFileDrag([]), false);
});

test("runTaskPool: 同時数を超えず、1 件の失敗で残りを止めない", async () => {
  const items = Array.from({ length: 10 }, (_, index) => index);
  const started: number[] = [];
  let running = 0;
  let peak = 0;
  await runTaskPool(items, UPLOAD_CONCURRENCY, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    started.push(item);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running -= 1;
    if (item === 2) throw new Error("boom");
  });
  assert.equal(peak, UPLOAD_CONCURRENCY);
  assert.deepEqual(
    [...started].sort((a, b) => a - b),
    items,
  );
});

test("mergeUploadTasks: 実行中は完了済みを残し、独立した次のバッチでは前回成功だけを捨てる", () => {
  type Task = { id: string; status: UploadTaskStatus };
  const done: Task = { id: "a", status: "done" };
  const error: Task = { id: "b", status: "error" };
  const uploading: Task = { id: "c", status: "uploading" };
  const queued: Task = { id: "d", status: "queued" };
  const added: Task = { id: "e", status: "queued" };

  // 同じキューが動いている間に追加された分は、先に完了した同じバッチの結果を消さない
  assert.deepEqual(
    mergeUploadTasks([done, error, uploading], [added]).map((task) => task.id),
    ["a", "b", "c", "e"],
  );
  // 全件決着後の独立したバッチでは前回成功を捨て、失敗は直すまで残す
  assert.deepEqual(
    mergeUploadTasks([done, error], [added]).map((task) => task.id),
    ["b", "e"],
  );
  // 前回の待機が残っているだけでも、完了済みは同じバッチとして残す
  assert.deepEqual(
    mergeUploadTasks([done, queued], [added]).map((task) => task.id),
    ["a", "d", "e"],
  );
  assert.deepEqual(
    mergeUploadTasks([], [added]).map((task) => task.id),
    ["e"],
  );
});
