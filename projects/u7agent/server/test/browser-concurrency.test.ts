// 同時実行の入場制御 (server/src/browser/concurrency.ts) を検証する。
// 契約: index ごとに 1 呼び出しだけが入場し実効上限を超えない / 終了済みの枠の引き継ぎは観測した世代名で
// 条件付けられ、生存中の枠を消さない / 中断 (SIGKILL) のどの段階からも容量が既定まで戻る /
// 分からない状態は消さずに容量として扱う (fail-closed)。

import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireConcurrencySlot,
  ConcurrencyLimitError,
  leasePath,
  SLOTS_DIR_NAME,
  slotDirPath,
  type ConcurrencySlot,
} from "../src/browser/concurrency";
import { callDirName, type CallOwner, type ProcessStartTimeReader } from "../src/browser/temp";
import { processStartedAtMs } from "../src/proc-stat";

const STARTED_AT = 1_700_000_000_000;
/** 生存中の所有者として使う自プロセスの素性 (実 /proc で生存と分かる) */
const SELF: CallOwner = { pid: process.pid, startedAtMs: (await processStartedAtMs(process.pid)) ?? 0 };
assert.ok(SELF.startedAtMs > 0, "自プロセスの起動時刻を読める");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const HOLDER = fileURLToPath(new URL("./browser-slot-holder.ts", import.meta.url));
const KILLER = fileURLToPath(new URL("./browser-slot-kill.ts", import.meta.url));

type HolderProcess = ChildProcessByStdio<null, Readable, Readable>;

function reader(entries: Record<number, number | undefined>): ProcessStartTimeReader {
  return async (pid) => entries[pid];
}

function slotsDir(root: string): string {
  return join(root, SLOTS_DIR_NAME);
}

/** 置き場に残っている index の一覧 */
async function leases(root: string): Promise<string[]> {
  return (await readdir(slotsDir(root)).catch(() => [] as string[])).sort();
}

/** index の中の枠 (所有者名のファイル) の一覧 */
async function leaseOwners(root: string, index: number): Promise<string[]> {
  return (await readdir(slotDirPath(slotsDir(root), index)).catch(() => [] as string[])).sort();
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "u7agent-browser-slots-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 入場済みの枠を直接置く (実装と同じ形: `<index>/<所有者>` のファイル) */
async function putLease(root: string, index: number, owner: CallOwner): Promise<void> {
  await mkdir(slotDirPath(slotsDir(root), index), { recursive: true });
  await writeFile(leasePath(slotsDir(root), index, owner), "");
}

/** 枠を入れる前に中断した残り (空の index ディレクトリ) を置く */
async function putEmptyIndex(root: string, index: number): Promise<void> {
  await mkdir(slotDirPath(slotsDir(root), index), { recursive: true });
}

/** 実プロセスを 1 本立てて、pid と起動時刻 (実 /proc) を返す。SIGKILL すると終了済みの所有者になる */
async function spawnSleeper(): Promise<{ pid: number; startedAtMs: number; stop(): Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) assert.fail("子プロセスの pid を取得できません");
  const exit = once(child, "exit");
  const startedAtMs = await processStartedAtMs(pid);
  if (startedAtMs === undefined || startedAtMs <= 0) assert.fail("実プロセスの起動時刻を読めません");
  return {
    pid,
    startedAtMs,
    stop: async () => {
      child.kill("SIGKILL");
      await exit;
    },
  };
}

