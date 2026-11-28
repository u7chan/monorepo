// What: 一時共有の入口 (チャットのバー 2 形・設定 → ランタイムのカード) とダイアログの描画。
// 共有中の表示と停止がサービスの状態に関係なく出ること、始める入口がこの会話のアプリだけに出ること、
// ダイアログの 3 状態が出し分けられることを固定する。見た目と動きは自動テストしない。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeServiceCard } from "../src/components/RuntimeServiceCard";
import { ServeShareDialog } from "../src/components/ServeShareDialog";
import { ServedAppGroup, ServedAppIndicator, type ServedAppProps } from "../src/components/ServedAppStatus";
import { SingleColumnBar } from "../src/components/SingleColumnBar";
import { Topbar } from "../src/components/Topbar";
import { INITIAL_RUNTIME_SERVE_STATE, type RuntimeServeState } from "../src/lib/runtimeServe";
import type { ServeShareCandidate, ServeTunnelHandle, ServeTunnelNotice } from "../src/lib/serveTunnel";
import type { RuntimeServeStatus } from "../src/types";
import { activeTunnelStatus, serveProps, serveStatus, tunnelEntry, tunnelState, tunnelStatus } from "./serve-fixture";

/** location.hostname を使うリンク生成のための最小のグローバル (node には無い) */
function withLocation<T>(run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "app.test" } });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

