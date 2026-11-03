// 試行の一覧の取得順と操作の state。client に DOM テスト基盤が無いため、hook が使う controller を
// 直接動かして、遅い一覧応答が開始 / 中断の状態を巻き戻さないことと、注記・busy・実行中の判定を固定する。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createContentTrialsController,
  INITIAL_CONTENT_TRIALS_STATE,
  type ContentTrialsState,
} from "../src/lib/contentTrialsStore";
import type {
  ContentTrial,
  ContentTrialArtifactUsageValue,
  ContentTrialListResponse,
  ContentTrialStartResponse,
} from "../src/types";

const USAGE: ContentTrialArtifactUsageValue = { count: 1, bytes: 2_048 };

const RUNNING: ContentTrial = {
  id: "trial-1",
  kind: "image",
  model: "openrouter/openai/gpt-image-2",
  prompt: "a cat on a sofa",
  voice: null,
  instructions: null,
  speed: null,
  state: "running",
  keyEpoch: 0,
  artifactState: "none",
  artifact: null,
  charged: false,
  failureCode: null,
  failureMessage: null,
  startedAt: 1_000,
  finishedAt: null,
  durationMs: null,
  recorded: true,
};

const SUCCEEDED: ContentTrial = {
  ...RUNNING,
  state: "succeeded",
  artifactState: "stored",
  artifact: { format: "png", bytes: 2_048, width: 1_024, height: 1_024 },
  charged: true,
  finishedAt: 12_000,
  durationMs: 11_000,
};

const CANCELED: ContentTrial = {
  ...RUNNING,
  state: "canceled",
  failureCode: "aborted",
  finishedAt: 3_000,
  durationMs: 2_000,
};