/** stdout に指定の行が出るまで待つ。出なければ失敗させる (期限はテストのハング防止) */
async function waitForLine(child: HolderProcess, line: string, timeoutMs = 45_000): Promise<void> {
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

/** 同時入場の子プロセスをまとめて起動し、終了時の出力を返す */
async function holderOutputs(root: string, count: number, limit: number, holdMs: number): Promise<string[]> {
  const children = Array.from({ length: count }, () =>
    spawn(process.execPath, ["--import", TSX_LOADER, HOLDER, root, String(limit), String(holdMs)], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const outputs = children.map((child) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    return () => output;
  });
  const exit = Promise.all(children.map((child) => once(child, "exit")));
  await Promise.race([
    exit,
    new Promise((done) => setTimeout(done, 45_000)).then(() => assert.fail("同時入場の子プロセスが終わりません")),
  ]);
  return outputs.map((read) => read());
}

test("同じ置き場では上限までしか取れず、解放すると次の呼び出しが取れる", async () => {
  await withRoot(async (root) => {
    const readStartedAt = reader({ 1000: STARTED_AT, 2000: STARTED_AT + 1, 3000: STARTED_AT + 2 });
    const first = await acquireConcurrencySlot({ root, limit: 2, pid: 1000, readStartedAt });
    const second = await acquireConcurrencySlot({ root, limit: 2, pid: 2000, readStartedAt });
    assert.deepEqual([first.index, second.index], [0, 1], "空いている index を小さい方から取る");
    assert.deepEqual(await leaseOwners(root, 0), [`1000-${STARTED_AT}`], "枠の名前が所有者を表す");
    await assert.rejects(acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt }), ConcurrencyLimitError);
    // 断られた呼び出しは自分の枠を残さない (次の呼び出しが同じ枠を使える)
    assert.deepEqual(await leases(root), ["0", "1"]);
    await first.release();
    const third = await acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt });
    assert.equal(third.index, 0, "解放された index を使う");
    await second.release();
    await third.release();
    assert.deepEqual(await readdir(root), [], "全員が終わったら置き場には何も残らない");
  });
});

// 中断の回復 (1): 枠を入れる前に SIGKILL されると空の index ディレクトリが残る。空のときだけ消せる
// rmdir で回収し、既定の枠数まで戻ることを固定する。
test("空のまま残った index を回収して、既定の同時実行数まで戻る", async () => {
  await withRoot(async (root) => {
    await putEmptyIndex(root, 0);
    const readStartedAt = reader({ 1001: STARTED_AT, 1002: STARTED_AT, 1003: STARTED_AT });
    const pids = [1001, 1002, 1003];
    const held: ConcurrencySlot[] = [];
    for (const pid of pids) held.push(await acquireConcurrencySlot({ root, limit: 3, pid, readStartedAt }));
    assert.deepEqual(held.map((slot) => slot.index).sort(), [0, 1, 2], "空のディレクトリを回収して 3 枠すべてを使える");
    assert.deepEqual(await leaseOwners(root, 0), [`1001-${STARTED_AT}`], "空のディレクトリは自分の枠で置き換わる");
    for (const slot of held) await slot.release();
    assert.deepEqual(await readdir(root), [], "回収後は残骸が無い");
  });
});

// 中断の回復 (2): 枠を入れた後に SIGKILL されると終了済み所有者の枠が残る。次の呼び出しが引き継ぐ。
test("終了済みの枠は引き継いで使い、既定の同時実行数まで戻る", async () => {
  await withRoot(async (root) => {
    const dead = await spawnSleeper();
    const readStartedAt = reader({ 1002: STARTED_AT + 1, 1003: STARTED_AT + 2, 1004: STARTED_AT + 3 });
    try {
      await dead.stop();
      await putLease(root, 0, { pid: dead.pid, startedAtMs: dead.startedAtMs });
      const held: ConcurrencySlot[] = [];
      for (const pid of [1002, 1003, 1004]) {
        held.push(
          await acquireConcurrencySlot({
            root,
            limit: 3,
            pid,
            readStartedAt: async (target) => (target === dead.pid ? processStartedAtMs(target) : readStartedAt(target)),
          }),
        );
      }
      assert.deepEqual(held.map((slot) => slot.index).sort(), [0, 1, 2], "終了済みの枠を引き継いで 3 枠すべてを使える");
      assert.deepEqual(await leaseOwners(root, 0), [`1002-${STARTED_AT + 1}`], "枠の名前が引き継いだ呼び出しになる");
      for (const slot of held) await slot.release();
      assert.deepEqual(await readdir(root), [], "回収後は残骸が無い");
    } finally {
      await dead.stop();
    }
  });
});

