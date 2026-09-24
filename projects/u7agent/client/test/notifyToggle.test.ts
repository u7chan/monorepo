// 会話の通知トグルの手順と、新規チャットの先行選択。DOM に依存しない純ロジックだけを検証する。
// バーの配置は react-dom/server で描画して、☰ / 🔔 / 📁 の順と大きさ (docs/ui-layout.md の実測の前提) を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompactBar } from "../src/components/CompactBar";
import { Topbar } from "../src/components/Topbar";
import { SessionRow } from "../src/components/sidebar/SessionRow";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";
import { createNotifyCarry, toggleNotify } from "../src/hooks/notifyToggle";
import { NOTIFY_UNAVAILABLE_NOTE, notifyUnavailableNote } from "../src/lib/notifications";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("新規チャットは PATCH を送らず、作成時に引き継ぐ先行選択だけを切り替える", async () => {
  const carry = createNotifyCarry();
  let requests = 0;
  await toggleNotify("", carry.snapshot(), {
    setPending: () => carry.toggle(),
    apply: () => assert.fail("セッション未作成で一覧の値を触った"),
    request: async (sessionId, notify) => {
      requests += 1;
      return { sessionId, notify };
    },
    onError: () => assert.fail("セッション未作成で失敗にしない"),
  });
  assert.equal(requests, 0, "セッション未作成で PATCH を送った");
  assert.equal(carry.snapshot(), true, "先行選択が On にならない");

  // もう一度押すと Off に戻る (作成されるまで何度でも選べる)
  await toggleNotify("", carry.snapshot(), {
    setPending: () => carry.toggle(),
    apply: () => assert.fail("セッション未作成で一覧の値を触った"),
    request: async (sessionId, notify) => ({ sessionId, notify }),
    onError: () => assert.fail("セッション未作成で失敗にしない"),
  });
  assert.equal(carry.snapshot(), false);
});

test("既存セッションは PATCH を送り、サーバーの応答を正として反映する", async () => {
  const applied: [string, boolean][] = [];
  const sent: [string, boolean][] = [];
  await toggleNotify("s-1", false, {
    setPending: () => assert.fail("既存セッションで先行選択を触った"),
    apply: (sessionId, notify) => applied.push([sessionId, notify]),
    request: async (sessionId, notify) => {
      sent.push([sessionId, notify]);
      // サーバーが別の値を返しても、表示はその値へ揃える (保存失敗を成功扱いにしない)
      return { sessionId, notify: false };
    },
    onError: () => assert.fail("成功時に onError を呼んだ"),
  });
  assert.deepEqual(sent, [["s-1", true]], "現在値の反対を送らない");
  // 4 秒のポーリングを待たずに反映し、応答の値で確定する
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", false],
  ]);
});

