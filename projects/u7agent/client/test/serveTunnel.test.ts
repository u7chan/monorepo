// What: 一時共有の画面の契約。残り時間・終了の通知の規則・開始と停止のコントローラー・入口の出し分けを固定する。
// 描画 (入口 2 か所とダイアログ) は serveTunnelEntry.test.ts が見る。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createServeTunnelController,
  createServeTunnelNotices,
  createServeTunnelReloadGroup,
  DEFAULT_SERVE_TUNNEL_TTL,
  INITIAL_SERVE_TUNNEL_STATE,
  isShareConfirmationStale,
  isShownStartFailure,
  nextShareConfirmation,
  runtimeShareCandidate,
  SERVE_TUNNEL_TTL_OPTIONS,
  serveTunnelRemaining,
  serveTunnelStopErrorText,
  serveTunnelTargetRows,
  serveTunnelView,
  shouldSkipServeTunnelFetch,
  type ServeTunnelNotices,
  type ServeTunnelState,
} from "../src/lib/serveTunnel";
import { servedAppShareCandidate, servedAppView } from "../src/lib/servedApp";
import type { RuntimeServeStatus, ServeTunnelStartBody, ServeTunnelStatus } from "../src/types";
import { activeTunnelStatus, serveStatus, TUNNEL_NOW, tunnelState, tunnelStatus } from "./serve-fixture";

const MINUTE = 60_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function failure(message: string, status?: number): Error {
  return Object.assign(new Error(message), status === undefined ? {} : { status });
}

const startBody: ServeTunnelStartBody = { generation: "gen-a", ttlMinutes: 60 };

