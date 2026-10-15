// 同時実行の入場制御 (server/src/browser/concurrency.ts) を検証する。
// 上限を超えないこと (index の確保は原子的)、終了済みの枠を引き継ぐときに生存中の枠を消さないこと、
// 不明な枠が容量を消費すること、プロセスをまたいで効くことを契約とする。

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
  RETIRED_DIR_NAME,
  SLOTS_DIR_NAME,
  slotPath,
  type ConcurrencySlot,
} from "../src/browser/concurrency";
import { callDirName, type CallOwner, type ProcessStartTimeReader } from "../src/browser/temp";
import { processStartedAtMs } from "../src/proc-stat";

const STARTED_AT = 1_700_000_000_000;
/** 生存中の所有者として使う自プロセスの素性 (実 /proc で生存と分かる) */
const SELF: CallOwner = { pid: process.pid, startedAtMs: (await processStartedAtMs(process.pid)) ?? 0 };
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const HOLDER = fileURLToPath(new URL("./browser-slot-holder.ts", import.meta.url));

type HolderProcess = ChildProcessByStdio<null, Readable, Readable>;

function reader(entries: Record<number, number | undefined>): ProcessStartTimeReader {
  return async (pid) => entries[pid];
}

function slotsDir(root: string): string {
  return join(root, SLOTS_DIR_NAME);
}

function retiredDir(root: string): string {
  return join(root, RETIRED_DIR_NAME);
}

/** 置き場に残っている枠 (index のファイル) の一覧 */
async function leases(root: string): Promise<string[]> {
  return (await readdir(slotsDir(root)).catch(() => [] as string[])).sort();
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "u7agent-browser-slots-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 入場済みの枠を直接置く (実装と同じ形: `<index>` のファイルの中身が所有者) */
async function putSlot(root: string, index: number, owner: CallOwner): Promise<string> {
  const dir = slotsDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(slotPath(dir, index), `${callDirName(owner)}\n`);
  return String(index);
}

/**
 * 枠の置き場の下だけ `stat` を差し替える。入場の判定が時刻や名前の並び順に依存していないことの回帰で、
 * 読めない枠 (EIO) と同値の時刻を注入しても、入場済みの枠が容量を消費し続けることを検査する。
 */
function patchSlotStat(root: string, replacement: (path: string) => Promise<{ ctimeMs: number }>): () => void {
  const prefix = `${slotsDir(root)}/`;
  const originalStat = fs.stat;
  fs.stat = (async (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.startsWith(prefix)) return replacement(path);
    return (originalStat as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as typeof fs.stat;
  syncBuiltinESMExports();
  return () => {
    fs.stat = originalStat;
    syncBuiltinESMExports();
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

/** SIGKILL され得る子プロセスを 1 本立てて、lease を取ったことを待つ */
async function heldByChild(root: string, limit: number): Promise<{ child: HolderProcess; kill(): Promise<void> }> {
  const child = spawnHolder(root, limit, 30_000);
  await waitForLine(child, "acquired");
  return {
    child,
    kill: async () => {
      child.kill("SIGKILL");
      await waitForExit(child);
    },
  };
}

test("同じ置き場では上限までしか取れず、解放すると次の呼び出しが取れる", async () => {
  await withRoot(async (root) => {
    const readStartedAt = reader({ 1000: STARTED_AT, 2000: STARTED_AT + 1, 3000: STARTED_AT + 2 });
    const first = await acquireConcurrencySlot({ root, limit: 2, pid: 1000, readStartedAt });
    const second = await acquireConcurrencySlot({ root, limit: 2, pid: 2000, readStartedAt });
    assert.ok(SELF.startedAtMs > 0, "自プロセスの起動時刻を読める");
    assert.deepEqual([first.index, second.index], [0, 1], "空いている index を小さい方から取る");
    await assert.rejects(acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt }), ConcurrencyLimitError);
    // 断られた呼び出しは自分の枠を残さない (次の呼び出しが同じ枠を使える)
    assert.deepEqual(await leases(root), ["0", "1"]);
    await first.release();
    const third = await acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt });
    assert.equal(third.index, 0, "解放された index を使う");
    await second.release();
    await third.release();
    assert.deepEqual(await leases(root), [], "全員が終わったら枠は残らない");
    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.startsWith(".")),
      [],
      "入場の一時ファイルも残らない",
    );
  });
});