/** 指定の文言を持つ、押せない button。別の button をまたいで一致しない */
function disabledButton(text: string): RegExp {
  return new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>)[\\s\\S])*${text}`);
}

const MINE = serveStatus({ reachable: true, owner: { kind: "mine", title: "ピアノゲーム" }, generation: "gen-1" });
const OTHER = serveStatus({ reachable: true, owner: { kind: "other", title: "別の会話" }, generation: "gen-2" });
const STOPPED = serveStatus();
const NO_RECORD = serveStatus({ command: null });
const SHARING = tunnelEntry({ state: { known: activeTunnelStatus() } });

function group(overrides: Partial<ServedAppProps>): string {
  return withLocation(() => renderToStaticMarkup(createElement(ServedAppGroup, serveProps(overrides))));
}

function indicator(overrides: Partial<ServedAppProps>): string {
  return withLocation(() => renderToStaticMarkup(createElement(ServedAppIndicator, serveProps(overrides))));
}

// サービスが稼働していない・別の会話のもの・実績が無い・状態を取得できない、のどれでも共有は続いている
const SERVICE_CASES: Array<[string, Partial<ServedAppProps>]> = [
  ["自分の会話のアプリ", { status: MINE }],
  ["他の会話のアプリ", { status: OTHER }],
  ["サービスが停止中", { status: STOPPED }],
  ["実績が無い (kind が none)", { status: NO_RECORD }],
  ["サービスの状態が未取得", { status: null }],
  ["サービスの状態の取得に失敗", { status: null, failed: true }],
];

test("desktop: 共有中は、サービスの状態に関係なく「共有中・残り N 分」と停止を出す", () => {
  for (const [name, props] of SERVICE_CASES) {
    const html = group({ ...props, tunnel: SHARING });
    assert.match(html, /共有中・残り 52 分/, name);
    assert.match(html, /共有を停止/, name);
    // 押すとダイアログを開く
    assert.match(html, /aria-haspopup="dialog"/, name);
  }
  // サービスの状態を取得できないときは、サービスの操作は隠れる (共有だけが残る)
  const failed = group({ status: MINE, failed: true, tunnel: SHARING });
  assert.ok(!failed.includes("サービスを開く"));
  assert.ok(!failed.includes("稼働中"));
});

test("singleColumn: 共有中は、サービスの状態に関係なくメニューに表示と停止を出す", () => {
  for (const [name, props] of SERVICE_CASES) {
    const html = indicator({ ...props, tunnel: SHARING });
    assert.match(html, /aria-label="共有中・残り 52 分。メニューを開く"/, name);
    assert.match(html, /共有の画面を開く/, name);
    assert.match(html, /共有を停止/, name);
  }
  // 稼働中なら、サービスの操作と共有の操作が 1 つのメニューに並ぶ
  const mine = indicator({ status: MINE, tunnel: SHARING });
  assert.match(mine, /サービスを開く/);
  assert.ok(mine.indexOf("サービスを開く") < mine.indexOf("共有の画面を開く"));
  // 停止中のサービスの起動も、共有中はメニューから選べる (直接の起動ボタンに置き換えない)
  const stopped = indicator({ status: STOPPED, tunnel: SHARING });
  assert.match(stopped, /popover="auto"/);
  assert.match(stopped, /起動/);
});

test("共有の準備中は、準備中の表示と中断を出す", () => {
  const starting = tunnelEntry({ state: { starting: true } });
  assert.match(group({ status: MINE, tunnel: starting }), /共有を準備中…[\s\S]*準備を中断/);
  assert.match(indicator({ status: MINE, tunnel: starting }), /共有を準備中…[\s\S]*準備を中断/);
});

test("始める入口は、この会話のアプリが稼働しているときだけ出し、他は設定 → ランタイムへ任せる", () => {
  assert.match(group({ status: MINE }), /aria-label="一時共有を開始"/);
  assert.match(indicator({ status: MINE }), /一時共有…/);
  for (const [name, props] of SERVICE_CASES.slice(1)) {
    assert.ok(!group(props).includes("一時共有"), `desktop ${name}`);
    assert.ok(!indicator(props).includes("一時共有"), `singleColumn ${name}`);
  }
  // 共有中は始める入口を重ねない
  assert.ok(!group({ status: MINE, tunnel: SHARING }).includes("一時共有を開始"));
  assert.ok(!indicator({ status: MINE, tunnel: SHARING }).includes("一時共有…"));
});

test("利用できないときは入口を出したまま押せなくし、理由を出す", () => {
  const unavailable = tunnelEntry({
    state: { known: tunnelStatus({ available: false, unavailableReason: "この環境では使えません" }) },
  });
  const desktop = group({ status: MINE, tunnel: unavailable });
  assert.match(desktop, /aria-label="一時共有（利用できません）"/);
  assert.ok(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="一時共有（利用できません）")/.test(desktop), "押せない");
  assert.match(desktop, /title="この環境では使えません"/);
  const menu = indicator({ status: MINE, tunnel: unavailable });
  assert.match(menu, /一時共有…/);
  assert.match(menu, /この環境では使えません/);
  assert.match(menu, disabledButton("一時共有…"));
});

test("共有していなくて、サービスも出さないときは何も描かない", () => {
  for (const props of [serveProps({ status: null }), serveProps({ failed: true }), serveProps({ status: NO_RECORD })]) {
    assert.equal(renderToStaticMarkup(createElement(ServedAppGroup, props)), "");
    assert.equal(renderToStaticMarkup(createElement(ServedAppIndicator, props)), "");
  }
});

const NOTICE: ServeTunnelNotice = {
  at: 1,
  reason: "expired",
  text: "共有の期限が切れました。URL は無効になりました。",
};

test("バーは共有の終了の通知と停止の失敗を 1 行ずつ出し、通知は閉じられる", () => {
  const props = {
    scope: { label: "未所属", project: false, root: "" },
    runtimeStatus: { text: "", error: false },
    notify: { on: false, ring: 0, deliverable: true, onToggle: () => {} },
  };
  const serve = serveProps({
    tunnel: tunnelEntry({ notice: NOTICE, error: "共有を停止できませんでした: 接続できません" }),
  });
  const desktop = withLocation(() => renderToStaticMarkup(createElement(Topbar, { ...props, serve })));
  const compact = withLocation(() =>
    renderToStaticMarkup(
      createElement(SingleColumnBar, { ...props, serve, mode: "portrait", title: "会話", onOpenNav: () => {} }),
    ),
  );
  for (const html of [desktop, compact]) {
    assert.match(html, /共有の期限が切れました。URL は無効になりました。/);
    assert.match(html, /aria-label="共有の終了の通知を閉じる"/);
    assert.match(html, /共有を停止できませんでした: 接続できません/);
  }
  const quiet = withLocation(() => renderToStaticMarkup(createElement(Topbar, { ...props, serve: serveProps() })));
  assert.ok(!quiet.includes("共有の終了の通知を閉じる"));
});

const RUNNING: RuntimeServeStatus = {
  reachable: true,
  owner: { sessionId: "session-a", title: "会話A" },
  generation: "gen-a",
  command: { cwd: "app", command: "pnpm dev" },
};
const STOPPED_RUNTIME: RuntimeServeStatus = { reachable: false, owner: null, generation: null, command: null };

function card(state: Partial<RuntimeServeState>, tunnel = tunnelEntry()): string {
  return renderToStaticMarkup(
    createElement(RuntimeServiceCard, {
      state: { ...INITIAL_RUNTIME_SERVE_STATE, loading: false, ...state },
      hostname: "localhost",
      port: 8016,
      tunnel,
      onStop: () => {},
    }),
  );
}

test("設定 → ランタイム: 稼働中なら、誰が起動したアプリでも「一時共有…」を出す", () => {
  assert.match(card({ status: RUNNING }), /一時共有…/);
  // 起動元不明でも対象にする
  assert.match(card({ status: { ...RUNNING, owner: null, command: null } }), /一時共有…/);
  // 停止中・取得失敗・取得中、サービスの操作中は始める入口を出さない
  for (const state of [
    { status: STOPPED_RUNTIME },
    { failed: true },
    { loading: true },
    { status: RUNNING, stopping: true },
    { status: RUNNING, starting: "session-b" },
  ]) {
    assert.ok(!card(state).includes("一時共有…"), JSON.stringify(state));
  }
});

test("設定 → ランタイム: 共有中の表示と停止は、サービスが停止中でも取得に失敗していても残す", () => {
  for (const state of [{ status: RUNNING }, { status: STOPPED_RUNTIME }, { failed: true }, { loading: true }]) {
    const html = card(state, SHARING);
    assert.match(html, /共有中・残り 52 分/, JSON.stringify(state));
    assert.match(html, /共有を停止/, JSON.stringify(state));
    assert.match(html, /共有の画面を開く/, JSON.stringify(state));
  }
  // サービスの停止中の表示は、そのまま出る
  assert.match(card({ status: STOPPED_RUNTIME }, SHARING), /現在公開中のサービスはありません。/);
});

test("設定 → ランタイム: 利用できないときは押せなくして理由を出し、共有が無く何も無いときは区画を出さない", () => {
  const unavailable = tunnelEntry({
    state: { known: tunnelStatus({ available: false, unavailableReason: "この環境では使えません" }) },
  });
  const html = card({ status: RUNNING }, unavailable);
  assert.match(html, disabledButton("一時共有…"));
  assert.match(html, /この環境では使えません/);
  const quiet = card({ status: STOPPED_RUNTIME });
  assert.ok(!quiet.includes("一時共有"));
  // 終了の通知は、共有が無くても出る
  assert.match(card({ status: STOPPED_RUNTIME }, tunnelEntry({ notice: NOTICE })), /共有の期限が切れました/);
});

function handle(overrides: Partial<ServeTunnelHandle> = {}): ServeTunnelHandle {
  return {
    state: tunnelState(),
    notice: null,
    start: async () => ({ kind: "cancelled" }),
    stop: async () => {},
    reload: async () => {},
    dismissNotice: () => {},
    ...overrides,
  };
}

const CANDIDATE: ServeShareCandidate = {
  generation: "gen-1",
  target: { title: "ピアノゲーム", cwd: "projects/piano", command: "pnpm dev --host" },
};

function dialog(tunnel: ServeTunnelHandle, candidate: ServeShareCandidate | null = CANDIDATE): string {
  return renderToStaticMarkup(createElement(ServeShareDialog, { tunnel, candidate, onClose: () => {} }));
}

test("ダイアログ(確認): 対象・期限・注意を出し、既定の期限は 1 時間で、開始と取り消しを並べる", () => {
  const html = dialog(handle());
  assert.match(html, /aria-label="一時共有"/);
  // 対象: 起動元の会話・作業ディレクトリ・起動コマンド
  assert.match(html, /ピアノゲーム/);
  assert.match(html, /projects\/piano/);
  assert.match(html, /pnpm dev --host/);
  // 期限は 3 つで、既定は 1 時間
  for (const label of ["15 分", "1 時間", "3 時間"]) assert.match(html, new RegExp(`>${label}</button>`));
  assert.match(html, /aria-pressed="true"[^>]*>1 時間<\/button>/);
  assert.match(html, /aria-pressed="false"[^>]*>15 分<\/button>/);
  // 注意は畳んだ 1 行で要点が読め、中身も読める
  assert.match(html, /<details/);
  assert.match(html, /URL を知っていれば誰でも開けます/);
  assert.match(html, /WebSocket（HMR）は通りません/);
  // 主操作は開始で、取り消しは「キャンセル」。共有が無い間は QR を出さない
  assert.match(html, /キャンセル/);
  assert.match(html, /共有を開始/);
  assert.ok(!html.includes('role="img"'));
});

test("ダイアログ(確認): 起動元が分からない対象は不明と出す", () => {
  const html = dialog(handle(), { generation: "gen-9", target: { title: null, cwd: null, command: null } });
  assert.equal(html.match(/>不明</g)?.length, 3);
});

test("ダイアログ(確認): 開始できない理由を出し、開始は押せない", () => {
  const disabledStart = disabledButton("共有を開始");
  const unavailable = dialog(
    handle({
      state: tunnelState({
        known: tunnelStatus({ available: false, unavailableReason: "この環境では使えません" }),
      }),
    }),
  );
  assert.match(unavailable, /この環境では使えません/);
  assert.match(unavailable, disabledStart);

  const noTarget = dialog(handle(), null);
  assert.match(noTarget, /共有できるサービスがありません/);
  assert.match(noTarget, disabledStart);

  const loading = dialog(handle({ state: tunnelState({ known: null, status: null, loading: true }) }));
  assert.match(loading, /共有の状態を取得しています/);
  assert.match(loading, disabledStart);
  const failed = dialog(handle({ state: tunnelState({ known: null, status: null, failed: true }) }));
  assert.match(failed, /role="alert"[^>]*>共有の状態を取得できません/);
});

test("ダイアログ(確認): 共有が終わった理由を、閉じられる 1 行で出す", () => {
  const html = dialog(handle({ notice: NOTICE }));
  assert.match(html, /共有の期限が切れました。URL は無効になりました。/);
  assert.match(html, /aria-label="共有の終了の通知を閉じる"/);
});

test("ダイアログ(起動中): 進行を示し、開始の中断と閉じるを出して、開始は出さない", () => {
  const html = dialog(handle({ state: tunnelState({ starting: true }) }));
  assert.match(html, /共有を準備しています…/);
  assert.match(html, /この画面を閉じても準備は続きます/);
  assert.match(html, /準備を中断/);
  assert.match(html, />閉じる</);
  assert.ok(!html.includes("共有を開始"));
  assert.match(html, /aria-busy="true"/);
  // サーバーが準備中のとき (別の端末で始めた共有や再読み込み) も同じ
  const server = dialog(handle({ state: tunnelState({ known: tunnelStatus({ state: "starting" }) }) }));
  assert.match(server, /共有を準備しています…/);
});

test("ダイアログ(共有中): QR・URL・開く・コピー・残り時間・対象・停止を出し、閉じても続くことを示す", () => {
  const html = dialog(handle({ state: tunnelState({ known: activeTunnelStatus() }) }));
  const url = "https://quiet-example-demo.trycloudflare.com";
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="公開 URL の QR コード"/);
  assert.ok(html.includes(url));
  assert.ok(html.includes(`href="${url}"`));
  assert.match(html, /URL をコピー/);
  assert.match(html, /共有中・残り 52 分/);
  assert.match(html, /トップページの改修/);
  assert.match(html, /projects\/foo/);
  assert.match(html, /pnpm dev/);
  assert.match(html, /この画面を閉じても共有は続きます/);
  // 停止に確認は挟まない。主操作は停止で、取り消し側は「閉じる」
  assert.match(html, /共有を停止/);
  assert.match(html, />閉じる</);
  assert.ok(!html.includes("共有を開始"));
  assert.ok(!html.includes("キャンセル"));
});

test("ダイアログ(共有中): 取得できていないことと停止の失敗を示し、停止中は二重に押せない", () => {
  const stale = dialog(
    handle({
      state: tunnelState({ status: null, failed: true, known: activeTunnelStatus(), stopError: "接続できません" }),
    }),
  );
  assert.match(stale, /最新の状態を取得できていません/);
  assert.match(stale, /role="alert"[^>]*>共有を停止できませんでした: 接続できません/);
  // 取得に失敗していても、最後に分かっていた共有の停止は押せる
  assert.ok(!disabledButton("共有を停止").test(stale));
  const stopping = dialog(handle({ state: tunnelState({ known: activeTunnelStatus(), stopping: true }) }));
  assert.match(stopping, disabledButton("停止しています…"));
});
