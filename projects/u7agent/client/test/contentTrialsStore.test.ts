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
  ContentTrialSummary,
} from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む。
// 取得の失敗の分類（404 とそれ以外）は本番と同じ関数を通す
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ApiError, contentTrialStartFailure, isMissingContentTrial } = await import("../src/api");

const USAGE: ContentTrialArtifactUsageValue = { count: 1, bytes: 2_048 };

const RUNNING: ContentTrial = {
  id: "trial-1",
  kind: "image",
  model: "openrouter/openai/gpt-image-2",
  promptPreview: "a cat on a sofa",
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

function listResponse(
  items: ContentTrialSummary[],
  nextBefore: string | null = null,
  artifactWarning?: ContentTrialListResponse["artifactWarning"],
): ContentTrialListResponse {
  return {
    items,
    keyEpoch: 0,
    artifactUsage: USAGE,
    ...(artifactWarning === undefined ? {} : { artifactWarning }),
    nextBefore,
    hasMore: nextBefore !== null,
  };
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
    list?: (query: {
      kind?: string;
      limit?: number;
      before?: string;
      state?: "running";
    }) => Promise<ContentTrialListResponse>;
    /** 全種別の実行中の行。既定は空（別種別の実行中が無い状態） */
    listRunning?: () => Promise<ContentTrialListResponse>;
    get?: (id: string) => Promise<{ trial: ContentTrial }>;
    /** 取得の失敗の分類。既定は本番と同じ 404 判定 */
    isMissing?: (error: unknown) => boolean;
    start?: () => Promise<ContentTrialStartResponse>;
    /** 開始の拒否の分類。既定は本番と同じ `code` の判定 */
    startFailure?: (error: unknown) => "disk_shortage" | "other";
    cancel?: () => Promise<unknown>;
  } = {},
) {
  let state: ContentTrialsState = INITIAL_CONTENT_TRIALS_STATE;
  const changes: ContentTrialsState[] = [];
  let reads = 0;
  const controller = createContentTrialsController({
    list:
      overrides.list ??
      ((query) => {
        // 種別を絞った取得も同じ応答の列から返す（ページの順序だけを見るテストのため）
        void query;
        return lists[reads++] ?? Promise.resolve(listResponse([]));
      }),
    listRunning: overrides.listRunning ?? (async () => listResponse([])),
    get: overrides.get ?? (async (id) => ({ trial: { ...RUNNING, id } })),
    isMissing: overrides.isMissing ?? isMissingContentTrial,
    start: overrides.start ?? (async () => ({ trial: RUNNING, reused: false })),
    startFailure: overrides.startFailure ?? contentTrialStartFailure,
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

test("保存容量の警告は一覧の応答から取り、返さない応答では前の警告を残さない", async () => {
  const warning = { thresholdBytes: 1024 ** 3, warning: true };
  let responding: ContentTrialListResponse["artifactWarning"] = warning;
  const view = setup([], {
    list: async () => listResponse([SUCCEEDED], null, responding),
    listRunning: async () => listResponse([], null, responding),
  });
  await view.controller.reload();
  assert.deepEqual(view.state().artifactWarning, warning);

  // しきい値と判定は応答が正。返さない応答（旧い server）では警告を出さない
  responding = undefined;
  await view.controller.reload();
  assert.equal(view.state().artifactWarning, null);
});

test("開始拒否が空き不足のときは、他の開始失敗と別の文言で課金の有無を伝える", async () => {
  const view = setup([], {
    start: async () => {
      throw new ApiError("保存先のディスクの空きが足りないため、試行を開始できませんでした", 503, {
        code: "disk_shortage",
      });
    },
  });
  const started = view.controller.start({ kind: "image", model: RUNNING.model, prompt: RUNNING.prompt });
  assert.equal(await started, false);
  assert.equal(view.state().note?.error, true);
  assert.match(view.state().note?.text ?? "", /履歴にも課金にも残りません/u);
  assert.equal(view.state().trials, null, "開始拒否は行を作らない");
  assert.equal(view.state().busy, false);
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

test("続きのページは末尾に足し、hasMore が false になったら読まない", async () => {
  const view = setup([
    Promise.resolve(listResponse([SUCCEEDED], "cursor-1")),
    Promise.resolve(listResponse([{ ...CANCELED, id: "trial-2" }], null)),
  ]);
  await view.controller.reload();
  assert.equal(view.state().hasMore, true);
  assert.equal(view.state().trials?.length, 1);

  assert.equal(await view.controller.loadMore(), true);
  assert.equal(view.state().hasMore, false);
  assert.deepEqual(
    view.state().trials?.map((trial) => trial.id),
    ["trial-1", "trial-2"],
    "古い行を末尾に足す（先頭ページを置き換えない）",
  );
  assert.equal(await view.controller.loadMore(), false, "続きが無ければ要求しない");
});

test("実行中のポーリングは running の行だけを取り、終端した行は詳細で確定させる", async () => {
  // サーバーの行の状態。ポーリングの応答から消えたときだけ終端になる
  let server: ContentTrial = { ...RUNNING };
  const view = setup([Promise.resolve(listResponse([])), Promise.resolve(listResponse([RUNNING]))], {
    listRunning: async () => listResponse(server.state === "running" ? [server] : []),
    get: async (id) => ({ trial: { ...server, id } }),
  });
  await view.controller.reload();

  // 一覧で実行中の行を積む（開始の応答と同じ経路）
  await view.controller.start({ kind: "image", model: RUNNING.model, prompt: RUNNING.prompt });
  await flush();
  view.controller.select(RUNNING.id);
  await flush();
  assert.equal(view.state().running, true);
  assert.equal(view.state().detail?.state, "running");

  // running の応答から消えたら、全文を取って終端に確定させる（実行中のまま残さない）
  server = { ...SUCCEEDED };
  await view.controller.poll();
  assert.equal(view.state().trials?.[0]?.state, "succeeded");
  assert.equal(view.state().running, false);
  assert.equal(view.state().detail?.state, "succeeded", "選択行の全文も追随する");
});

test("実行中のポーリングは、別の種別の実行中の行を重ねる（タブの印とポーリングを止めない）", async () => {
  const speechRunning: ContentTrial = { ...RUNNING, id: "trial-speech", kind: "speech" };
  const view = setup([Promise.resolve(listResponse([SUCCEEDED]))], {
    listRunning: async () => listResponse([speechRunning]),
  });
  await view.controller.reload();
  assert.deepEqual(
    view.state().trials?.map((trial) => trial.id),
    ["trial-speech", "trial-1"],
    "別種別の実行中の行を先頭に重ねる",
  );
  assert.equal(view.state().running, true);
});

test("実行中の応答から消えた行は、詳細が 404 のときだけ一覧から落とす", async () => {
  const view = setup([], {
    listRunning: async () => listResponse([]),
    get: async () => {
      throw new ApiError("試行が見つかりません", 404);
    },
  });
  await view.controller.reload();
  await view.controller.start({ kind: "image", model: RUNNING.model, prompt: RUNNING.prompt });
  await flush();
  await view.controller.poll();
  assert.deepEqual(view.state().trials, [], "404 は削除された行として落とす");
});

test("詳細の取得が通信断や 5xx で失敗しても、実行中の行は残して次のポーリングで取り直す", async () => {
  // 選択中の行（ポーリングのたびに全文を引きに行く行）が失敗する経路
  let server: ContentTrial = { ...RUNNING };
  let failures = 0;
  const view = setup([Promise.resolve(listResponse([RUNNING]))], {
    listRunning: async () => listResponse([]),
    get: async (id) => {
      if (server.state === "running" && failures < 2) {
        failures += 1;
        throw failures === 1
          ? new ApiError("アプリデータ（SQLite）を利用できません", 500)
          : new TypeError("fetch failed");
      }
      return { trial: { ...server, id } };
    },
  });
  await view.controller.reload();
  view.controller.select(RUNNING.id);
  await flush();

  // 5xx で失敗: 一覧から消さず、実行中のまま残す（行が消えるとポーリングも止まる）
  await view.controller.poll();
  assert.deepEqual(
    view.state().trials?.map((trial) => [trial.id, trial.state]),
    [[RUNNING.id, "running"]],
    "500 では行を残す",
  );
  assert.equal(view.state().running, true, "ポーリング対象のまま残る");

  // 通信断でも同じ。次のポーリングで取得できれば終端へ確定する
  await view.controller.poll();
  assert.deepEqual(
    view.state().trials?.map((trial) => [trial.id, trial.state]),
    [[RUNNING.id, "running"]],
    "通信断でも行を残す",
  );
  server = { ...SUCCEEDED };
  await view.controller.poll();
  assert.equal(view.state().trials?.[0]?.state, "succeeded", "回復したポーリングで確定する");
  assert.equal(view.state().running, false);
});

test("選択した行の全文は 1 回だけ取り、同じ行を選び直しても取り直さない", async () => {
  let reads = 0;
  const view = setup([Promise.resolve(listResponse([SUCCEEDED]))], {
    get: async (id) => {
      reads += 1;
      return { trial: { ...SUCCEEDED, id } };
    },
  });
  await view.controller.reload();
  view.controller.select(SUCCEEDED.id);
  await flush();
  assert.equal(view.state().detail?.id, SUCCEEDED.id);
  assert.equal(view.state().detail?.prompt, SUCCEEDED.prompt);
  assert.equal(await view.controller.loadDetail(SUCCEEDED.id), view.state().detail, "控えを返す");
  view.controller.select(null);
  assert.equal(view.state().detail, null);
  assert.equal(reads, 1);
});

test("選択行の全文はポーリングでも取り直す（終端を記録できていなかった行が回復する）", async () => {
  const unrecorded: ContentTrial = { ...SUCCEEDED, recorded: false };
  let server: ContentTrial = { ...RUNNING };
  const view = setup([Promise.resolve(listResponse([RUNNING]))], {
    listRunning: async () => listResponse([]),
    get: async (id) => ({ trial: { ...server, id } }),
  });
  await view.controller.reload();
  view.controller.select(RUNNING.id);
  await flush();
  assert.equal(view.state().detail?.recorded, true);

  // 終端の記録に失敗している間は recorded: false、DB が回復したら次のポーリングで true に戻る
  server = unrecorded;
  await view.controller.poll();
  assert.equal(view.state().detail?.recorded, false);
  server = { ...SUCCEEDED };
  await view.controller.poll();
  assert.equal(view.state().detail?.recorded, true);
});

test("一覧は開いている種別で絞り、種別が変わったらその種別で取り直す", async () => {
  const queries: (string | undefined)[] = [];
  const view = setup([], {
    list: async (query) => {
      queries.push(query.kind);
      return listResponse([]);
    },
  });
  await view.controller.open("image");
  view.controller.setKind("speech");
  await flush();
  // 同じ種別をもう一度指定しても取り直さない
  view.controller.setKind("speech");
  await flush();
  view.controller.setKind(null);
  await flush();
  assert.deepEqual(queries, ["image", "speech", undefined], "種別を絞らないときは kind を送らない");
});