function listResponse(items: ContentTrial[]): ContentTrialListResponse {
  return { items, keyEpoch: 0, artifactUsage: USAGE };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 一覧の応答を呼び出し順に差し替えられる controller。`lists` を使い切ったら空の一覧を返す */
function setup(
  lists: Array<Promise<ContentTrialListResponse>>,
  overrides: {
    list?: () => Promise<ContentTrialListResponse>;
    start?: () => Promise<ContentTrialStartResponse>;
    cancel?: () => Promise<unknown>;
  } = {},
) {
  let state: ContentTrialsState = INITIAL_CONTENT_TRIALS_STATE;
  const changes: ContentTrialsState[] = [];
  let reads = 0;
  const controller = createContentTrialsController({
    list: overrides.list ?? (() => lists[reads++] ?? Promise.resolve(listResponse([]))),
    start: overrides.start ?? (async () => ({ trial: RUNNING, reused: false })),
    cancel:
      (overrides.cancel as (() => Promise<{ trial: ContentTrial }>) | undefined) ?? (async () => ({ trial: CANCELED })),
    remove: async () => ({ removed: 1 }),
    removeAll: async () => ({ removed: 1 }),
    onChange: (next) => {
      state = next;
      changes.push(next);
    },
  });
  return { controller, changes, state: () => state };
}

/** 内部の `void load()` など、待てない promise の続きを進める */
function flush() {
  return new Promise((done) => setImmediate(done));
}

test("一覧の取得中に開始した試行を、遅れて届いた一覧の応答が巻き戻さない", async () => {
  const slow = deferred<ContentTrialListResponse>();
  const refresh = deferred<ContentTrialListResponse>();
  const view = setup([slow.promise, refresh.promise]);

  const listed = view.controller.reload();
  assert.equal(await view.controller.start({ kind: "image", model: RUNNING.model, prompt: RUNNING.prompt }), true);
  assert.deepEqual(
    view.state().trials?.map((trial) => trial.state),
    ["running"],
    "開始の応答で実行中の行を積む",
  );

  // 開始より前に発行した一覧（開始した行を含まない）が後から届いても、実行中の行を消さない
  slow.resolve(listResponse([SUCCEEDED]));
  assert.equal(await listed, false, "古い一覧の応答は適用しない");
  assert.deepEqual(
    view.state().trials?.map((trial) => trial.id),
    [RUNNING.id],
    "開始した行が残る",
  );
  assert.equal(view.state().running, true, "実行中の行が残るのでポーリングを止めない");

  // 開始の後に取り直した一覧は適用する
  refresh.resolve(listResponse([RUNNING]));
  await flush();
  assert.deepEqual(
    view.state().trials?.map((trial) => trial.state),
    ["running"],
  );
  assert.deepEqual(view.state().artifactUsage, USAGE, "保存容量も一覧の応答で追随する");
});

test("一覧の取得中に中断した試行を、遅れて届いた一覧の応答が実行中へ戻さない", async () => {
  const slow = deferred<ContentTrialListResponse>();
  const view = setup([
    Promise.resolve(listResponse([RUNNING])),
    slow.promise,
    // 中断の後に取り直した一覧（中断した行が載っている）
    Promise.resolve(listResponse([CANCELED])),
  ]);

  await view.controller.reload();
  assert.equal(view.state().running, true);

  const listed = view.controller.reload();
  assert.equal(await view.controller.cancel(RUNNING.id), true);
  await flush();
  assert.deepEqual(
    view.state().trials?.map((trial) => trial.state),
    ["canceled"],
  );

  slow.resolve(listResponse([RUNNING]));
  assert.equal(await listed, false, "中断より前に発行した一覧の応答は適用しない");
  assert.deepEqual(
    view.state().trials?.map((trial) => trial.state),
    ["canceled"],
    "中断した状態が残る",
  );
  assert.equal(view.state().running, false);
});

test("開始の注記は、その後の一覧の取り直しが失敗しても上書きしない", async () => {
  const view = setup([], {
    list: async () => {
      throw new Error("offline");
    },
  });
  await view.controller.start({ kind: "image", model: RUNNING.model, prompt: RUNNING.prompt });
  await flush();
  assert.deepEqual(view.state().note, {
    text: "試行を開始しました。画面を離れても続きます。",
    error: false,
  });
  assert.deepEqual(
    view.state().trials?.map((trial) => trial.id),
    [RUNNING.id],
    "取り直せなくても開始の応答で積んだ行は残る",
  );
});

test("再利用のときは課金していないことを伝え、既存の行を差し替える", async () => {
  const view = setup(
    [
      Promise.resolve(listResponse([RUNNING])),
      // 開始の後に取り直した一覧（同じ id が成功で載っている）
      Promise.resolve(listResponse([SUCCEEDED])),
    ],
    {
      start: async () => ({ trial: { ...SUCCEEDED, id: RUNNING.id }, reused: true }),
    },
  );
  await view.controller.reload();
  await view.controller.start({ kind: "image", model: RUNNING.model, prompt: RUNNING.prompt });
  await flush();
  assert.deepEqual(view.state().note, {
    text: "同じ入力の保存済みの結果を表示しています（課金していません）。",
    error: false,
  });
  assert.equal(view.state().trials?.length, 1, "同じ id の行を行として増やさない");
  assert.equal(view.state().trials?.[0]?.state, "succeeded");
});

test("busy は操作の間だけ立て、失敗は理由つきの注記にする", async () => {
  const start = deferred<ContentTrialStartResponse>();
  const view = setup([], { start: () => start.promise });
  const started = view.controller.start({ kind: "image", model: RUNNING.model, prompt: RUNNING.prompt });
  assert.equal(view.state().busy, true);
  start.reject(new Error("409"));
  assert.equal(await started, false);
  assert.equal(view.state().busy, false);
  assert.equal(view.state().note?.error, true);
  assert.match(view.state().note?.text ?? "", /試行を開始できませんでした/u);
});

test("別のタブで終端した試行の印は、そのタブを開いたら消える", async () => {
  const terminal = deferred<ContentTrialListResponse>();
  const view = setup([Promise.resolve(listResponse([RUNNING])), terminal.promise]);
  view.controller.setActiveSubsection("speech");
  await view.controller.reload();
  const listed = view.controller.reload();
  terminal.resolve(listResponse([SUCCEEDED]));
  assert.equal(await listed, true);
  assert.deepEqual(view.state().newResults, ["image"], "開いていないタブの印を立てる");
  view.controller.setActiveSubsection("image");
  assert.deepEqual(view.state().newResults, [], "開いたら消す");
});

test("画面を閉じた後の応答は適用しない", async () => {
  const slow = deferred<ContentTrialListResponse>();
  const view = setup([slow.promise]);
  const listed = view.controller.reload();
  const applied = view.changes.length;
  view.controller.dispose();
  slow.resolve(listResponse([SUCCEEDED]));
  assert.equal(await listed, false);
  assert.equal(view.changes.length, applied, "閉じた後に state を変えない");
});
