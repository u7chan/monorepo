import assert from "node:assert/strict";

import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompactBar } from "../src/components/CompactBar";
import { Topbar } from "../src/components/Topbar";
import { SessionRow } from "../src/components/sidebar/SessionRow";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";
import { createNotifyCarry, createNotifyToggleRunner } from "../src/hooks/notifyToggle";
import {
  NOTIFY_DISABLED_NOTE,
  NOTIFY_UNCONFIGURED_NOTE,
  notifyCannotEnable,
  notifyDeliverable,
  notifyUnavailableNote,
} from "../src/lib/notifications";
import type { NotificationsResponse, SessionNotifyResponse, SessionSummary } from "../src/types";
import { serveProps } from "./serve-fixture";

const IDLE: RuntimeStatus = { text: "", error: false };
/** 鳴っているベルの目印 (BellIcon の ringing でだけ描かれる線) */

/** バーの作業先チップ / 作業先の前置。ラベルだけを見るテストなので値は固定でよい */
const SCOPE = { label: "work/hello", project: true, root: "work/hello" };

const SETTINGS: NotificationsResponse = {
  enabled: true,
  provider: "discord",
  configured: true,
  webhookHint: "a1b2",
  baseUrl: "http://127.0.0.1:5173",
  mention: "none",
};

/** 応答を保留したままの PATCH。解決するまで次の要求が送られないことを確かめる */
function pendingRequests() {
  const sent: [string, boolean][] = [];
  const gates: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  return {
    sent,
    gates,
    request: (sessionId: string, notify: boolean): Promise<SessionNotifyResponse> =>
      new Promise<SessionNotifyResponse>((resolve, reject) => {
        sent.push([sessionId, notify]);
        gates.push({
          resolve: () => resolve({ sessionId, notify }),
          reject: (error: unknown) => reject(error),
        });
      }),
    /** 送信済みの要求を順に解決できるよう、待機中のマイクロタスクを流す */
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

test("新規チャットは PATCH を送らず、作成時に引き継ぐ先行選択だけを切り替える", () => {
  const carry = createNotifyCarry();
  const runner = createNotifyToggleRunner({
    setPending: () => carry.toggle(),
    apply: () => assert.fail("セッション未作成で一覧の値を触った"),
    request: async (sessionId, notify) => {
      assert.fail("セッション未作成で PATCH を送った");
      return { sessionId, notify };
    },
    onError: () => assert.fail("セッション未作成で失敗にしない"),
  });
  runner.toggle("", carry.snapshot());
  assert.equal(carry.snapshot(), true, "先行選択が On にならない");
  // もう一度押すと Off に戻る (作成されるまで何度でも選べる)
  runner.toggle("", carry.snapshot());
  assert.equal(carry.snapshot(), false);
});

test("既存セッションは PATCH を送り、サーバーの応答を正として反映する", async () => {
  const applied: [string, boolean][] = [];
  const pending = pendingRequests();
  const runner = createNotifyToggleRunner({
    setPending: () => assert.fail("既存セッションで先行選択を触った"),
    apply: (sessionId, notify) => applied.push([sessionId, notify]),
    request: pending.request,
    onError: () => assert.fail("成功時に onError を呼んだ"),
  });
  runner.toggle("s-1", false);
  // 4 秒のポーリングを待たずに反映する
  assert.deepEqual(applied, [["s-1", true]]);
  await pending.flush();
  assert.deepEqual(pending.sent, [["s-1", true]], "現在値の反対を送らない");
  pending.gates[0]!.resolve();
  await pending.flush();
  // 応答の値を正として確定する (サーバーが別の値を返しても表示を揃える)
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", true],
  ]);
});

