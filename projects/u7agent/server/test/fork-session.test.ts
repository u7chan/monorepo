// 会話の分岐のファイルと保存の手順 (server/src/fork-session.ts) を検証する。
//   - 子の meta は親のタイトル / 由来 / 依頼本文 / 試行と、作業フォルダ / 添付の持ち主を写し、
//     ピン・通知・引き継ぎの記録は引き継がない
//   - 確定前は共有フォルダの確認 → 破損の検証 → 親の保存 → 読み直し → 境界の切り出しの順に進み、
//     破損は親を保存する前に 409 で止める
//   - 子の保存に失敗したら複製した実測を消し、確定後の失敗は record / descriptor / 子ディレクトリ /
//     実測を残さない

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  copyForkEntries,
  discardForkedSession,
  forkedSessionMeta,
  writeForkedSession,
  type ForkSessionFiles,
  type ForkSessionPort,
} from "../src/fork-session";
import type { SessionRecord } from "../src/session-record";
import {
  sessionDirPath,
  sessionHeaderOf,
  sessionJsonlPath,
  sessionMetaPath,
  writeSessionDir,
  type SessionEntryLike,
  type SessionMeta,
} from "../src/session-store";
import type { TitleAttempt } from "../src/session-title";

const PARENT_ID = "a1b2c3d4e5";
const CHILD_ID = "0f1e2d3c4b";
const WORKDIR = `scratch/${PARENT_ID}`;

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    version: 1,
    id: PARENT_ID,
    title: "",
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 3,
    agentId: "default",
    agent: { id: "default", name: "既定", description: "" },
    promptSnapshot: { agent: "<agent_profile />" },
    ...overrides,
  };
}

/** 手順が record から読む項目だけを持つ。meta は保存値の代わり */
function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { id: PARENT_ID, meta: meta(), title: "", titleOrigin: "auto", ...overrides } as unknown as SessionRecord;
}

/** entry は境界の切り出しだけを見るため、検証を通る最小の形にする */
function entries(count: number): SessionEntryLike[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "message",
    id: `e${index + 1}`,
    parentId: index === 0 ? null : `e${index}`,
    timestamp: new Date(index + 1).toISOString(),
    message: { role: "user", content: `q${index + 1}`, timestamp: index + 1 },
  })) as unknown as SessionEntryLike[];
}

/** 手順が触る口だけを記録する。`onSave` で保存の途中の状態 (削除予約など) を再現する */
function fakePort(options: { aborted?: boolean; onSave?: () => void; saveError?: string } = {}) {
  const calls: string[] = [];
  const registered: Array<{ id: string; meta: SessionMeta }> = [];
  let aborted = options.aborted ?? false;
  const port: ForkSessionPort = {
    isAborted: () => aborted,
    requireSharedWorkdir: (workdir) => {
      calls.push(`workdir:${workdir}`);
      return Promise.resolve();
    },
    saveParent: () => {
      calls.push("save");
      options.onSave?.();
      return Promise.resolve(options.saveError);
    },
    flushParent: () => {
      calls.push("flush");
      return Promise.resolve(true);
    },
    copyAssistantMetrics: (fromId, toId) => {
      calls.push(`copyMetrics:${fromId}->${toId}`);
    },
    deleteAssistantMetrics: (id) => {
      calls.push(`deleteMetrics:${id}`);
    },
    registerChild: (id, next) => {
      calls.push(`register:${id}`);
      registered.push({ id, meta: next });
    },
    releaseChild: (id) => {
      calls.push(`release:${id}`);
    },
  };
  return { port, calls, registered, abort: () => (aborted = true) };
}