// 中断の回復 (3): 引き継ぎの途中で SIGKILL されても、移す前なら終了済みの枠が、移した後なら自分の枠が
// 残る。どちらも容量を消費したままにしない (もう一度引き継げる)。
test("引き継ぎの途中で中断した状態からも容量が戻る", async () => {
  await withRoot(async (root) => {
    const dead = await spawnSleeper();
    try {
      await dead.stop();
      const gone = { pid: dead.pid, startedAtMs: dead.startedAtMs };
      // (a) 移す前に落ちた = 終了済みの枠がそのまま残っている
      await putLease(root, 0, gone);
      // (b) 移した後に落ちた = 自分の世代名の枠 (終了済み) が残っている
      await putLease(root, 1, gone);
      const readStartedAt: ProcessStartTimeReader = async (pid) =>
        pid === dead.pid
          ? processStartedAtMs(pid)
          : reader({ 2001: STARTED_AT, 2002: STARTED_AT, 2003: STARTED_AT })(pid);
      const held: ConcurrencySlot[] = [];
      for (const pid of [2001, 2002, 2003])
        held.push(await acquireConcurrencySlot({ root, limit: 3, pid, readStartedAt }));
      assert.deepEqual(held.map((slot) => slot.index).sort(), [0, 1, 2], "どちらの中断状態からも 3 枠すべてを使える");
      for (const slot of held) await slot.release();
      assert.deepEqual(await readdir(root), [], "残骸が無い");
    } finally {
      await dead.stop();
    }
  });
});

test("所有者名でない枠と、生きた枠が混ざった index は消さずに容量として扱う", async () => {
  await withRoot(async (root) => {
    const dir = slotsDir(root);
    await mkdir(slotDirPath(dir, 0), { recursive: true });
    await writeFile(join(slotDirPath(dir, 0), "not-an-owner"), "");
    await assert.rejects(
      acquireConcurrencySlot({ root, limit: 1, pid: 3000, readStartedAt: reader({ 3000: STARTED_AT }) }),
      ConcurrencyLimitError,
    );
    assert.deepEqual(await leaseOwners(root, 0), ["not-an-owner"], "分からない名前は消さない");

    // 生きた枠と終了済みの枠が混ざっている場合も、生きた枠を消さずに容量として扱う
    await putLease(root, 1, SELF);
    await putLease(root, 1, { pid: 1000, startedAtMs: STARTED_AT });
    await assert.rejects(
      acquireConcurrencySlot({
        root,
        limit: 2,
        pid: 3001,
        readStartedAt: async (pid) => (pid === 3001 ? STARTED_AT : processStartedAtMs(pid)),
      }),
      ConcurrencyLimitError,
    );
    assert.deepEqual(await leaseOwners(root, 1), [`1000-${STARTED_AT}`, callDirName(SELF)], "生きた枠を消さない");
  });
});

// 枠が 2 つ以上残っていても、全て終了済みなら 1 つずつ減らして引き継げる (中断した引き継ぎの後始末)。
test("終了済みの枠が複数残っていても、1 つずつ減らして引き継ぐ", async () => {
  await withRoot(async (root) => {
    await putLease(root, 0, { pid: 1000, startedAtMs: STARTED_AT });
    await putLease(root, 0, { pid: 1001, startedAtMs: STARTED_AT });
    const slot = await acquireConcurrencySlot({
      root,
      limit: 1,
      pid: 3000,
      readStartedAt: reader({ 3000: STARTED_AT }),
    });
    assert.equal(slot.index, 0);
    assert.deepEqual(await leaseOwners(root, 0), [`3000-${STARTED_AT}`], "終了済みの枠が消えて自分の枠だけが残る");
    await slot.release();
    assert.deepEqual(await readdir(root), []);
  });
});

// この仕組みより前の置き場 (index の位置にファイル) は、終了済みと確認できたときだけ引き継ぐ。
// 生きた所有者のファイルと、中身を読めないファイルは消さない (fail-closed)。
test("index の位置のファイル (旧形式) は終了済みのときだけ引き継ぐ", async () => {
  await withRoot(async (root) => {
    const dir = slotsDir(root);
    await mkdir(dir, { recursive: true });
    await writeFile(slotPathForLegacy(root, 0), `${callDirName({ pid: 1000, startedAtMs: STARTED_AT })}\n`);
    await writeFile(slotPathForLegacy(root, 1), `${callDirName(SELF)}\n`);
    await writeFile(slotPathForLegacy(root, 2), "not-an-owner\n");
    const readStartedAt: ProcessStartTimeReader = async (pid) => (pid === 3000 ? STARTED_AT : processStartedAtMs(pid));
    const slot = await acquireConcurrencySlot({ root, limit: 3, pid: 3000, readStartedAt });
    assert.equal(slot.index, 0, "終了済みの旧形式のファイルは引き継ぐ");
    assert.deepEqual(await leaseOwners(root, 0), [`3000-${STARTED_AT}`]);
    assert.equal((await fs.readFile(slotPathForLegacy(root, 1), "utf8")).trim(), callDirName(SELF), "生きた枠は残す");
    assert.equal((await fs.readFile(slotPathForLegacy(root, 2), "utf8")).trim(), "not-an-owner", "読めない枠は残す");
    await slot.release();
  });
});