test("連打は会話単位で直列化し、後発のクリックを最終値にする", async () => {
  const applied: [string, boolean][] = [];
  const pending = pendingRequests();
  const runner = createNotifyToggleRunner({
    setPending: () => assert.fail("既存セッションで先行選択を触った"),
    apply: (sessionId, notify) => applied.push([sessionId, notify]),
    request: pending.request,
    onError: () => assert.fail("成功時に onError を呼んだ"),
  });
  runner.toggle("s-1", false); // On
  runner.toggle("s-1", true); // Off (楽観反映した値を読む)
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", false],
  ]);
  await pending.flush();
  assert.deepEqual(pending.sent, [["s-1", true]], "2 本目を並行して送っている");

  // 1 本目 (On) の応答が遅れて返っても、最新の Off を巻き戻さない
  pending.gates[0]!.resolve();
  await pending.flush();
  assert.deepEqual(pending.sent, [
    ["s-1", true],
    ["s-1", false],
  ]);
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", false],
  ]);

  // 2 本目 (Off) の応答で確定し、サーバーの最終値も最後の操作と一致する
  pending.gates[1]!.resolve();
  await pending.flush();
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", false],
    ["s-1", false],
  ]);
});

test("別の会話のトグルは互いを待たない", async () => {
  const pending = pendingRequests();
  const runner = createNotifyToggleRunner({
    setPending: () => assert.fail("既存セッションで先行選択を触った"),
    apply: () => {},
    request: pending.request,
    onError: () => assert.fail("成功時に onError を呼んだ"),
  });
  runner.toggle("s-1", false);
  runner.toggle("s-2", false);
  await pending.flush();
  assert.deepEqual(pending.sent, [
    ["s-1", true],
    ["s-2", true],
  ]);
});

test("最新の要求が失敗したら楽観反映を戻し、理由を状態行へ渡す", async () => {
  const applied: [string, boolean][] = [];
  const errors: unknown[] = [];
  const pending = pendingRequests();
  const runner = createNotifyToggleRunner({
    setPending: () => assert.fail("既存セッションで先行選択を触った"),
    apply: (sessionId, notify) => applied.push([sessionId, notify]),
    request: pending.request,
    onError: (error) => errors.push(error),
  });
  runner.toggle("s-1", false);
  await pending.flush();
  pending.gates[0]!.reject(new Error("HTTP 500"));
  await pending.flush();
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", false],
  ]);
  assert.equal((errors[0] as Error).message, "HTTP 500");
});

test("後発のクリックがあるときは、古い要求の失敗で表示も理由も触らない", async () => {
  const applied: [string, boolean][] = [];
  const errors: unknown[] = [];
  const pending = pendingRequests();
  const runner = createNotifyToggleRunner({
    setPending: () => assert.fail("既存セッションで先行選択を触った"),
    apply: (sessionId, notify) => applied.push([sessionId, notify]),
    request: pending.request,
    onError: (error) => errors.push(error),
  });
  runner.toggle("s-1", false); // On
  runner.toggle("s-1", true); // Off
  await pending.flush();
  // 1 本目が失敗しても、後発 (Off) が送られているのでロールバックも理由も出さない
  pending.gates[0]!.reject(new Error("HTTP 500"));
  await pending.flush();
  assert.deepEqual(errors, []);
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", false],
  ]);
  pending.gates[1]!.resolve();
  await pending.flush();
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", false],
    ["s-1", false],
  ]);
});

test("先行選択は作成の要求時に読み切り、応答待ちの切替で変わらない", async () => {
  const carry = createNotifyCarry();
  carry.toggle();
  const created = pendingRequests();
  // ensureSession と同じ順序: 要求の値は await の前に読み、完了で消費する
  const creation = (async () => {
    const notify = carry.beginCreate();
    const session = await created.request("s-1", notify.value);
    carry.consume(notify.generation);
    return { notify, session };
  })();

  // 応答待ちの間にユーザーがトグルを押しても、送信済みの要求の値は変わらない
  carry.toggle();
  created.gates[0]!.resolve();
  const result = await creation;
  assert.equal(result.notify.value, true, "作成要求の値が後からの切替で変わった");
  assert.equal(carry.snapshot(), false, "先行選択が次の新規チャットへ持ち越されている");
});

test("チャットを切り替えると先行選択を捨て、古い作成応答で選び直した値を消さない", () => {
  const carry = createNotifyCarry();
  carry.toggle(); // 「新しい会話 A」で On
  const request = carry.beginCreate();
  assert.equal(request.value, true);

  // 作成の応答待ちに「新しい会話 B」へ切り替える (A の On を持ち越さない)
  carry.reset();
  assert.equal(carry.snapshot(), false, "A の On が B へ持ち越されている");
  carry.toggle(); // B で On を選び直す
  carry.consume(request.generation); // その後に A の応答が届く
  assert.equal(carry.snapshot(), true, "古い作成応答が B の選択を消した");
});

