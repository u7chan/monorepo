// 会話の通知トグルの手順と、新規チャットの先行選択。DOM に依存しない純ロジックだけを検証する。
// バーの配置は react-dom/server で描画して、☰ / 🔔 / 📁 の順と大きさ (docs/ui-layout.md の実測の前提) を、
// アイコンボタンの見た目は styles/index.css のソース走査で固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  notifyUnavailableNote,
} from "../src/lib/notifications";
import type { NotificationsResponse, SessionNotifyResponse, SessionSummary } from "../src/types";

const IDLE: RuntimeStatus = { text: "", error: false };
/** 鳴っているベルの目印 (BellIcon の ringing でだけ描かれる線) */
const RINGING_MARK = "M1.7 2.8 3.2 4.3";

const SETTINGS: NotificationsResponse = {
  enabled: true,
  provider: "discord",
  configured: true,
  webhookHint: "a1b2",
  baseUrl: "http://127.0.0.1:5173",
  mention: "none",
};

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

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

function renderTopbar(notify: {
  on: boolean;
  note?: string;
  canEnable?: boolean;
  onOpenSettings?: () => void;
}): string {
  return renderToStaticMarkup(
    createElement(Topbar, {
      runtimeStatus: IDLE,
      notify: { canEnable: true, onToggle: () => {}, ...notify },
      sessionFiles: { open: false, onToggle: () => {} },
    }),
  );
}

test("desktop のバーは通知トグルを「セッションのファイル」の左に置き、配信できる On だけを accent で示す", () => {
  const off = renderTopbar({ on: false });
  const delivering = renderTopbar({ on: true });
  const stopped = renderTopbar({ on: true, canEnable: false });
  assert.ok(off.indexOf("通知") < off.indexOf("セッションのファイル"), "通知がファイルより右にある");
  assert.ok(off.includes('aria-pressed="false"'), "Off の状態が読み上げに伝わらない");
  assert.ok(delivering.includes('aria-pressed="true"'), "On の状態が読み上げに伝わらない");
  assert.ok(delivering.includes("border-accent/50 text-accent-text"), "配信できる On が accent で示されない");
  assert.ok(!off.includes(RINGING_MARK), "Off で鳴っているベルを出している");
  assert.ok(delivering.includes(RINGING_MARK), "On で鳴っているベルを出していない");
  // 配信できない On は accent にしない (accent は「実際に送られる」の意味に保つ)。代わりにラベルで示す
  assert.ok(!stopped.includes("border-accent/50 text-accent-text"), "配信できない On が accent で示されている");
  assert.ok(stopped.includes("通知（停止中）"), "配信できない On のラベルが出ない");
  assert.ok(stopped.includes(RINGING_MARK), "On の会話でベルが鳴っていない");
  // 注記はバーの下 (接続状態のアラートより後) に出し、設定への導線を添える
  const withNote = renderTopbar({ on: false, canEnable: false, note: NOTIFY_DISABLED_NOTE, onOpenSettings: () => {} });
  assert.ok(withNote.includes(NOTIFY_DISABLED_NOTE), "配信できない理由が出ない");
  assert.ok(withNote.includes("設定を開く"), "設定への導線が出ない");
  assert.ok(!off.includes(NOTIFY_DISABLED_NOTE), "Off で常に注記を出す");
});