test("失敗したら楽観反映を戻し、理由を状態行へ渡す", async () => {
  const applied: [string, boolean][] = [];
  const errors: unknown[] = [];
  await toggleNotify("s-1", false, {
    setPending: () => assert.fail("既存セッションで先行選択を触った"),
    apply: (sessionId, notify) => applied.push([sessionId, notify]),
    request: async () => {
      throw new Error("HTTP 500");
    },
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(applied, [
    ["s-1", true],
    ["s-1", false],
  ]);
  assert.equal((errors[0] as Error).message, "HTTP 500");
});

test("先行選択は作成の要求時に読み切り、応答待ちの切替で変わらない", async () => {
  const carry = createNotifyCarry();
  carry.toggle();
  const created = deferred<SessionNotifyResponse>();
  // ensureSession と同じ順序: 要求の値は await の前に読み、完了で消費する
  const creation = (async () => {
    const notify = carry.snapshot();
    const session = await created.promise;
    carry.consume();
    return { notify, session };
  })();

  // 応答待ちの間にユーザーがトグルを押しても、送信済みの要求の値は変わらない
  carry.toggle();
  created.resolve({ sessionId: "s-1", notify: true });
  const result = await creation;
  assert.equal(result.notify, true, "作成要求の値が後からの切替で変わった");
  assert.equal(carry.snapshot(), false, "先行選択が次の新規チャットへ持ち越されている");
});

test("作成が終わったら先行選択を消費し、切り替え先の会話へ持ち越さない", () => {
  const carry = createNotifyCarry();
  const subscribed: boolean[] = [];
  const unsubscribe = carry.subscribe(() => subscribed.push(carry.snapshot()));

  carry.toggle();
  assert.equal(carry.snapshot(), true);
  carry.consume();
  assert.equal(carry.snapshot(), false, "消費しても先行選択が残っている");
  // 既に Off のときは通知しない (無関係な再描画を起こさない)
  carry.consume();
  unsubscribe();
  carry.toggle();
  assert.deepEqual(subscribed, [true, false], "購読者への通知が過不足");
});

test("On でも配信できないときだけ、押した直後の注記を返す", () => {
  // 配信できる設定 (有効 + Webhook 登録済み) では何も出さない
  assert.equal(notifyUnavailableNote(true, SETTINGS), undefined);
  assert.equal(notifyUnavailableNote(false, SETTINGS), undefined);
  // グローバル無効 / Webhook 未設定 / 設定が未取得のときは出す
  assert.equal(notifyUnavailableNote(true, { ...SETTINGS, enabled: false }), NOTIFY_UNAVAILABLE_NOTE);
  assert.equal(
    notifyUnavailableNote(true, { ...SETTINGS, configured: false, webhookHint: undefined }),
    NOTIFY_UNAVAILABLE_NOTE,
  );
  assert.equal(notifyUnavailableNote(true, null), NOTIFY_UNAVAILABLE_NOTE);
  // Off に戻したら消える (色ではなく文字で示す分だけを残す)
  assert.equal(notifyUnavailableNote(false, { ...SETTINGS, enabled: false }), undefined);
});

function renderTopbar(notify: { on: boolean; note?: string }): string {
  return renderToStaticMarkup(
    createElement(Topbar, {
      runtimeStatus: IDLE,
      notify: { ...notify, onToggle: () => {} },
      sessionFiles: { open: false, onToggle: () => {} },
    }),
  );
}

test("desktop のバーは通知トグルを「セッションのファイル」の左に置き、On はベルと accent で示す", () => {
  const off = renderTopbar({ on: false });
  const on = renderTopbar({ on: true });
  assert.ok(off.indexOf("通知") < off.indexOf("セッションのファイル"), "通知がファイルより右にある");
  assert.ok(off.includes('aria-pressed="false"'), "Off の状態が読み上げに伝わらない");
  assert.ok(on.includes('aria-pressed="true"'), "On の状態が読み上げに伝わらない");
  assert.ok(on.includes("border-accent/50 text-accent-text"), "On が accent で示されない");
  assert.ok(!off.includes(RINGING_MARK), "Off で鳴っているベルを出している");
  assert.ok(on.includes(RINGING_MARK), "On で鳴っているベルを出していない");
  // 注記はバーの下 (接続状態のアラートより後) に出し、Off では出さない
  const withNote = renderTopbar({ on: true, note: NOTIFY_UNAVAILABLE_NOTE });
  assert.ok(withNote.includes(NOTIFY_UNAVAILABLE_NOTE), "配信できない理由が出ない");
  assert.ok(!off.includes(NOTIFY_UNAVAILABLE_NOTE), "Off でも注記を出す");
});

test("compact のバーは ☰ を左端に置き、通知 → ファイルの順に並べる", () => {
  const html = renderToStaticMarkup(
    createElement(CompactBar, {
      mode: "portrait",
      title: "パンくずの折り返しを直す",
      agentName: "実装担当",
      runtimeStatus: IDLE,
      notify: { on: false, onToggle: () => {} },
      sessionFiles: { open: false, onToggle: () => {} },
      onOpenNav: () => {},
    }),
  );
  assert.ok(!html.includes("✦"), "装飾の ✦ が残っている");
  assert.ok(html.indexOf('aria-label="ナビゲーションを開く"') < html.indexOf("実装担当"), "☰ が左端に無い");
  assert.ok(
    html.indexOf('aria-label="通知"') < html.indexOf('aria-label="セッションのファイル"'),
    "通知がファイルより右にある",
  );
  // タイトル列は縮められる (3 つの 36px ボタン + 10px の間隔 = 固定 138px。実測は docs/ui-layout.md)
  assert.equal((html.match(/size-9/g) ?? []).length, 3, "compact のコントロールが 36px で揃っていない");
  assert.ok(html.includes("gap-2.5"), "コントロールの間隔が実測の前提と違う");
  assert.ok(html.includes("min-w-0 flex-1"), "タイトル列が縮められない");
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