// 枠の並び順や時刻を入場の根拠にすると、読めない (EIO) 枠が末尾へ回って上限を超える。
test("枠のメタデータを読めなくても入場済みの枠が容量を消費する", async () => {
  await withRoot(async (root) => {
    const readStartedAt = reader({ 2001: STARTED_AT, 2002: STARTED_AT, 2003: STARTED_AT, 1001: STARTED_AT });
    const held: ConcurrencySlot[] = [];
    for (const pid of [2001, 2002, 2003])
      held.push(await acquireConcurrencySlot({ root, limit: 3, pid, readStartedAt }));
    const restore = patchSlotStat(root, async () => {
      throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    });
    try {
      await assert.rejects(
        acquireConcurrencySlot({ root, limit: 3, pid: 1001, readStartedAt }),
        ConcurrencyLimitError,
        "読めない枠を空きとして扱わない",
      );
      assert.equal((await leases(root)).length, 3, "4 件目の枠を作らない");
    } finally {
      restore();
    }
    for (const slot of held) await slot.release();
  });
});

// 同値の時刻や名前順で順位が入れ替わると、後から来た呼び出しが先頭 (= 上限内) に入り得る。
test("枠の時刻が同値でも後から来た呼び出しが上限を超えない", async () => {
  await withRoot(async (root) => {
    const readStartedAt = reader({ 2001: STARTED_AT, 2002: STARTED_AT, 2003: STARTED_AT, 1001: STARTED_AT });
    const held: ConcurrencySlot[] = [];
    for (const pid of [2001, 2002, 2003])
      held.push(await acquireConcurrencySlot({ root, limit: 3, pid, readStartedAt }));
    const restore = patchSlotStat(root, async () => ({ ctimeMs: 0 }));
    try {
      await assert.rejects(
        acquireConcurrencySlot({ root, limit: 3, pid: 1001, readStartedAt }),
        ConcurrencyLimitError,
        "名前順で先頭になる pid でも入場しない",
      );
      assert.equal((await leases(root)).length, 3, "4 件目の枠を作らない");
    } finally {
      restore();
    }
    for (const slot of held) await slot.release();
  });
});

// 死亡枠の回収は「所有者を読んでから消す」2 段になるため、その間に別の呼び出しが同じ index を
// 取り直すと、遅れて再開した呼び出しが生存中の枠を消してしまう。回収は記録を取った呼び出しだけが行う。
// 所有者の生存判定は実プロセスの実 /proc で行い、公開 API の reader では遅延だけを注入する。
test("回収の途中で別の呼び出しが枠を取っても、生存中の枠を消さない", async () => {
  await withRoot(async (root) => {
    const ended = await spawnSleeper();
    const slowCall = await spawnSleeper();
    const fastCall = await spawnSleeper();
    try {
      await ended.stop();
      await putSlot(root, 0, { pid: ended.pid, startedAtMs: ended.startedAtMs });
      await putSlot(root, 1, SELF);
      await putSlot(root, 2, SELF);

      let resumeSlow: () => void = () => {};
      const slowGate = new Promise<void>((resolve) => {
        resumeSlow = resolve;
      });
      let slowRead: () => void = () => {};
      const slowReadStarted = new Promise<void>((resolve) => {
        slowRead = resolve;
      });
      // 遅延させるのは A の読み取りだけ (B は先に進む)
      let endedReads = 0;
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
      // 遅れて再開する呼び出し (A): 終了済み所有者の生存確認で止まる
      const slow = acquireConcurrencySlot({ root, limit: 3, pid: slowCall.pid, readStartedAt });
      await slowReadStarted;

      // 先に進む呼び出し (B): 同じ終了済み枠を引き継いで index 0 を取る
      const fast = await acquireConcurrencySlot({ root, limit: 3, pid: fastCall.pid, readStartedAt });
      assert.equal(fast.index, 0);
      assert.deepEqual(await leases(root), ["0", "1", "2"]);

      resumeSlow();
      await assert.rejects(slow, ConcurrencyLimitError, "B が取った枠を取り返さない (4 件目は入場しない)");
      assert.deepEqual(await leases(root), ["0", "1", "2"], "B の生存枠は消えない");
      assert.equal(
        await fs.readFile(slotPath(slotsDir(root), 0), "utf8"),
        `${callDirName({ pid: fastCall.pid, startedAtMs: fastCall.startedAtMs })}\n`,
        "index 0 の所有者は B のまま",
      );
      assert.deepEqual(
        await readdir(retiredDir(root)),
        [`0-${callDirName({ pid: ended.pid, startedAtMs: ended.startedAtMs })}`],
        "引き継ぎは記録に残り、遅れて再開した呼び出しはこの記録で止まる",
      );
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
      await putSlot(root, 0, { pid: ended.pid, startedAtMs: ended.startedAtMs });
      await putSlot(root, 1, SELF);
      await putSlot(root, 2, SELF);

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
      assert.deepEqual(
        await readdir(retiredDir(root)),
        [`0-${callDirName({ pid: ended.pid, startedAtMs: ended.startedAtMs })}`],
        "引き継ぎの記録は 1 つだけ",
      );
      for (const result of admitted) await (result as PromiseFulfilledResult<ConcurrencySlot>).value.release();
    } finally {
      for (const racerProcess of racers) await racerProcess.stop();
    }
  });
});

