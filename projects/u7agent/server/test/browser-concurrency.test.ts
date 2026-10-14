// 同時実行の入場制御 (server/src/browser/concurrency.ts) を検証する。
// 上限を超えないこと (index の確保は原子的)、不明な枠が容量を消費すること、終了済みと確認できる枠だけを
// 回収すること、プロセスをまたいで効くことを契約とする。

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
  SLOTS_DIR_NAME,
  slotPath,
  type ConcurrencySlot,
} from "../src/browser/concurrency";
import { callDirName, type CallOwner, type ProcessStartTimeReader } from "../src/browser/temp";

const STARTED_AT = 1_700_000_000_000;
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const HOLDER = fileURLToPath(new URL("./browser-slot-holder.ts", import.meta.url));

type HolderProcess = ChildProcessByStdio<null, Readable, Readable>;

function reader(entries: Record<number, number | undefined>): ProcessStartTimeReader {
  return async (pid) => entries[pid];
}

function slotsDir(root: string): string {
  return join(root, SLOTS_DIR_NAME);
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
    new Promise((done) => setTimeout(done, 30_000)).then(() => assert.fail("同時入場の子プロセスが終わりません")),
  ]);
  return outputs.map((read) => read());
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
    assert.deepEqual([first.index, second.index], [0, 1], "空いている index を小さい方から取る");
    await assert.rejects(acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt }), ConcurrencyLimitError);
    // 断られた呼び出しは自分の枠を残さない (次の呼び出しが同じ枠を使える)
    assert.equal((await readdir(slotsDir(root))).length, 2);
    await first.release();
    const third = await acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt });
    assert.equal(third.index, 0, "解放された index を使う");
    await second.release();
    await third.release();
    assert.deepEqual(await readdir(root), [], "空になった枠の置き場は片付ける");
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
      assert.equal((await readdir(slotsDir(root))).length, 3, "4 件目の枠を作らない");
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
      assert.equal((await readdir(slotsDir(root))).length, 3, "4 件目の枠を作らない");
    } finally {
      restore();
    }
    for (const slot of held) await slot.release();
  });
});

test("終了済みと確認できる枠は回収し、読み取り失敗 (不明) の枠は容量として残す", async () => {
  await withRoot(async (root) => {
    const dir = slotsDir(root);
    await putSlot(root, 0, { pid: 1001, startedAtMs: STARTED_AT });
    const unknown = await putSlot(root, 1, { pid: 1002, startedAtMs: STARTED_AT });
    const readStartedAt = reader({ 1002: 0, 3000: STARTED_AT + 2, 4000: STARTED_AT + 3 }); // 1001 は居ない、1002 は不明
    // 上限 1 では index 1 は範囲外。不明な枠を空きとして扱うと、ここで入場してしまう
    await assert.rejects(
      acquireConcurrencySlot({ root, limit: 1, pid: 3000, readStartedAt }),
      ConcurrencyLimitError,
      "範囲外の不明な枠も容量として扱う",
    );
    assert.deepEqual(await readdir(dir), [unknown], "終了済みの枠だけを消す");
    // 上限 2 なら空いた index 0 に入場できる。index 1 の不明な枠は残るので、次の呼び出しは入場できない
    const slot = await acquireConcurrencySlot({ root, limit: 2, pid: 3000, readStartedAt });
    assert.equal(slot.index, 0);
    await assert.rejects(acquireConcurrencySlot({ root, limit: 2, pid: 4000, readStartedAt }), ConcurrencyLimitError);
    await slot.release();
    assert.deepEqual(await readdir(dir), [unknown], "不明な枠は入場済みとして残る");
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
    assert.deepEqual(await readdir(dir), ["0"]);
  });
});

test("上限より大きい index の枠が残っている間は入場しない", async () => {
  await withRoot(async (root) => {
    const dir = slotsDir(root);
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
    assert.equal(slot.index, 0);
    assert.deepEqual(await readdir(dir), ["0"], "終了済みの枠は回収する");
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
    assert.equal((await readdir(slotsDir(root))).length, 3);
    for (const result of taken) await (result as PromiseFulfilledResult<ConcurrencySlot>).value.release();
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
      assert.equal((await readdir(slotsDir(root))).length, 1, "入場した呼び出しだけが枠を持つ");
      // 上限 1 の枠が埋まっている間は入場できない (入場したら self-test 相当の処理は走らない)
      const blocked = start(100);
      await waitForLine(blocked, "limit");
      assert.equal(await waitForExit(blocked), 0, "上限に達した呼び出しは入場せずに終わる");
      assert.equal((await readdir(slotsDir(root))).length, 1, "断られた呼び出しは枠を残さない");
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

test("プロセスをまたぐ同時入場でも上限を超えず、枠は上限までしか作られない", async () => {
  await withRoot(async (root) => {
    const limit = 2;
    const running = holderOutputs(root, 5, limit, 3_000);
    const observed: number[] = [];
    const watch = setInterval(() => {
      void readdir(slotsDir(root))
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
    assert.equal(limited, 5 - limit, "残りは上限で断られる");
    assert.ok(observed.length > 0, "枠の数を観測できた");
    assert.ok(Math.max(...observed) <= limit, `枠は上限までしか作らない (observed=${observed.join(",")})`);
    assert.deepEqual(await readdir(root), [], "全員が終わったら残骸が無い");
  });
});