function setup(overrides: Partial<Parameters<typeof createServeTunnelController>[0]> = {}) {
  let state: ServeTunnelState = INITIAL_SERVE_TUNNEL_STATE;
  let clock = TUNNEL_NOW;
  const changes: ServeTunnelState[] = [];
  const calls = { get: 0, start: [] as ServeTunnelStartBody[], stop: 0 };
  const notices = createServeTunnelNotices();
  const controller = createServeTunnelController({
    getStatus: async () => {
      calls.get += 1;
      return tunnelStatus();
    },
    start: async (input) => {
      calls.start.push(input);
      return activeTunnelStatus();
    },
    stop: async () => {
      calls.stop += 1;
      return tunnelStatus({ lastEnded: { reason: "stopped", at: TUNNEL_NOW } });
    },
    notices,
    now: () => clock,
    onChange: (next) => {
      state = next;
      changes.push(next);
    },
    ...overrides,
  });
  return {
    controller,
    calls,
    notices,
    changes,
    state: () => state,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("残り時間は分単位に切り上げ、1 分未満と期限切れは同じ文言にする", () => {
  const at = (ms: number) => serveTunnelRemaining(TUNNEL_NOW + ms, TUNNEL_NOW);
  assert.equal(at(MINUTE - 1), "まもなく終了");
  assert.equal(at(0), "まもなく終了");
  assert.equal(at(-5 * MINUTE), "まもなく終了", "期限が過ぎても負の値を出さない");
  assert.equal(at(MINUTE), "残り 1 分");
  assert.equal(at(MINUTE + 1), "残り 2 分", "切り上げるので、15 分で始めた直後は 15 分と読める");
  assert.equal(at(15 * MINUTE), "残り 15 分");
  assert.equal(at(59 * MINUTE), "残り 59 分");
  assert.equal(at(60 * MINUTE), "残り 1 時間");
  assert.equal(at(90 * MINUTE), "残り 1 時間 30 分");
  assert.equal(at(180 * MINUTE), "残り 3 時間");
});

test("期限の選択肢は 15 分 / 1 時間 / 3 時間で、既定は 1 時間", () => {
  assert.deepEqual(
    SERVE_TUNNEL_TTL_OPTIONS.map((option) => [option.value, option.label]),
    [
      [15, "15 分"],
      [60, "1 時間"],
      [180, "3 時間"],
    ],
  );
  assert.equal(DEFAULT_SERVE_TUNNEL_TTL, 60);
});

test("確認の内容は起動元・作業ディレクトリ・コマンドを出し、分からないものは不明と出す", () => {
  const known = serveTunnelTargetRows({ title: "トップページの改修", cwd: "projects/foo", command: "pnpm dev" });
  assert.deepEqual(
    known.map((row) => [row.label, row.value, row.mono]),
    [
      ["起動元の会話", "トップページの改修", false],
      ["作業ディレクトリ", "projects/foo", true],
      ["起動コマンド", "pnpm dev", true],
    ],
  );
  const unknown = serveTunnelTargetRows({ title: null, cwd: null, command: null });
  assert.deepEqual(
    unknown.map((row) => row.value),
    ["不明", "不明", "不明"],
  );
  // 作業ディレクトリが root なら空文字で返る。タイトルが空の会話は無題として出す
  const root = serveTunnelTargetRows({ title: "", cwd: "", command: "node server.js" });
  assert.deepEqual(
    root.map((row) => row.value),
    ["無題のセッション", ".", "node server.js"],
  );
});

test("設定 → ランタイムは誰が起動したアプリでも対象にし、起動元が分からなければ不明のまま残す", () => {
  const running: RuntimeServeStatus = {
    reachable: true,
    owner: { sessionId: "s1", title: "会話A" },
    generation: "gen-a",
    command: { cwd: "app", command: "pnpm dev" },
  };
  assert.deepEqual(runtimeShareCandidate(running), {
    generation: "gen-a",
    target: { title: "会話A", cwd: "app", command: "pnpm dev" },
  });
  assert.deepEqual(runtimeShareCandidate({ ...running, owner: null, command: null })?.target, {
    title: null,
    cwd: null,
    command: null,
  });
  assert.equal(runtimeShareCandidate({ ...running, reachable: false, generation: null }), null);
  assert.equal(runtimeShareCandidate({ ...running, generation: null }), null);
  assert.equal(runtimeShareCandidate(null), null);
});

test("チャットは、この会話が起動して稼働中のアプリだけを共有の対象にする", () => {
  const mine = serveStatus({
    reachable: true,
    owner: { kind: "mine", title: "ピアノゲーム" },
    generation: "gen-1",
  });
  assert.equal(servedAppView(mine).canShare, true);
  assert.deepEqual(servedAppShareCandidate(mine), {
    generation: "gen-1",
    target: { title: "ピアノゲーム", cwd: "projects/foo", command: "pnpm dev" },
  });
  const others = [
    serveStatus({ reachable: true, owner: { kind: "other", title: "別の会話" }, generation: "gen-2" }),
    serveStatus({ reachable: true, owner: { kind: "unknown" }, generation: "gen-3" }),
    serveStatus({ reachable: false, owner: { kind: "none" }, generation: null }),
  ];
  for (const status of others) {
    assert.equal(servedAppView(status).canShare, false, status.owner.kind);
    assert.equal(servedAppShareCandidate(status), null, status.owner.kind);
  }
  // 実績が無くても、この会話の稼働中のアプリなら共有できる。分からない項目は確認に不明と出す
  const noCommand = serveStatus({ reachable: true, owner: { kind: "mine" }, command: null, generation: "gen-4" });
  assert.deepEqual(servedAppShareCandidate(noCommand)?.target, { title: null, cwd: null, command: null });
  assert.equal(servedAppShareCandidate(null), null);
  assert.equal(servedAppShareCandidate(undefined), null);
});

test("開始が 409 で断られたときだけ、最新の対象で確認し直す", () => {
  const shown = { generation: "gen-a", target: { title: "A", cwd: "a", command: "pnpm dev" } };
  const live = { generation: "gen-b", target: { title: "B", cwd: "b", command: "python app.py" } };
  assert.equal(nextShareConfirmation(shown, live, { kind: "failed", error: "x", conflict: true }), live);
  assert.equal(nextShareConfirmation(shown, null, { kind: "failed", error: "x", conflict: true }), null);
  // 409 以外の失敗は、見せた内容のまま同じ操作で再試行させる
  assert.equal(nextShareConfirmation(shown, live, { kind: "failed", error: "x", conflict: false }), shown);
  assert.equal(nextShareConfirmation(shown, live, { kind: "started" }), shown);
  assert.equal(nextShareConfirmation(shown, live, { kind: "cancelled" }), shown);
});

test("見せた確認といまの対象が食い違う間は、世代の違いで検出して差し替えない", () => {
  const shown = { generation: "gen-a", target: { title: "A", cwd: "a", command: "pnpm dev" } };
  assert.equal(isShareConfirmationStale(shown, { ...shown }), false);
  // 同じ世代なら、表示の揺れ (タイトルの変更など) では確認し直させない
  assert.equal(
    isShareConfirmationStale(shown, { generation: "gen-a", target: { ...shown.target, title: "A2" } }),
    false,
  );
  assert.equal(
    isShareConfirmationStale(shown, {
      generation: "gen-b",
      target: { title: "B", cwd: "b", command: "python app.py" },
    }),
    true,
  );
  // 対象が無くなった / 新しく現れた場合も食い違い。どちらも無ければ食い違わない
  assert.equal(isShareConfirmationStale(shown, null), true);
  assert.equal(isShareConfirmationStale(null, shown), true);
  assert.equal(isShareConfirmationStale(null, null), false);
});

test("ダイアログが同じ開始の失敗を表示中のときだけ、失敗の終了の通知は重ねない", () => {
  const notice = { at: 1, reason: "failed", text: "共有の作成を拒否しました" } as const;
  assert.equal(isShownStartFailure(notice, "共有の作成を拒否しました"), true);
  assert.equal(isShownStartFailure(notice, undefined), false, "このダイアログが失敗を見せていない (閉じていた)");
  assert.equal(isShownStartFailure(notice, "別の文言"), false);
  assert.equal(isShownStartFailure(null, "共有の作成を拒否しました"), false);
  // 失敗以外の終了は、同じ文言でも重ねない扱いにしない
  assert.equal(isShownStartFailure({ ...notice, reason: "expired" }, notice.text), false);
});

test("状態の見え方は、共有中・準備中・利用不可・取得失敗を分け、取得失敗でも最後の共有を残す", () => {
  const idle = serveTunnelView(tunnelState());
  assert.deepEqual([idle.phase, idle.sharing, idle.badge], ["idle", false, null]);

  const active = serveTunnelView(tunnelState({ known: activeTunnelStatus() }));
  assert.deepEqual([active.phase, active.sharing, active.badge], ["active", true, "共有中・残り 52 分"]);
  assert.equal(active.remaining, "残り 52 分");
  assert.equal(active.stopLabel, "共有を停止");
  assert.equal(active.active?.url, "https://quiet-example-demo.trycloudflare.com");

  // 開始の応答待ち (手元) と、サーバーの starting のどちらも準備中。停止は開始の中断になる
  for (const state of [tunnelState({ starting: true }), tunnelState({ known: tunnelStatus({ state: "starting" }) })]) {
    const starting = serveTunnelView(state);
    assert.deepEqual([starting.phase, starting.sharing, starting.badge], ["starting", true, "共有を準備中…"]);
    assert.equal(starting.stopLabel, "準備を中断");
  }

  const unavailable = serveTunnelView(
    tunnelState({ known: tunnelStatus({ available: false, unavailableReason: "使えません (理由)" }) }),
  );
  assert.deepEqual(
    [unavailable.phase, unavailable.sharing, unavailable.unavailableReason],
    ["unavailable", false, "使えません (理由)"],
  );

  // 取得できていない間は共有の有無を言えない。共有中の状態を持っていれば、失敗しても出し続ける
  assert.equal(serveTunnelView(INITIAL_SERVE_TUNNEL_STATE).phase, "unknown");
  const stale = serveTunnelView(tunnelState({ status: null, failed: true, known: activeTunnelStatus() }));
  assert.deepEqual([stale.phase, stale.sharing, stale.stale], ["active", true, true]);
  assert.equal(serveTunnelView(tunnelState({ status: null, failed: true, known: null })).phase, "unknown");
});

test("残り時間は状態を公開した時刻から数え、描画のたびに時計を読まない", () => {
  const known = activeTunnelStatus();
  const at = (observedAt: number) => serveTunnelView(tunnelState({ known, observedAt })).badge;
  assert.equal(at(TUNNEL_NOW), "共有中・残り 52 分");
  assert.equal(at(TUNNEL_NOW + 30 * MINUTE), "共有中・残り 22 分");
  assert.equal(at(TUNNEL_NOW + 52 * MINUTE - 1), "共有中・まもなく終了");
});

test("利用不可が確定していて共有も無い間だけ取得を省く", () => {
  assert.equal(shouldSkipServeTunnelFetch(null), false, "初回は取る");
  assert.equal(shouldSkipServeTunnelFetch(tunnelStatus()), false);
  assert.equal(shouldSkipServeTunnelFetch(tunnelStatus({ available: false, unavailableReason: "理由" })), true);
  // 共有が残っているなら、利用不可でも状態を追う
  assert.equal(
    shouldSkipServeTunnelFetch(tunnelStatus({ available: false, unavailableReason: "理由", state: "active" })),
    false,
  );
});

test("停止の失敗は理由を添えて 1 行にする", () => {
  assert.equal(serveTunnelStopErrorText("接続できません"), "共有を停止できませんでした: 接続できません");
  assert.equal(serveTunnelStopErrorText(undefined), undefined);
  assert.equal(serveTunnelStopErrorText("  "), undefined);
});

function ended(
  reason: "stopped" | "expired" | "replaced" | "failed" | "exited",
  at: number,
  message?: string,
): ServeTunnelStatus {
  return tunnelStatus({ lastEnded: { reason, at, ...(message === undefined ? {} : { message }) } });
}

function track(notices: ServeTunnelNotices) {
  const seen: Array<ReturnType<ServeTunnelNotices["get"]>> = [];
  notices.subscribe(() => seen.push(notices.get()));
  return seen;
}

test("終了の通知: このタブが見ていた共有の終了を、理由ごとの文言で 1 回出す", () => {
  const notices = createServeTunnelNotices();
  notices.observe(activeTunnelStatus());
  assert.equal(notices.get(), null, "共有中は通知しない");
  notices.observe(ended("expired", TUNNEL_NOW));
  assert.equal(notices.get()?.reason, "expired");
  assert.match(notices.get()?.text ?? "", /期限が切れ/);

  for (const [reason, pattern] of [
    ["replaced", /入れ替わった/],
    ["exited", /予期せず終了/],
  ] as const) {
    const each = createServeTunnelNotices();
    each.observe(activeTunnelStatus());
    each.observe(ended(reason, TUNNEL_NOW));
    assert.match(each.get()?.text ?? "", pattern, reason);
  }

  // failed の文言はサーバーの固定文言をそのまま使う。無いときだけクライアントの代替
  const failed = createServeTunnelNotices();
  failed.observe(tunnelStatus());
  failed.observe(ended("failed", TUNNEL_NOW, "Cloudflare に接続できませんでした。時間を置いてから再試行してください"));
  assert.equal(failed.get()?.text, "Cloudflare に接続できませんでした。時間を置いてから再試行してください");
  const bare = createServeTunnelNotices();
  bare.observe(tunnelStatus());
  bare.observe(ended("failed", TUNNEL_NOW));
  assert.match(bare.get()?.text ?? "", /共有を開始できませんでした/);
});

test("終了の通知: 利用者の停止は出さず、最初の取得に残っていた古い終了も出さない", () => {
  const stopped = createServeTunnelNotices();
  stopped.observe(activeTunnelStatus());
  stopped.observe(ended("stopped", TUNNEL_NOW));
  assert.equal(stopped.get(), null);

  // 数時間後に開いた別のタブ: サーバーに残っている終了は、このタブが見ていないので出さない
  const fresh = createServeTunnelNotices();
  fresh.observe(ended("replaced", TUNNEL_NOW));
  fresh.observe(ended("replaced", TUNNEL_NOW));
  assert.equal(fresh.get(), null);
  // そのタブでも、このあとに終わった共有は出る
  fresh.observe(activeTunnelStatus());
  fresh.observe(ended("expired", TUNNEL_NOW + 3 * 60 * MINUTE));
  assert.equal(fresh.get()?.reason, "expired");
});

test("終了の通知: 取得の合間に始まって終わった共有も、最初の取得より後なら出す", () => {
  const notices = createServeTunnelNotices();
  notices.observe(tunnelStatus());
  notices.observe(ended("failed", TUNNEL_NOW, "固定文言"));
  assert.equal(notices.get()?.text, "固定文言");
});

test("終了の通知: at ごとに 1 回だけで、閉じたら同じ at では戻らず、新しい at は出す", () => {
  const notices = createServeTunnelNotices();
  const seen = track(notices);
  notices.observe(tunnelStatus());
  notices.observe(ended("expired", 100));
  const first = notices.get();
  assert.equal(first?.at, 100);
  // 入口が 2 か所で同じ状態を観測しても、通知は 1 件のまま (通知し直さない)
  notices.observe(ended("expired", 100));
  assert.equal(notices.get(), first);
  assert.equal(seen.length, 1);
  notices.dismiss();
  assert.equal(notices.get(), null);
  notices.observe(ended("expired", 100));
  assert.equal(notices.get(), null, "閉じた通知は同じ at で戻らない");
  // 古い応答が遅れて届いても、より古い at は出さない
  notices.observe(ended("replaced", 50));
  assert.equal(notices.get(), null);
  notices.observe(ended("replaced", 200));
  assert.equal(notices.get()?.at, 200);
});

test("終了の通知: 新しい共有が始まったら、前の終了の通知は消す", () => {
  const notices = createServeTunnelNotices();
  notices.observe(tunnelStatus());
  notices.observe(ended("expired", 100));
  assert.ok(notices.get());
  notices.observe(tunnelStatus({ state: "starting" }));
  assert.equal(notices.get(), null);
});

test("コントローラー: 開始の成功は応答を状態として適用し、直後に取り直して上書きしない", async () => {
  const view = setup();
  assert.deepEqual(await view.controller.start(startBody), { kind: "started" });
  assert.deepEqual(view.calls.start, [startBody]);
  assert.equal(view.state().status?.state, "active");
  assert.equal(view.state().known?.state, "active");
  assert.equal(view.state().starting, false);
  assert.equal(view.state().observedAt, TUNNEL_NOW, "公開した時刻は注入した時計から");
  await Promise.resolve();
  assert.equal(view.calls.get, 0, "成功の応答は開始の結果そのものなので、取得で上書きしない");
});

test("コントローラー: 開始の 409 は確認し直しの合図を返し、自動では再試行せず状態を取り直す", async () => {
  const view = setup({
    start: async () => {
      throw failure("サービスの状態が変わりました。最新の状態で確認し直してください", 409);
    },
  });
  const result = await view.controller.start(startBody);
  assert.deepEqual(result, {
    kind: "failed",
    error: "サービスの状態が変わりました。最新の状態で確認し直してください",
    conflict: true,
  });
  assert.equal(view.calls.get, 1, "状態を取り直す");
  assert.equal(view.state().starting, false);
});

test("コントローラー: 開始の 502 はサーバーの固定文言を返し、409 としては扱わない。通信の失敗は固定文言にする", async () => {
  const bad = setup({
    start: async () => {
      throw failure("Cloudflare が共有の作成を拒否しました。時間を置いてから再試行してください", 502);
    },
  });
  assert.deepEqual(await bad.controller.start(startBody), {
    kind: "failed",
    error: "Cloudflare が共有の作成を拒否しました。時間を置いてから再試行してください",
    conflict: false,
  });
  // HTTP の応答が無い (接続の失敗・期限切れ) ときは、内部の例外文言を出さない
  const offline = setup({
    start: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  const result = await offline.controller.start(startBody);
  assert.equal(result.kind, "failed");
  assert.ok(result.kind === "failed" && !result.error.includes("Failed to fetch"));
  assert.ok(result.kind === "failed" && result.error.includes("もう一度"));
});

test("コントローラー: 開始の二重押下は API を重ねず、停止との同時操作も受けない", async () => {
  const pending = deferred<ServeTunnelStatus>();
  const view = setup({ start: () => pending.promise });
  const first = view.controller.start(startBody);
  assert.equal(view.state().starting, true);
  assert.deepEqual(await view.controller.start(startBody), { kind: "cancelled" });
  pending.resolve(activeTunnelStatus());
  assert.deepEqual(await first, { kind: "started" });
  assert.equal(view.state().starting, false);
});

test("コントローラー: 遅れて届いた古い取得結果は、適用済みの開始の結果を上書きしない", async () => {
  const old = deferred<ServeTunnelStatus>();
  let reads = 0;
  const view = setup({
    getStatus: () => {
      reads += 1;
      return old.promise;
    },
  });
  const poll = view.controller.refresh();
  assert.equal(reads, 1);
  await view.controller.start(startBody);
  old.resolve(tunnelStatus());
  await poll;
  assert.equal(view.state().status?.state, "active", "開始より前に発行した取得の結果は捨てる");
});

test("コントローラー: 停止は冪等で、確認を挟まず、二重押下でも API を重ねない", async () => {
  const pending = deferred<ServeTunnelStatus>();
  const view = setup({ stop: () => pending.promise });
  const first = view.controller.stop();
  assert.equal(view.state().stopping, true);
  await view.controller.stop();
  pending.resolve(tunnelStatus());
  await first;
  assert.equal(view.state().stopping, false);
  assert.equal(view.state().status?.state, "idle");

  // 共有が無いときの停止も、同じ操作で idle を受け取って終わる
  const idle = setup();
  await idle.controller.stop();
  await idle.controller.stop();
  assert.equal(idle.calls.stop, 2);
  assert.equal(idle.state().stopError, undefined);
});

test("コントローラー: 停止の失敗は理由を残し、共有中の表示は消さない", async () => {
  const view = setup({
    getStatus: async () => activeTunnelStatus(),
    stop: async () => {
      throw failure("接続できません");
    },
  });
  await view.controller.refresh();
  await view.controller.stop();
  assert.equal(view.state().stopError, "接続できません");
  assert.equal(view.state().known?.state, "active");
  assert.equal(view.state().stopping, false);
});

test("コントローラー: 状態の取得に失敗しても、最後に分かっていた共有を表示でき、停止も押せる", async () => {
  let offline = false;
  const view = setup({
    getStatus: async () => {
      if (offline) throw new Error("offline");
      return activeTunnelStatus();
    },
  });
  await view.controller.refresh();
  offline = true;
  await view.controller.refresh();
  assert.equal(view.state().failed, true);
  assert.equal(view.state().status, null);
  const shown = serveTunnelView(view.state());
  assert.deepEqual([shown.sharing, shown.stale], [true, true]);
  await view.controller.stop();
  assert.equal(view.calls.stop, 1, "取得に失敗していても停止は送る");
});

test("コントローラー: 準備中の停止は開始を中断し、その開始の応答を失敗として見せず適用もしない", async () => {
  const pending = deferred<ServeTunnelStatus>();
  const view = setup({ start: () => pending.promise });
  const start = view.controller.start(startBody);
  await view.controller.stop();
  assert.equal(view.calls.stop, 1, "開始の応答を待たずに停止を送る");
  // サーバーが中断した開始は 409 で返ることがある。利用者の中断なので失敗として見せない
  pending.reject(failure("一時共有の開始を中断しました", 409));
  assert.deepEqual(await start, { kind: "cancelled" });
  assert.equal(view.state().starting, false);
  assert.equal(view.state().status?.state, "idle");

  // 停止が先に終わったあとに、active の応答が遅れて届いても適用しない
  const late = deferred<ServeTunnelStatus>();
  const raced = setup({ start: () => late.promise });
  const lateStart = raced.controller.start(startBody);
  await raced.controller.stop();
  late.resolve(activeTunnelStatus());
  assert.deepEqual(await lateStart, { kind: "cancelled" });
  assert.equal(raced.state().status?.state, "idle");
});

test("コントローラー: 利用不可が確定していて共有も無い間は取得を省き、再読み込みで再開する", async () => {
  const view = setup({
    getStatus: async () => tunnelStatus({ available: false, unavailableReason: "利用できません" }),
  });
  let reads = 0;
  const counted = setup({
    getStatus: async () => {
      reads += 1;
      return tunnelStatus({ available: false, unavailableReason: "利用できません" });
    },
  });
  await counted.controller.refresh();
  await counted.controller.refresh();
  await counted.controller.refresh();
  assert.equal(reads, 1, "確定したあとの周期の取得は省く");
  assert.equal(counted.state().status?.available, false, "直前の状態をそのまま残す");
  await counted.controller.refresh({ force: true });
  assert.equal(reads, 2, "再読み込みで取り直す");
  await view.controller.refresh();

  // 利用できるなら、周期のたびに取る (共有はサービスの稼働と独立に続く)
  const live = setup();
  await live.controller.refresh();
  await live.controller.refresh();
  assert.equal(live.calls.get, 2);
});

test("再読み込みは mount 中の全部の取り口を再開し、離れた取り口へは届けず、1 つの失敗で止まらない", async () => {
  const unavailable = () => tunnelStatus({ available: false, unavailableReason: "利用できません" });
  const reads = { chat: 0, runtime: 0 };
  const chat = setup({
    getStatus: async () => {
      reads.chat += 1;
      return unavailable();
    },
  });
  const runtime = setup({
    getStatus: async () => {
      reads.runtime += 1;
      return unavailable();
    },
  });
  await chat.controller.refresh();
  await runtime.controller.refresh();
  await chat.controller.refresh();
  await runtime.controller.refresh();
  assert.deepEqual(reads, { chat: 1, runtime: 1 }, "どちらも利用不可が確定して、周期の取得を省いている");

  const group = createServeTunnelReloadGroup();
  const leaveChat = group.join(() => chat.controller.refresh({ force: true }));
  group.join(() => Promise.reject(new Error("取り口の失敗")));
  group.join(() => runtime.controller.refresh({ force: true }));
  await group.reload();
  assert.deepEqual(reads, { chat: 2, runtime: 2 }, "設定 → ランタイムの再読み込み 1 回が、チャットの取り口も再開する");

  leaveChat();
  await group.reload();
  assert.deepEqual(reads, { chat: 2, runtime: 3 }, "画面を離れた取り口へは届けない");
});

test("コントローラー: 適用した状態を終了の通知の台帳へ渡す", async () => {
  let current: ServeTunnelStatus = activeTunnelStatus();
  const view = setup({ getStatus: async () => current });
  await view.controller.refresh();
  assert.equal(view.notices.get(), null);
  current = ended("replaced", TUNNEL_NOW + 1);
  await view.controller.refresh();
  assert.equal(view.notices.get()?.reason, "replaced");
});

test("コントローラー: 画面を閉じた後は取得・開始・停止の遅い応答を適用しない", async () => {
  const pending = deferred<ServeTunnelStatus>();
  const view = setup({ getStatus: () => pending.promise });
  const read = view.controller.refresh();
  view.controller.dispose();
  const count = view.changes.length;
  pending.resolve(activeTunnelStatus());
  await read;
  assert.equal(view.changes.length, count);
  assert.deepEqual(await view.controller.start(startBody), { kind: "cancelled" });
  await view.controller.stop();
  assert.deepEqual(view.calls.start, []);
  assert.equal(view.calls.stop, 0);
});