test("作成の完了で先行選択を消費し、既に Off なら購読者へ通知しない", () => {
  const carry = createNotifyCarry();
  const subscribed: boolean[] = [];
  const unsubscribe = carry.subscribe(() => subscribed.push(carry.snapshot()));

  carry.toggle();
  assert.equal(carry.snapshot(), true);
  carry.consume(carry.beginCreate().generation);
  assert.equal(carry.snapshot(), false, "消費しても先行選択が残っている");
  // 既に Off のときは通知しない (無関係な再描画を起こさない)
  carry.consume(carry.beginCreate().generation);
  unsubscribe();
  carry.toggle();
  assert.deepEqual(subscribed, [true, false], "購読者への通知が過不足");
});

test("配信できない理由ごとに注記を返し、On の間は常に / Off では押した後だけ出す", () => {
  const disabled = { ...SETTINGS, enabled: false };
  const unconfigured = { ...SETTINGS, configured: false, webhookHint: undefined };
  // 配信できる設定 (有効 + Webhook 登録済み) では何も出さない
  assert.equal(notifyUnavailableNote(true, SETTINGS), undefined);
  assert.equal(notifyUnavailableNote(false, SETTINGS), undefined);
  // グローバル無効と Webhook 未設定で文面を分ける (設定を開いたときに直す場所が違う)
  assert.equal(notifyUnavailableNote(true, disabled), NOTIFY_DISABLED_NOTE);
  assert.equal(notifyUnavailableNote(true, unconfigured), NOTIFY_UNCONFIGURED_NOTE);
  // 設定が未取得の間は判定できない (誤った理由を出さない)
  assert.equal(notifyUnavailableNote(true, null), undefined);
  // Off では押した後だけ出す (設定が無効なだけの会話でバーを埋めない)
  assert.equal(notifyUnavailableNote(false, disabled, false), undefined);
  assert.equal(notifyUnavailableNote(false, disabled, true), NOTIFY_DISABLED_NOTE);
  // 設定が直れば消える
  assert.equal(notifyUnavailableNote(true, SETTINGS, true), undefined);
});

test("On にできないときだけ切替を禁止し、Off へ戻す操作は常に許可する", () => {
  const disabled = { ...SETTINGS, enabled: false };
  const unconfigured = { ...SETTINGS, configured: false };
  assert.equal(notifyCannotEnable(false, disabled), true);
  assert.equal(notifyCannotEnable(false, unconfigured), true);
  // On の会話は Off へ戻せる (機微な会話を止める逃げ道を残す)
  assert.equal(notifyCannotEnable(true, disabled), false);
  assert.equal(notifyCannotEnable(true, unconfigured), false);
  // 配信できる設定と、設定が未取得の間は押せる (起動直後に押せないと壊れて見える)
  assert.equal(notifyCannotEnable(false, SETTINGS), false);
  assert.equal(notifyCannotEnable(false, null), false);
});

test("配信できる設定かを、On へ戻せるかとは別に判定する", () => {
  const disabled = { ...SETTINGS, enabled: false };
  const unconfigured = { ...SETTINGS, configured: false };
  assert.equal(notifyDeliverable(SETTINGS), true);
  assert.equal(notifyDeliverable(disabled), false);
  assert.equal(notifyDeliverable(unconfigured), false);
  // 設定が未取得の間は判定できないので、色とラベルを変えない側に倒す
  assert.equal(notifyDeliverable(null), true);
  // 保存済みの On は、設定が無効でも Off へは戻せる (deliverable と notifyCannotEnable は別物)
  assert.equal(notifyDeliverable(disabled), false);
  assert.equal(notifyCannotEnable(true, disabled), false);
});

function renderTopbar(notify: {
  on: boolean;
  note?: string;
  deliverable?: boolean;
  onOpenSettings?: () => void;
}): string {
  return renderToStaticMarkup(
    createElement(Topbar, {
      serve: serveProps(),
      scope: SCOPE,
      runtimeStatus: IDLE,
      notify: { deliverable: true, onToggle: () => {}, ...notify },
      sessionFiles: { open: false, onToggle: () => {} },
    }),
  );
}