function renderCompactBar(notify: { on: boolean; note?: string; canEnable?: boolean } = { on: true }): string {
  return renderToStaticMarkup(
    createElement(CompactBar, {
      mode: "portrait",
      title: "パンくずの折り返しを直す",
      agentName: "実装担当",
      runtimeStatus: IDLE,
      notify: { canEnable: true, onToggle: () => {}, ...notify },
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
    html.indexOf('aria-label="通知"') < html.indexOf('aria-label="セッションのファイル"'),
    "通知がファイルより右にある",
  );
  assert.ok(html.includes("gap-2.5"), "コントロールの間隔が実測の前提と違う");
  assert.ok(html.includes("min-w-0 flex-1"), "タイトル列が縮められない");
});

test("compact は配信できない On を accent にせず、読み上げ名で停止中を示す", () => {
  const delivering = renderCompactBar({ on: true });
  const stopped = renderCompactBar({ on: true, canEnable: false, note: NOTIFY_UNCONFIGURED_NOTE });
  // 同じバーの「セッションのファイル」も accent を使うため、通知ボタンのタグだけを見る
  const tagOf = (html: string): string => {
    const match = /<button[^>]*aria-label="通知[^"]*"[^>]*>/.exec(html);
    assert.ok(match, "通知ボタンが無い");
    return match[0];
  };
  assert.ok(delivering.includes('title="通知"') && delivering.includes('aria-label="通知"'), "On の名前が違う");
  assert.ok(!delivering.includes("通知（停止中）"), "配信できる On で停止中を出す");
  assert.ok(delivering.includes("border-accent/50"), "配信できる On が accent で示されない");
  assert.ok(stopped.includes('title="通知（停止中）"'), "配信できない On の title が違う");
  assert.ok(stopped.includes('aria-label="通知（停止中）"'), "配信できない On の読み上げ名が違う");
  assert.ok(stopped.includes(NOTIFY_UNCONFIGURED_NOTE), "注記が出ない");
  assert.ok(!tagOf(stopped).includes("border-accent/50"), "配信できない On が accent で示されている");
});

test("compact のアイコンボタンは @layer components の .icon-button で、状態だけを utilities で上書きする", () => {
  const css = source("src/styles/index.css");
  // utilities 同士で並べると生成 CSS の順序で負け、On の accent が出ない (実機で確認した不具合)。
  // 見た目は components 層に置き、状態の上書きだけを utilities に残す
  const start = css.indexOf(".icon-button {");
  assert.ok(start >= 0, ".icon-button が定義されていない");
  const block = css.slice(start, css.indexOf("}", start));
  for (const value of [
    "grid",
    "size-9",
    "shrink-0",
    "place-items-center",
    "rounded-lg",
    "border-line",
    "bg-raised",
    "text-ink-soft",
    "hover:border-accent/50",
    "hover:text-accent-text",
  ]) {
    assert.ok(block.includes(value), `.icon-button の見た目が変わっている: ${value}`);
  }

  const compact = source("src/components/CompactBar.tsx");
  assert.equal((compact.match(/"icon-button"/g) ?? []).length, 3, "compact の 3 つが .icon-button を使っていない");
  assert.ok(
    compact.includes('cn("icon-button", notify.on && notify.canEnable && "border-accent/50 text-accent-text")'),
    "通知の On が utilities で上書きされていない",
  );
  assert.ok(
    compact.includes('cn("icon-button", sessionFiles.open && "border-accent/50 text-accent-text")'),
    "ファイルの開閉が utilities で上書きされていない",
  );
  assert.ok(!compact.includes("grid size-9"), "見た目が utilities に戻っている");
  // 描画された HTML はクラス名だけを持つ (実測の 36px は .icon-button が保証する)
  assert.equal((renderCompactBar().match(/icon-button/g) ?? []).length, 3);
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
      createElement(SessionRow, { item: session, agents: [], active: false, onSelect: () => {}, onDelete: () => {} }),
    );
  const off = render(item);
  const on = render({ ...item, notify: true });
  // Off は印を出さない (一覧が記号で埋まらないようにする)
  assert.ok(!off.includes(RINGING_MARK), "Off の会話にベルを出している");
  assert.ok(on.includes(RINGING_MARK), "On の会話に鳴っているベルが無い");
  assert.ok(on.includes("text-accent-text"), "ベルが accent でない");
  assert.ok(on.includes('aria-label="通知オン"'), "ベルの読み上げ名が無い");
});
