// 同時実行の入場制御 (server/src/browser/concurrency.ts) を検証する。
// プロセスをまたいで効くこと、終了済みと確認できる枠だけを回収すること、不明な所有者の枠は残すことが契約。

import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireConcurrencySlot, ConcurrencyLimitError, SLOTS_DIR_NAME } from "../src/browser/concurrency";
import { callDirName, type ProcessStartTimeReader } from "../src/browser/temp";

const STARTED_AT = 1_700_000_000_000;
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const HOLDER = fileURLToPath(new URL("./browser-slot-holder.ts", import.meta.url));

type HolderProcess = ChildProcessByStdio<null, Readable, Readable>;

function reader(entries: Record<number, number | undefined>): ProcessStartTimeReader {
  return async (pid) => entries[pid];
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "u7agent-browser-slots-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** stdout に指定の行が出るまで待つ。出なければ失敗させる (期限はテストのハング防止) */
async function waitForLine(child: HolderProcess, line: string, timeoutMs = 20_000): Promise<void> {
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  const deadline = Date.now() + timeoutMs;
  while (!output.split("\n").includes(line)) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(`子プロセスが終了しました: ${output}`);
    if (Date.now() > deadline) assert.fail(`子プロセスの出力を待てませんでした: ${output}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** 終了していれば即座に、まだなら exit を待つ (待ち始める前に終わっていても固まらない) */
async function waitForExit(child: HolderProcess): Promise<number | null> {
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  return child.exitCode;
}

function spawnHolder(root: string, limit: number, holdMs: number): HolderProcess {
  return spawn(process.execPath, ["--import", TSX_LOADER, HOLDER, root, String(limit), String(holdMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("同じ置き場では上限までしか取れず、解放すると次の呼び出しが取れる", async () => {
  await withRoot(async (root) => {
    const readStartedAt = reader({ 1000: STARTED_AT, 2000: STARTED_AT + 1, 3000: STARTED_AT + 2 });
    const first = await acquireConcurrencySlot({ root, limit: 2, pid: 1000, readStartedAt });
    const second = await acquireConcurrencySlot({ root, limit: 2, pid: 2000, readStartedAt });
    assert.deepEqual([first.index, second.index], [0, 1]);
    await assert.rejects(acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt }), ConcurrencyLimitError);
    // 断られた呼び出しは自分の枠を残さない (次の呼び出しが同じ枠を使える)
    assert.equal((await readdir(join(root, SLOTS_DIR_NAME))).length, 2);
    await first.release();
    // 番号は作成順の位置なので、空いた 0 ではなく新しい順序での位置になる (重要なのは入場できること)
    const third = await acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt });
    assert.ok(third.index < 2, String(third.index));
    await second.release();
    await third.release();
    assert.deepEqual(await readdir(root), [], "空になった枠の置き場は片付ける");
  });
});

test("終了済みと確認できる枠は回収し、読み取り失敗 (不明) の枠は残す", async () => {
  await withRoot(async (root) => {
    const dir = join(root, SLOTS_DIR_NAME);
    await mkdir(dir, { recursive: true });
    const dead = callDirName({ pid: 1001, startedAtMs: STARTED_AT });
    const unknown = callDirName({ pid: 1002, startedAtMs: STARTED_AT });
    await writeFile(join(dir, dead), `${dead}\n`);
    await new Promise((done) => setTimeout(done, 20));
    await writeFile(join(dir, unknown), `${unknown}\n`);
    const readStartedAt = reader({ 1002: 0, 3000: STARTED_AT + 2 }); // 1001 は居ない、1002 は不明
    await assert.rejects(
      acquireConcurrencySlot({ root, limit: 1, pid: 3000, readStartedAt }),
      ConcurrencyLimitError,
      "不明な所有者の枠は空きとして扱わない",
    );
    assert.deepEqual(await readdir(dir), [unknown], "終了済みの枠だけを消す");
    const slot = await acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt });
    assert.equal(slot.index, 1, "不明な枠の後ろに並ぶ");
    await slot.release();
  });
});

test("プロセスをまたいで上限が効き、SIGKILL で残った枠は次の呼び出しが回収する", async () => {
  await withRoot(async (root) => {
    const children: HolderProcess[] = [];
    const start = (holdMs: number): HolderProcess => {
      const child = spawnHolder(root, 1, holdMs);
      children.push(child);
      return child;
    };
    try {
      const holder = start(5_000);
      await waitForLine(holder, "acquired");
      // 上限 1 の枠が埋まっている間は入場できない (入場したら self-test 相当の処理は走らない)
      const blocked = start(100);
      await waitForLine(blocked, "limit");
      assert.equal(await waitForExit(blocked), 0, "上限に達した呼び出しは入場せずに終わる");
      // 外側の abort は SIGKILL なので finally が走らない。残った枠は次の呼び出しが回収して使える
      holder.kill("SIGKILL");
      await waitForExit(holder);
      const after = start(100);
      await waitForLine(after, "acquired");
      await waitForLine(after, "released");
      assert.equal(await waitForExit(after), 0);
      assert.deepEqual(await readdir(root), [], "回収後は残骸が無い");
    } finally {
      for (const child of children) child.kill("SIGKILL");
    }
  });
});