test("終了済みの枠は引き継いで使い、中身が読めない枠 (不明) は容量として残す", async () => {
  await withRoot(async (root) => {
    await putSlot(root, 0, { pid: 1000, startedAtMs: STARTED_AT });
    await putSlot(root, 1, { pid: 1002, startedAtMs: STARTED_AT });
    const readStartedAt = reader({ 1002: 0, 3000: STARTED_AT + 2, 4000: STARTED_AT + 3 }); // 1000 は居ない、1002 は不明
    // 上限 1 では index 1 は範囲外。不明な枠を空きとして扱うと、ここで入場してしまう
    await assert.rejects(
      acquireConcurrencySlot({ root, limit: 1, pid: 3000, readStartedAt }),
      ConcurrencyLimitError,
      "範囲外の不明な枠も容量として扱う",
    );
    // 上限 2 なら終了済みの index 0 を引き継げる。index 1 の不明な枠は残るので、次の呼び出しは入場できない
    const slot = await acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt });
    assert.equal(slot.index, 0);
    assert.equal(
      await fs.readFile(slotPath(slotsDir(root), 0), "utf8"),
      `${callDirName({ pid: 3000, startedAtMs: STARTED_AT + 2 })}\n`,
      "枠の所有者が引き継がれる",
    );
    await assert.rejects(acquireConcurrencySlot({ root, limit: 2, pid: 4000, readStartedAt }), ConcurrencyLimitError);
    await slot.release();
    assert.deepEqual(await leases(root), ["1"], "不明な枠だけが残る");
  });
});

// 内容が壊れている枠は所有者を判定できず、消しても安全か分からない。不明として容量を消費させる。
test("所有者を読み取れない枠は不明として残し、容量を消費する", async () => {
  await withRoot(async (root) => {
    const dir = slotsDir(root);
    await mkdir(dir, { recursive: true });
    await writeFile(slotPath(dir, 0), "not-an-owner\n");
    await assert.rejects(
      acquireConcurrencySlot({ root, limit: 1, pid: 3000, readStartedAt: reader({ 3000: STARTED_AT }) }),
      ConcurrencyLimitError,
    );
    assert.deepEqual(await leases(root), ["0"]);
  });
});

test("上限より大きい index の枠が残っている間は入場しない", async () => {
  await withRoot(async (root) => {
    await putSlot(root, 5, { pid: 1002, startedAtMs: STARTED_AT });
    await assert.rejects(
      acquireConcurrencySlot({
        root,
        limit: 3,
        pid: 3000,
        readStartedAt: reader({ 1002: STARTED_AT, 3000: STARTED_AT }),
      }),
      ConcurrencyLimitError,
      "より大きい上限で入場した枠は数えられないので入場しない",
    );
    const slot = await acquireConcurrencySlot({
      root,
      limit: 3,
      pid: 3000,
      readStartedAt: reader({ 3000: STARTED_AT }),
    });
    assert.equal(slot.index, 0, "終了済みと分かっている枠は数えない");
    await slot.release();
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
    assert.deepEqual(await leases(root), []);
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
      const owner = await fs.readFile(slotPath(slotsDir(root), 0), "utf8");
      holder.kill("SIGKILL");
      await waitForExit(holder);
      const after = start(100);
      await waitForLine(after, "acquired");
      await waitForLine(after, "released");
      assert.equal(await waitForExit(after), 0);
      assert.deepEqual(await leases(root), [], "引き継いだ枠は解放される");
      assert.deepEqual(await readdir(retiredDir(root)), [`0-${owner.trim()}`], "引き継ぎは記録に残る");
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
    assert.deepEqual(await leases(root), [], "全員が終わったら枠は残らない");
  });
});

test("終了済みの枠を引き継いだ後も、別の呼び出しが同じ index を取れる", async () => {
  await withRoot(async (root) => {
    const child = await heldByChild(root, 1);
    await child.kill();
    const owner = await fs.readFile(slotPath(slotsDir(root), 0), "utf8");
    const readStartedAt: ProcessStartTimeReader = async (pid) =>
      pid === 9001 || pid === 9002 ? STARTED_AT : processStartedAtMs(pid);
    const first = await acquireConcurrencySlot({ root, limit: 2, pid: 9001, readStartedAt });
    assert.equal(first.index, 0, "終了済みの枠を引き継ぐ");
    assert.deepEqual(await readdir(retiredDir(root)), [`0-${owner.trim()}`]);
    await first.release();
    const second = await acquireConcurrencySlot({ root, limit: 2, pid: 9002, readStartedAt });
    assert.equal(second.index, 0, "空いた index をそのまま使える");
    await second.release();
    assert.deepEqual(await leases(root), []);
  });
});