// 実際に SIGKILL で中断しても容量は戻る。終了済み所有者の生存確認の直後に落ちた場合は、
// 終了済みの枠が残る (移す前) ので、次の呼び出しが引き継いで既定の枠数まで戻る。
test("引き継ぎの途中で実際に SIGKILL されても、次の呼び出しが引き継いで容量が戻る", async () => {
  await withRoot(async (root) => {
    const ended = await spawnSleeper();
    try {
      await ended.stop();
      await putLease(root, 0, { pid: ended.pid, startedAtMs: ended.startedAtMs });
      const killed = spawn(process.execPath, ["--import", TSX_LOADER, KILLER, root, String(ended.pid)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const [code, signal] = (await once(killed, "exit")) as [number | null, NodeJS.Signals | null];
      assert.equal(code, null, "子は正常終了しない");
      assert.equal(signal, "SIGKILL", "引き継ぎの途中で SIGKILL された");
      assert.deepEqual(
        await leaseOwners(root, 0),
        [callDirName({ pid: ended.pid, startedAtMs: ended.startedAtMs })],
        "終了済みの枠がそのまま残る (中断しても壊れない)",
      );

      const readStartedAt = reader({ 5001: STARTED_AT, 5002: STARTED_AT, 5003: STARTED_AT });
      const held: ConcurrencySlot[] = [];
      for (const pid of [5001, 5002, 5003]) {
        held.push(
          await acquireConcurrencySlot({
            root,
            limit: 3,
            pid,
            readStartedAt: async (target) =>
              target === ended.pid ? processStartedAtMs(target) : readStartedAt(target),
          }),
        );
      }
      assert.deepEqual(held.map((slot) => slot.index).sort(), [0, 1, 2], "中断した枠を回収して 3 枠すべてを使える");
      for (const slot of held) await slot.release();
      assert.deepEqual(await readdir(root), [], "残骸が無い");
    } finally {
      await ended.stop();
    }
  });
});

// 回収は「観測した世代の名前」で条件付けられる。古い所有者を読んだ後に再開した呼び出しは、
// 別の呼び出しが引き継いだ生存中の枠には触れない (生存枠が消えて 4 件目が入場する経路を閉じる)。
test("回収の途中で別の呼び出しが枠を取っても、生存中の枠を消さない", async () => {
  await withRoot(async (root) => {
    const ended = await spawnSleeper();
    const slowCall = await spawnSleeper();
    const fastCall = await spawnSleeper();
    try {
      await ended.stop();
      await putLease(root, 0, { pid: ended.pid, startedAtMs: ended.startedAtMs });
      await putLease(root, 1, SELF);
      await putLease(root, 2, SELF);

      // 遅延させるのは A の読み取りだけ (B は先に進む)
      let endedReads = 0;
      let resumeSlow: () => void = () => {};
      const slowGate = new Promise<void>((resolve) => {
        resumeSlow = resolve;
      });
      let slowRead: () => void = () => {};
      const slowReadStarted = new Promise<void>((resolve) => {
        slowRead = resolve;
      });
      const readStartedAt: ProcessStartTimeReader = async (pid) => {
        if (pid === ended.pid) {
          endedReads += 1;
          if (endedReads === 1) {
            slowRead();
            await slowGate;
          }
        }
        return processStartedAtMs(pid);
      };
      const slow = acquireConcurrencySlot({ root, limit: 3, pid: slowCall.pid, readStartedAt });
      await slowReadStarted;

      const fast = await acquireConcurrencySlot({ root, limit: 3, pid: fastCall.pid, readStartedAt });
      assert.equal(fast.index, 0);
      const takenOver = await leaseOwners(root, 0);
      assert.deepEqual(takenOver, [callDirName({ pid: fastCall.pid, startedAtMs: fastCall.startedAtMs })]);

      resumeSlow();
      await assert.rejects(slow, ConcurrencyLimitError, "B が取った枠を取り返さない (4 件目は入場しない)");
      assert.deepEqual(await leases(root), ["0", "1", "2"], "B の生存枠は消えない");
      assert.deepEqual(await leaseOwners(root, 0), takenOver, "index 0 の所有者は B のまま");
      await fast.release();
    } finally {
      await slowCall.stop();
      await fastCall.stop();
    }
  });
});

test("複数の呼び出しが同じ終了済み枠を同時に回収しても、入場は上限までで生存枠は消えない", async () => {
  await withRoot(async (root) => {
    const ended = await spawnSleeper();
    const racers = [await spawnSleeper(), await spawnSleeper()];
    try {
      await ended.stop();
      await putLease(root, 0, { pid: ended.pid, startedAtMs: ended.startedAtMs });
      await putLease(root, 1, SELF);
      await putLease(root, 2, SELF);

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      let bothRead: () => void = () => {};
      const bothReadStarted = new Promise<void>((resolve) => {
        bothRead = resolve;
      });
      const racer = (pid: number): Promise<ConcurrencySlot> =>
        acquireConcurrencySlot({
          root,
          limit: 3,
          pid,
          readStartedAt: async (target) => {
            if (target === ended.pid) {
              reads += 1;
              if (reads === 2) bothRead();
              await gate;
            }
            return processStartedAtMs(target);
          },
        });
      const pending = racers.map((racerProcess) => racer(racerProcess.pid));
      await bothReadStarted;
      release();

      const results = await Promise.allSettled(pending);
      const admitted = results.filter((result) => result.status === "fulfilled");
      const refused = results.filter(
        (result) => result.status === "rejected" && result.reason instanceof ConcurrencyLimitError,
      );
      assert.equal(admitted.length, 1, "同じ枠を取れるのは 1 件だけ (他は上限で断られる)");
      assert.equal(refused.length, 1);
      assert.deepEqual(await leases(root), ["0", "1", "2"], "生存中の枠は消えないし増えない");
      assert.equal((await leaseOwners(root, 0)).length, 1, "index 0 の枠は 1 つのまま");
      for (const result of admitted) await (result as PromiseFulfilledResult<ConcurrencySlot>).value.release();
    } finally {
      for (const racerProcess of racers) await racerProcess.stop();
    }
  });
});

test("同じプロセス内で同時に入場しても上限を超えない", async () => {
  await withRoot(async (root) => {
    const pids = [1001, 1002, 1003, 1004, 1005, 1006];
    const readStartedAt = reader(Object.fromEntries(pids.map((pid) => [pid, STARTED_AT])));
    const results = await Promise.allSettled(
      pids.map((pid) => acquireConcurrencySlot({ root, limit: 3, pid, readStartedAt })),
    );
    const taken = results.filter((result) => result.status === "fulfilled");
    assert.equal(taken.length, 3, "上限と同じ数だけ入場する");
    assert.equal(
      results.filter((result) => result.status === "rejected" && result.reason instanceof ConcurrencyLimitError).length,
      3,
    );
    assert.deepEqual(
      taken.map((result) => (result as PromiseFulfilledResult<ConcurrencySlot>).value.index).sort(),
      [0, 1, 2],
      "別々の index を取る",
    );
    assert.equal((await leases(root)).length, 3);
    for (const result of taken) await (result as PromiseFulfilledResult<ConcurrencySlot>).value.release();
  });
});

test("解放が重なっても枠が壊れず、空いた index を次の呼び出しが使える", async () => {
  await withRoot(async (root) => {
    const readStartedAt = reader({ 1001: STARTED_AT, 1002: STARTED_AT, 1003: STARTED_AT, 1004: STARTED_AT });
    const held = [
      await acquireConcurrencySlot({ root, limit: 3, pid: 1001, readStartedAt }),
      await acquireConcurrencySlot({ root, limit: 3, pid: 1002, readStartedAt }),
      await acquireConcurrencySlot({ root, limit: 3, pid: 1003, readStartedAt }),
    ];
    assert.deepEqual(
      held.map((slot) => slot.index),
      [0, 1, 2],
    );
    await Promise.all([held[1].release(), held[1].release(), held[2].release()]);
    assert.deepEqual(await leases(root), ["0"]);
    const next = await acquireConcurrencySlot({ root, limit: 3, pid: 1004, readStartedAt });
    assert.equal(next.index, 1, "解放された index を再利用する");
    await Promise.all([held[0].release(), next.release()]);
    assert.deepEqual(await readdir(root), []);
  });
});

test("プロセスをまたいで上限が効き、SIGKILL で残った枠は次の呼び出しが引き継ぐ", async () => {
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
      assert.deepEqual(await leases(root), ["0"], "入場した呼び出しだけが枠を持つ");
      // 上限 1 の枠が埋まっている間は入場できない (入場したら self-test 相当の処理は走らない)
      const blocked = start(100);
      await waitForLine(blocked, "limit");
      assert.equal(await waitForExit(blocked), 0, "上限に達した呼び出しは入場せずに終わる");
      assert.deepEqual(await leases(root), ["0"], "断られた呼び出しは枠を残さない");
      // 外側の abort は SIGKILL なので finally が走らない。残った枠は次の呼び出しが引き継いで使える
      holder.kill("SIGKILL");
      await waitForExit(holder);
      const after = start(100);
      await waitForLine(after, "acquired");
      await waitForLine(after, "released");
      assert.equal(await waitForExit(after), 0);
      assert.deepEqual(await readdir(root), [], "引き継いだ枠は解放され、置き場には何も残らない");
    } finally {
      for (const child of children) child.kill("SIGKILL");
    }
  });
});

