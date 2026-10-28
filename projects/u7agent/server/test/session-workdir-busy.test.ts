// 同じ作業フォルダを使う会話の busy 判定。共有の受付はこの判定だけで「書き換え途中の成果物を
// 公開しない」を決めるため、record.workdir の一致と isBusy の対応を store の実物で固定する
// (service のテストは fake を注入するので、ここが壊れても気づけない)。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";

const CWD = "/workspace";

/** プロジェクトの存在確認と会話の作業フォルダ作成だけを引き受ける (実ファイルは触らない) */
function stubWorkspace(): SandboxWorkspaceClient {
  return {
    createDir: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
  } as unknown as SandboxWorkspaceClient;
}

async function openBff() {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-workdir-busy-"));
  const bff = await createBffApp({
    cwd: CWD,
    sessionStoreDir: dir,
    pi: asPiBff(createStubPi()),
    workspace: stubWorkspace(),
  });
  return {
    bff,
    close: async () => {
      await bff.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("同じ作業フォルダの兄弟会話が実行中なら busy、別フォルダと未所属は巻き込まない", async () => {
  const { bff, close } = await openBff();
  try {
    const project = bff.projects.create({ cwd: "projects/app" });
    const first = await bff.store.create({ projectId: project.id });
    const second = await bff.store.create({ projectId: project.id });
    const unowned = await bff.store.create({});
    // プロジェクト会話は同じ cwd、未所属は会話ごとの scratch
    assert.equal(first.workdir, "projects/app");
    assert.equal(second.workdir, first.workdir);
    assert.notEqual(unowned.workdir, first.workdir);

    // idle の兄弟がいるだけでは busy にしない
    assert.equal(bff.store.busyInWorkdir(first.workdir), false);

    bff.store.postMessage(first, "こんにちは");
    await waitFor(() => bff.store.busyInWorkdir(first.workdir), 2000, "first run started");

    // 自分が実行中でも、同じ cwd の兄弟 (idle) から見ても busy
    assert.equal(bff.store.busyInWorkdir(second.workdir), true);
    // 別の作業フォルダ (未所属の scratch) は巻き込まない
    assert.equal(bff.store.busyInWorkdir(unowned.workdir), false);

    await bff.store.stop(first).catch(() => undefined);
    await waitFor(() => !bff.store.busyInWorkdir(first.workdir), 5000, "run settled");
  } finally {
    await close();
  }
});

test("同じプロジェクトでも、所属が外れた会話の cwd は判定に使える (projectId に依存しない)", async () => {
  // store の判定は record.workdir だけを見るため、プロジェクト登録を解除して projectId が消えても
  // cwd が同じなら兄弟として扱える (client 側の先回りは projectId 依存なので、そこは BFF が受け止める)
  const { bff, close } = await openBff();
  try {
    const project = bff.projects.create({ cwd: "projects/app" });
    const first = await bff.store.create({ projectId: project.id });
    const second = await bff.store.create({ projectId: project.id });
    bff.projects.remove(project.id);
    await bff.store.releaseProject(project.cwd);

    bff.store.postMessage(first, "こんにちは");
    await waitFor(() => bff.store.busyInWorkdir(first.workdir), 2000, "run started after release");
    assert.equal(first.projectId, undefined, "所属が外れている");
    assert.equal(bff.store.busyInWorkdir(second.workdir), true, "cwd が同じなら兄弟として見る");

    await bff.store.stop(first).catch(() => undefined);
    await waitFor(() => !bff.store.busyInWorkdir(first.workdir), 5000, "run settled");
  } finally {
    await close();
  }
});
