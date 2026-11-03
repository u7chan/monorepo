// 試行を始める前のディスクの空き確認。`statfs` は注入し、固定の値で境界を確かめる。
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { TRIAL_ARTIFACT_MAX_BYTES } from "../src/content-trial-artifacts";
import {
  TRIAL_DISK_MARGIN_BYTES,
  TRIAL_DISK_REQUIRED_BYTES,
  createTrialDiskCheck,
  type TrialStatfs,
} from "../src/content-trial-disk-space";

const DIR = join("/store", "trials");

/** 空きバイト数をそのまま返す `statfs`（`bsize: 1` にして bavail と一致させる） */
function statfsWith(freeBytes: number): TrialStatfs {
  return async () => ({ bsize: 1, bavail: freeBytes });
}

test("空きが 1 件分（保存の上限 + 余白）に満たないときだけ short になる", async () => {
  assert.equal(await createTrialDiskCheck({ dir: DIR, statfs: statfsWith(TRIAL_DISK_REQUIRED_BYTES - 1) })(), "short");
  // ちょうどは足りる（保存の上限 + 余白を満たす）
  assert.equal(await createTrialDiskCheck({ dir: DIR, statfs: statfsWith(TRIAL_DISK_REQUIRED_BYTES) })(), "enough");
  assert.equal(await createTrialDiskCheck({ dir: DIR, statfs: statfsWith(TRIAL_DISK_REQUIRED_BYTES + 1) })(), "enough");
});

test("要る空きは保存の 1 件の上限と余白の合計になる", () => {
  assert.equal(TRIAL_DISK_REQUIRED_BYTES, TRIAL_ARTIFACT_MAX_BYTES + TRIAL_DISK_MARGIN_BYTES);
});

test("空きは一般ユーザーが書ける bavail × bsize で数える", async () => {
  const read = async () => ({ bsize: 4096, bavail: Math.ceil(TRIAL_DISK_REQUIRED_BYTES / 4096) - 1 });
  assert.equal(await createTrialDiskCheck({ dir: DIR, statfs: read })(), "short");
});

test("置き場がまだ無いときは、作られる親の空きで判定する", async () => {
  const read: TrialStatfs = async (path) => {
    if (path === DIR) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    assert.equal(path, join("/store"));
    return { bsize: 1, bavail: TRIAL_DISK_REQUIRED_BYTES - 1 };
  };
  assert.equal(await createTrialDiskCheck({ dir: DIR, statfs: read })(), "short");
});

test("空きを測れない環境では short にせず、試行を止めない", async () => {
  const unsupported: TrialStatfs = async () => {
    throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
  };
  assert.equal(await createTrialDiskCheck({ dir: DIR, statfs: unsupported })(), "enough");
});