async function withFiles<T>(run: (files: ForkSessionFiles) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "fork-session-"));
  try {
    return await run({ storeDir: join(base, "store"), rootCwd: join(base, "workspace") });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function writeParent(files: ForkSessionFiles, parentEntries: SessionEntryLike[]): Promise<void> {
  const parentMeta = meta();
  await writeSessionDir(files.storeDir, PARENT_ID, {
    meta: parentMeta,
    header: sessionHeaderOf(parentMeta, resolve(files.rootCwd, WORKDIR)),
    entries: parentEntries,
  });
}

const baseInput = {
  id: CHILD_ID,
  at: 1_000,
  spaceId: "default",
  parent: { id: PARENT_ID, title: "親", titleOrigin: "manual" as const },
  workdirOwner: PARENT_ID,
  uploadsOwner: PARENT_ID,
};

test("子の meta は親のタイトル・所属・持ち主を写し、ピン・通知・引き継ぎは引き継がない", () => {
  const child = forkedSessionMeta(
    meta({
      id: PARENT_ID,
      title: "保存されたタイトル",
      titleOrigin: "auto",
      messageCount: 7,
      model: "p/old",
      thinkingLevel: "low",
      projectCwd: "projects/p",
      projectName: "P",
      pinned: true,
      notify: true,
      handoff: { operationId: "abc12345", at: 10, memo: true, consumed: false },
    }),
    { ...baseInput, model: "p/new", thinkingLevel: "high" },
  );
  assert.equal(child.id, CHILD_ID);
  assert.equal(child.spaceId, "default");
  assert.equal(child.title, "親", "record のタイトルが保存値より新しい");
  assert.equal(child.titleOrigin, "manual");
  assert.equal(child.createdAt, 1_000);
  assert.equal(child.lastUsedAt, 1_000);
  assert.equal(child.messageCount, 7);
  assert.equal(child.model, "p/new", "SDK の実効値が保存値より優先される");
  assert.equal(child.thinkingLevel, "high");
  assert.equal(child.projectCwd, "projects/p");
  assert.equal(child.projectName, "P");
  assert.equal(child.parentSessionId, PARENT_ID);
  assert.equal(child.forkedAt, 1_000);
  assert.equal(child.workdirOwner, PARENT_ID);
  assert.equal(child.uploadsOwner, PARENT_ID);
  for (const key of ["pinned", "notify", "handoff"] as const) {
    assert.equal(key in child, false, `${key} は引き継がない`);
  }
});

test("実効値とタイトルが無ければ保存値へ落とす", () => {
  const child = forkedSessionMeta(
    meta({ title: "保存されたタイトル", titleOrigin: "manual", model: "p/saved", thinkingLevel: "medium" }),
    { ...baseInput, parent: { ...baseInput.parent, title: "" } },
  );
  assert.equal(child.title, "保存されたタイトル");
  assert.equal(child.titleOrigin, "manual");
  assert.equal(child.model, "p/saved");
  assert.equal(child.thinkingLevel, "medium");
  // 実効値も保存値も無ければキー自体を作らない
  const bare = forkedSessionMeta(meta({ title: "継承" }), baseInput);
  assert.equal("model" in bare, false);
  assert.equal("thinkingLevel" in bare, false);
});

test("予約中のタイトル試行は子だけ interrupted に終端化し、依頼本文は写す", () => {
  const pending: TitleAttempt = { runId: "r1", at: 5, state: "pending", trigger: "auto", generation: 3 };
  const child = forkedSessionMeta(meta({ titleAttempt: pending, titleRequest: "依頼本文" }), baseInput);
  assert.deepEqual(child.titleAttempt, {
    ...pending,
    state: "skipped",
    skipReason: "interrupted",
    error: undefined,
  });
  assert.equal(child.titleRequest, "依頼本文");

  // record の試行が保存値より優先され、親に試行が無ければ子も未試行
  const fromRecord = forkedSessionMeta(meta({ titleAttempt: { ...pending, runId: "old" } }), {
    ...baseInput,
    parent: { ...baseInput.parent, titleAttempt: pending, titleRequest: "新しい依頼" },
  });
  assert.equal(fromRecord.titleAttempt?.runId, "r1");
  assert.equal(fromRecord.titleRequest, "新しい依頼");

  const untried = forkedSessionMeta(meta(), baseInput);
  assert.equal("titleAttempt" in untried, false);
  assert.equal("titleRequest" in untried, false);
});

test("agentId を指定したときだけ、エージェントのスナップショットを作り直す", () => {
  const agentInfo = { id: "researcher", name: "調査役", description: "" };
  const child = forkedSessionMeta(meta(), {
    ...baseInput,
    agent: { agentInfo, promptSnapshot: { agent: "<researcher />" } },
  });
  assert.equal(child.agentId, "researcher");
  assert.deepEqual(child.agent, agentInfo);
  assert.deepEqual(child.promptSnapshot, { agent: "<researcher />" });

  const kept = forkedSessionMeta(meta(), baseInput);
  assert.equal(kept.agentId, "default");
  assert.deepEqual(kept.agent, { id: "default", name: "既定", description: "" });
});

test("境界までの entry を切り出し、共有フォルダの確認 → 親の保存 → drain の順に進む", async () => {
  await withFiles(async (files) => {
    await writeParent(files, entries(3));
    const { port, calls } = fakePort();
    const copied = await copyForkEntries(files, port, {
      parent: record(),
      workdir: WORKDIR,
      boundaryId: "e2",
    });
    assert.deepEqual(
      copied.map((entry) => entry.id),
      ["e1", "e2"],
    );
    assert.deepEqual(calls, [`workdir:${WORKDIR}`, "save", "flush"]);
  });
});

test("境界が未指定なら空、記録に無ければ 500 にして親を保存しない", async () => {
  await withFiles(async (files) => {
    // 受け付けた時点で entry が 0 件だった場合 (境界は undefined のまま、保存で entry が増え得る)
    await writeParent(files, entries(2));
    const empty = await copyForkEntries(files, fakePort().port, {
      parent: record(),
      workdir: WORKDIR,
      boundaryId: undefined,
    });
    assert.deepEqual(empty, []);

    const { port, calls } = fakePort();
    await assert.rejects(
      copyForkEntries(files, port, { parent: record(), workdir: WORKDIR, boundaryId: "e9" }),
      /分岐の境界が記録に見つかりません/,
    );
    assert.equal(calls.includes("save"), true, "境界の判定は保存の後 (読み直した記録が対象)");
  });
});

test("破損した原本は 409 で止め、親を保存しない", async () => {
  await withFiles(async (files) => {
    await writeParent(files, entries(2));
    await writeFile(sessionJsonlPath(PARENT_ID, files.storeDir), "{壊れた行}\n");
    const { port, calls } = fakePort();
    await assert.rejects(
      copyForkEntries(files, port, { parent: record(), workdir: WORKDIR, boundaryId: "e1" }),
      (error: Error & { statusCode: number }) =>
        error.statusCode === 409 && /JSON を解析できません/.test(error.message),
    );
    assert.deepEqual(calls, [`workdir:${WORKDIR}`]);
  });
});

test("削除予約 / close は保存の前後で 404 にする", async () => {
  await withFiles(async (files) => {
    await writeParent(files, entries(2));
    const before = fakePort({ aborted: true });
    await assert.rejects(
      copyForkEntries(files, before.port, { parent: record(), workdir: WORKDIR, boundaryId: "e1" }),
      (error: Error & { statusCode: number }) => error.statusCode === 404,
    );
    assert.deepEqual(before.calls, [`workdir:${WORKDIR}`]);

    const during = fakePort({ onSave: () => during.abort() });
    await assert.rejects(
      copyForkEntries(files, during.port, { parent: record(), workdir: WORKDIR, boundaryId: "e1" }),
      (error: Error & { statusCode: number }) => error.statusCode === 404,
    );
    assert.deepEqual(during.calls, [`workdir:${WORKDIR}`, "save", "flush"]);
  });
});

test("親の保存の失敗は 500 にし、読み直しへ進まない", async () => {
  await withFiles(async (files) => {
    await writeParent(files, entries(2));
    const failed = fakePort({ saveError: "ENOSPC" });
    await assert.rejects(
      copyForkEntries(files, failed.port, { parent: record(), workdir: WORKDIR, boundaryId: "e1" }),
      /セッションの保存に失敗しました: ENOSPC/,
    );

    const lingering = fakePort();
    await assert.rejects(
      copyForkEntries(files, lingering.port, {
        parent: record({ persistError: "EIO" }),
        workdir: WORKDIR,
        boundaryId: "e1",
      }),
      /セッションの保存に失敗しました: EIO/,
    );
  });
});

test("子の store を書き、実測を複製してから descriptor を登録する", async () => {
  await withFiles(async (files) => {
    const { port, calls, registered } = fakePort();
    const childMeta = meta({ id: CHILD_ID, title: "分岐先", titleOrigin: "manual" });
    const copied = entries(2);
    await writeForkedSession(files, port, {
      id: CHILD_ID,
      parentId: PARENT_ID,
      meta: childMeta,
      entries: copied,
      workdir: WORKDIR,
    });
    assert.deepEqual(calls, [`copyMetrics:${PARENT_ID}->${CHILD_ID}`, `register:${CHILD_ID}`]);
    assert.deepEqual(registered, [{ id: CHILD_ID, meta: childMeta }]);

    const saved = JSON.parse(await readFile(sessionMetaPath(CHILD_ID, files.storeDir), "utf8")) as SessionMeta;
    assert.equal(saved.id, CHILD_ID);
    assert.equal(saved.parentSessionId, undefined, "meta は渡した値をそのまま書く");
    const header = JSON.parse((await readFile(sessionJsonlPath(CHILD_ID, files.storeDir), "utf8")).split("\n")[0]) as {
      cwd: string;
    };
    assert.equal(header.cwd, resolve(files.rootCwd, WORKDIR), "子の cwd は親の作業フォルダ");
  });
});

test("子を書けなければ 500 にし、複製した実測と descriptor を残さない", async () => {
  await withFiles(async (files) => {
    // 既存の子ディレクトリがあると rename が失敗する (半端な子を残さない経路)
    const childDir = sessionDirPath(files.storeDir, CHILD_ID);
    await mkdir(childDir, { recursive: true });
    await writeFile(join(childDir, "keep"), "既存");
    const { port, calls, registered } = fakePort();
    await assert.rejects(
      writeForkedSession(files, port, {
        id: CHILD_ID,
        parentId: PARENT_ID,
        meta: meta({ id: CHILD_ID }),
        entries: entries(1),
        workdir: WORKDIR,
      }),
      /セッションの保存に失敗しました/,
    );
    assert.deepEqual(calls, [`copyMetrics:${PARENT_ID}->${CHILD_ID}`, `deleteMetrics:${CHILD_ID}`]);
    assert.deepEqual(registered, []);
    assert.equal(existsSync(join(childDir, "keep")), true, "既存の子は消さない");
  });
});

test("確定後の巻き戻しは record を外してから実測と子ディレクトリを消す", async () => {
  await withFiles(async (files) => {
    const childDir = sessionDirPath(files.storeDir, CHILD_ID);
    await mkdir(childDir, { recursive: true });
    await writeFile(join(childDir, "session.jsonl"), "{}\n");
    const { port, calls } = fakePort();
    await discardForkedSession(files, port, CHILD_ID);
    assert.deepEqual(calls, [`release:${CHILD_ID}`, `deleteMetrics:${CHILD_ID}`]);
    assert.equal(existsSync(childDir), false);
  });
});