test("プロセスをまたぐ同時入場でも上限を超えず、枠は上限までしか作られない", async () => {
  await withRoot(async (root) => {
    const limit = 2;
    const running = holderOutputs(root, 4, limit, 3_000);
    const observed: number[] = [];
    const watch = setInterval(() => {
      void leases(root)
        .then((entries) => observed.push(entries.length))
        .catch(() => undefined);
    }, 100);
    let outputs: string[];
    try {
      outputs = await running;
    } finally {
      clearInterval(watch);
    }
    const acquired = outputs.filter((output) => output.includes("acquired")).length;
    const limited = outputs.filter((output) => output.includes("limit")).length;
    assert.equal(acquired, limit, "上限と同じ数だけ入場する");
    assert.equal(limited, 4 - limit, "残りは上限で断られる");
    assert.ok(observed.length > 0, "枠の数を観測できた");
    assert.ok(Math.max(...observed) <= limit, `枠は上限までしか作らない (observed=${observed.join(",")})`);
    assert.deepEqual(await readdir(root), [], "全員が終わったら置き場には何も残らない");
  });
});

// 入場の判定は枠の名前だけを使う (中身や時刻は読まない)。中身を読めない環境でも入場と引き継ぎが動く。
test("枠の中身やファイルの時刻を読めなくても入場と引き継ぎが動く", async () => {
  await withRoot(async (root) => {
    const dead = await spawnSleeper();
    const prefix = `${slotsDir(root)}/`;
    const originalStat = fs.stat;
    const originalReadFile = fs.readFile;
    try {
      await dead.stop();
      await putLease(root, 0, { pid: dead.pid, startedAtMs: dead.startedAtMs });
      fs.stat = (async (path: unknown, ...rest: unknown[]) => {
        if (typeof path === "string" && path.startsWith(prefix)) throw new Error("injected EIO");
        return (originalStat as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      }) as typeof fs.stat;
      fs.readFile = (async (path: unknown, ...rest: unknown[]) => {
        if (typeof path === "string" && path.startsWith(prefix)) throw new Error("injected EIO");
        return (originalReadFile as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      }) as typeof fs.readFile;
      syncBuiltinESMExports();

      const readStartedAt = reader({ 4001: STARTED_AT, 4002: STARTED_AT });
      const first = await acquireConcurrencySlot({
        root,
        limit: 2,
        pid: 4001,
        readStartedAt: async (pid) => (pid === dead.pid ? undefined : readStartedAt(pid)),
      });
      assert.equal(first.index, 0, "中身を読めなくても終了済みの枠を引き継げる");
      const second = await acquireConcurrencySlot({ root, limit: 2, pid: 4002, readStartedAt });
      assert.equal(second.index, 1);
      await first.release();
      await second.release();
      assert.deepEqual(await readdir(root), []);
    } finally {
      fs.stat = originalStat;
      fs.readFile = originalReadFile;
      syncBuiltinESMExports();
      await dead.stop();
    }
  });
});

/** 旧形式 (index の位置のファイル) のパス */
function slotPathForLegacy(root: string, index: number): string {
  return join(slotsDir(root), String(index));
}