test("desktop の通知は On / Off と配信停止の状態を表示する", () => {
  const off = renderTopbar({ on: false });
  const delivering = renderTopbar({ on: true });
  const stopped = renderTopbar({ on: true, deliverable: false });
  assert.ok(off.indexOf("通知") < off.indexOf("作業フォルダ"), "通知がファイルより右にある");
  assert.ok(off.includes('aria-pressed="false"'), "Off の状態が読み上げに伝わらない");
  assert.ok(delivering.includes('aria-pressed="true"'), "On の状態が読み上げに伝わらない");

  assert.ok(stopped.includes("通知（停止中）"), "配信できない On のラベルが出ない");

  // 注記はバーの下 (接続状態のアラートより後) に出し、設定への導線を添える
  const withNote = renderTopbar({
    on: false,
    deliverable: false,
    note: NOTIFY_DISABLED_NOTE,
    onOpenSettings: () => {},
  });
  assert.ok(withNote.includes(NOTIFY_DISABLED_NOTE), "配信できない理由が出ない");
  assert.ok(withNote.includes("設定を開く"), "設定への導線が出ない");
  assert.ok(!off.includes(NOTIFY_DISABLED_NOTE), "Off で常に注記を出す");
});

function renderCompactBar(notify: { on: boolean; note?: string; deliverable?: boolean } = { on: true }): string {
  return renderToStaticMarkup(
    createElement(CompactBar, {
      serve: serveProps(),
      mode: "portrait",
      title: "パンくずの折り返しを直す",
      agentName: "実装担当",
      scope: SCOPE,
      runtimeStatus: IDLE,
      notify: { deliverable: true, onToggle: () => {}, ...notify },
      sessionFiles: { open: true, onToggle: () => {} },
      onOpenNav: () => {},
    }),
  );
}

test("compact のバーは ☰ を左端に置き、通知 → ファイルの順に並べる", () => {
  const html = renderCompactBar();
  assert.ok(!html.includes("✦"), "装飾の ✦ が残っている");
  assert.ok(html.indexOf('aria-label="ナビゲーションを開く"') < html.indexOf("実装担当"), "☰ が左端に無い");
  assert.ok(
    html.indexOf('aria-label="ナビゲーションを開く"') < html.indexOf('aria-label="サービスを起動"'),
    "サービスの起動がナビの次に無い",
  );
  assert.ok(
    html.indexOf('aria-label="サービスを起動"') < html.indexOf('aria-label="通知"'),
    "サービスの起動が通知の左に無い",
  );
  assert.ok(
    html.indexOf('aria-label="通知"') < html.indexOf('aria-label="作業フォルダ"'),
    "通知がファイルより右にある",
  );
});

test("compact は読み上げ名と注記で配信停止を示す", () => {
  const delivering = renderCompactBar({ on: true });
  const stopped = renderCompactBar({ on: true, deliverable: false, note: NOTIFY_UNCONFIGURED_NOTE });
  assert.ok(delivering.includes('title="通知"') && delivering.includes('aria-label="通知"'), "On の名前が違う");
  assert.ok(!delivering.includes("通知（停止中）"), "配信できる On で停止中を出す");

  assert.ok(stopped.includes('title="通知（停止中）"'), "配信できない On の title が違う");
  assert.ok(stopped.includes('aria-label="通知（停止中）"'), "配信できない On の読み上げ名が違う");
  assert.ok(stopped.includes(NOTIFY_UNCONFIGURED_NOTE), "注記が出ない");
});

test("サイドバーのセッション行は On の会話だけ鳴っているベルを出す", () => {
  const item: SessionSummary = {
    sessionId: "s-1",
    title: "テスト",
    agentId: "agent-general",
    status: "idle",
    queueDepth: 0,
    messageCount: 2,
    createdAt: 0,
    lastUsedAt: 0,
  };
  const render = (session: SessionSummary) =>
    renderToStaticMarkup(
      createElement(SessionRow, {
        item: session,
        agents: [],
        active: false,
        onSelect: () => {},
        onRename: () => {},
        onDelete: () => {},
      }),
    );
  const off = render(item);
  const on = render({ ...item, notify: true });
  assert.ok(!off.includes('aria-label="通知オン"'));
  assert.ok(on.includes('aria-label="通知オン"'), "ベルの読み上げ名が無い");
});
