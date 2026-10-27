// 実行状況ページの描画。DOM テスト基盤を持たないため react-dom/server の静的描画で、全スペースの件数・
// スペースバッジ・状態ラベル・経過時間・行のリンク・空状態・取得失敗の警告・上部のサービス行と
// 行の操作だけを検査する (class 名や CSS 値は検査しない)。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Space } from "server";
import type { ActivityRow } from "../src/lib/activity";
import { activityRows } from "../src/lib/activity";
import { activityRowServe } from "../src/lib/activityServe";
import type { ActivityRowServe } from "../src/lib/activityServe";
import type { ActivityServiceView } from "../src/lib/activityServe";
import { createRuntimeServeController, INITIAL_RUNTIME_SERVE_STATE } from "../src/lib/runtimeServe";
import type { SessionsFetchSnapshot } from "../src/lib/sessionsFetch";
import type { Project, SessionSummary } from "../src/types";

// api.ts は location.origin を読むため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ActivityPage } = await import("../src/components/ActivityPage");
const { ActivityRowItem } = await import("../src/components/ActivityRowItem");
const { ActivityServiceRow } = await import("../src/components/ActivityServiceRow");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

const NOW = Date.now();
const SPACES: Space[] = [
  { id: "default", name: "既定", createdAt: 0 },
  { id: "space-1111111111111111", name: "デモ", createdAt: 1 },
];
const PROJECTS: Project[] = [{ id: "project-1", cwd: "proj-a", name: "demo-api", createdAt: 0 }];

const LOADED: SessionsFetchSnapshot = { loaded: true, pending: false, failed: false, lastSuccessAt: NOW - 8_000 };

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "session-1",
    spaceId: "default",
    title: "会話",
    agentId: "agent-1",
    agentName: "開発アシスタント",
    status: "idle",
    queueDepth: 0,
    pinned: false,
    messageCount: 1,
    createdAt: NOW - 600_000,
    lastUsedAt: NOW - 60_000,
    serveCommand: null,
    ...overrides,
  };
}

function render(
  sessions: SessionSummary[],
  options: { fetch?: SessionsFetchSnapshot; onOpenNav?: () => void; compact?: boolean; previewPort?: number } = {},
): string {
  return renderToStaticMarkup(
    createElement(ConfirmProvider, {
      children: createElement(ActivityPage, {
        sessions,
        projects: PROJECTS,
        spaces: SPACES,
        fetch: options.fetch ?? LOADED,
        onReload: async () => true,
        onBack: () => {},
        onOpenNav: options.onOpenNav,
        compact: options.compact,
        previewPort: options.previewPort ?? 8016,
        hostname: "localhost",
      }),
    }),
  );
}

/** 画面に出る文言。タグの分け方ではなく、読める文字列を検査する (要素の境界は空白として読む) */
function renderedText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `<a>` の中に入れ子のリンク・ボタンが無いこと (行のリンクと操作を分けた契約) */
function assertNoNestedInteractive(markup: string): void {
  for (const anchor of markup.match(/<a[\s>][\s\S]*?<\/a>/g) ?? []) {
    const inner = anchor.replace(/^<a[\s>][^>]*>/, "");
    assert.equal(/<a[\s>]/.test(inner), false, `リンクの中にリンクがある: ${anchor}`);
    assert.equal(/<button[\s>]/.test(inner), false, `リンクの中にボタンがある: ${anchor}`);
  }
}

const RUNNING = summary({
  sessionId: "run-1",
  title: "ヘッダーのレイアウトを調整する",
  status: "running",
  runStartedAt: NOW - 758_500,
  projectId: "project-1",
});
const WAITING = summary({
  sessionId: "wait-1",
  spaceId: "space-1111111111111111",
  title: "API の認証方式を整理する",
  status: "running",
  awaitingAnswer: true,
  awaitingSince: NOW - 252_500,
});
const FINISHED = summary({
  sessionId: "done-1",
  title: "ベースラインの精度を測る",
  status: "completed",
  finishedAt: NOW - 60_000,
  lastRunDurationMs: 18 * 60_000 + 24_000,
});

test("全スペースの進行中と直近の終了を 1 画面に出し、区分ごとに件数を数える", () => {
  const markup = render([RUNNING, WAITING, FINISHED]);
  const text = renderedText(markup);
  assert.ok(text.includes("すべてのスペース"), "入口の対象が全スペースであることを出す");
  assert.ok(text.includes("2 件の会話が進行中"), "進行中は回答待ちと処理中の合計で、会話数であることを明記する");
  assert.ok(text.includes("実行中 1"));
  assert.ok(text.includes("回答待ち 1"));
  assert.ok(text.includes("直近の終了 1"));
  // 行の情報: タイトル・スペースバッジ・エージェント名・所属プロジェクト・状態ラベル
  assert.ok(text.includes("ヘッダーのレイアウトを調整する"));
  assert.ok(text.includes("API の認証方式を整理する"));
  assert.ok(text.includes("デモ"), "別スペースの行にもスペース名を出す");
  assert.ok(text.includes("開発アシスタント"));
  assert.ok(text.includes("demo-api"));
  assert.ok(text.includes("未所属"));
  assert.ok(text.includes("圧縮中 0"));
});

test("行は全スペースの入口リンクで、accessible name に会話タイトルを含む", () => {
  const markup = render([RUNNING, WAITING]);
  assert.ok(markup.includes('href="/s/run-1?space=default"'));
  assert.ok(markup.includes('href="/s/wait-1?space=space-1111111111111111"'));
  // 行全体がリンクで、読み上げ名は中の会話タイトルを含む
  assert.match(markup, /<a[^>]*href="\/s\/run-1\?space=default"[^>]*>.*?ヘッダーのレイアウトを調整する/s);
  assert.ok(renderedText(markup).includes("会話を開く:"));
  assertNoNestedInteractive(markup);
});

test("経過時間は状態ごとに出し分け、終了行は終了時刻と所要時間を出す", (t) => {
  // 実時計のままだと fixture 作成から描画までの遅れが 500ms を超えたときに経過秒が 1 つ進む
  // (負荷時に再現する)。NOW に固定して、表示の組み立てだけを検査する。
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const text = renderedText(render([RUNNING, WAITING, FINISHED]));
  assert.ok(text.includes("12:38"), "実行中は runStartedAt から mm:ss");
  assert.ok(text.includes("04:12 待ち"), "回答待ちは「待ち」を付ける");
  assert.ok(text.includes("所要 18分24秒"));
  // 時刻欠落・queued では数字を出さない (行の中だけを見る。ヘッダには最終更新の時刻がある)
  const queuedMarkup = render([summary({ sessionId: "queued-1", status: "queued" })]);
  const rowStart = queuedMarkup.indexOf('href="/s/queued-1');
  const queuedRow = queuedMarkup.slice(rowStart, queuedMarkup.indexOf("</a>", rowStart));
  assert.ok(rowStart >= 0);
  assert.ok(!/\d{2}:\d{2}/.test(queuedRow), "queued には経過時間を出さない");
});

test("進行中が 0 のときは空状態を出し、直近の終了はその下に残す", () => {
  const text = renderedText(render([FINISHED]));
  assert.ok(text.includes("進行中の会話はありません"));
  assert.ok(text.includes("ベースラインの精度を測る"), "終了行は空状態でも残す");
  const empty = renderedText(render([]));
  assert.ok(empty.includes("進行中の会話はありません"));
  assert.ok(empty.includes("直近 2 時間に終了した会話もありません"));
});

test("初回未取得は集計も 0 件と言い切らず、取得失敗は最終成功時刻つきの警告にする", () => {
  const initial = renderedText(render([], { fetch: { loaded: false, pending: true, failed: false } }));
  assert.ok(initial.includes("一覧を取得しています"));
  // 集計欄も「未取得」にし、空配列から数えた 0 を出さない
  assert.ok(initial.includes("進行中の会話数は未取得"));
  assert.ok(initial.includes("実行中 —"));
  assert.ok(initial.includes("回答待ち —"));
  assert.ok(initial.includes("圧縮中 —"));
  assert.ok(initial.includes("直近の終了 —"));
  assert.ok(!initial.includes("0 件の会話が進行中"), "未取得を 0 件として扱わない");
  assert.ok(!initial.includes("実行中 0"));
  assert.ok(!initial.includes("進行中の会話はありません"), "未取得を空状態として扱わない");

  const failed = render([], { fetch: { loaded: false, pending: false, failed: true } });
  assert.match(failed, /role="alert"/);
  const failedText = renderedText(failed);
  assert.ok(failedText.includes("一覧を取得できていません"));
  assert.ok(failedText.includes("進行中の会話数は未取得"));
  assert.ok(!failedText.includes("実行中 0"));
  assert.ok(!failedText.includes("進行中の会話はありません"));

  const stale = renderedText(
    render([RUNNING], { fetch: { loaded: true, pending: false, failed: true, lastSuccessAt: NOW - 60_000 } }),
  );
  assert.ok(stale.includes("更新できていません"));
  assert.ok(stale.includes("最終成功:"), "前回の一覧を保つ間は最終成功時刻を出す");
  assert.ok(stale.includes("ヘッダーのレイアウトを調整する"), "前回の一覧を残す");
  // 一度成功していれば、古い一覧から数えた件数を出す
  assert.ok(stale.includes("1 件の会話が進行中"));
});

test("取得中は再読み込みを無効にし、自動更新の件数は live region にしない", () => {
  const markup = render([RUNNING], { fetch: { ...LOADED, pending: true } });
  assert.match(markup, /<button[^>]*disabled[^>]*>.*?再読み込み/s);
  assert.ok(!markup.includes('aria-live="polite"'), "一覧と件数を毎回読み上げない");
  assert.ok(!markup.includes('role="status"'), "自動更新では status も出さない");
});

test("サイドバーが隠れる幅ではヘッダに ☰ を出し、会話に戻る導線は常に出す", () => {
  const overlay = render([RUNNING], { onOpenNav: () => {}, compact: true });
  assert.ok(overlay.includes('aria-label="ナビゲーションを開く"'));
  assert.ok(renderedText(overlay).includes("会話に戻る"));
  const docked = render([RUNNING]);
  assert.ok(!docked.includes('aria-label="ナビゲーションを開く"'));
  assert.ok(renderedText(docked).includes("会話に戻る"));
});

test("集計の下に公開中のサービス行を出し、取得前は状態だけを出して操作を出さない", () => {
  const markup = render([RUNNING]);
  const text = renderedText(markup);
  assert.ok(markup.includes('aria-label="公開中のサービス"'));
  assert.ok(text.includes("状態を取得しています…"));
  // まだ状態が無いので、リンクも起動も停止も出さない
  assert.ok(!text.includes("停止"));
  assert.equal(markup.includes('href="http://localhost:8016/"'), false);
  // 集計 (ヘッダ) より後、一覧の前
  assert.ok(markup.indexOf('aria-label="公開中のサービス"') > markup.indexOf("件の会話が進行中"));
});

const SERVICE = (overrides: Partial<ActivityServiceView> = {}): ActivityServiceView => ({
  kind: "running",
  label: "稼働中",
  canStop: true,
  ...overrides,
});

function renderService(view: ActivityServiceView, options: { stopping?: boolean; error?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(ActivityServiceRow, {
      view,
      stopping: options.stopping ?? false,
      error: options.error,
      compact: false,
      onStop: () => {},
    }),
  );
}

test("サービス行は稼働中の起動元・コマンド・作業ディレクトリ・待受と、開く / 停止を出す", () => {
  const markup = renderService(
    SERVICE({
      owner: { sessionId: "session-a", title: "会話A", spaceId: "space-1111111111111111" },
      command: { cwd: "app", command: "python3 -m http.server 8080" },
      url: "http://localhost:8016/",
    }),
  );
  const text = renderedText(markup);
  assert.ok(text.includes("稼働中"));
  assert.ok(text.includes("会話A"));
  assert.ok(markup.includes('href="/s/session-a?space=space-1111111111111111"'));
  assert.ok(text.includes("python3 -m http.server 8080"));
  assert.ok(text.includes("app"));
  assert.ok(text.includes("待受 8080"));
  assert.match(markup, /<a[^>]*href="http:\/\/localhost:8016\/"[^>]*target="_blank" rel="noreferrer noopener"/);
  assert.ok(markup.includes('aria-label="「会話A」のサービスを開く"'));
  assert.ok(markup.includes('aria-label="「会話A」のサービスを停止"'));
  assertNoNestedInteractive(markup);
});

test("サービス行は起動元不明・停止中・取得失敗・起動中を区別し、操作を出さない場合を分ける", () => {
  const unknown = renderedText(
    renderService(SERVICE({ kind: "unknown", label: "稼働中（起動元不明）", url: "http://localhost:8016/" })),
  );
  assert.ok(unknown.includes("稼働中（起動元不明）"));
  assert.ok(unknown.includes("待受 8080"));
  assert.ok(unknown.includes("起動元の会話を特定できません"));
  assert.ok(!unknown.includes("会話A"));

  const stopped = renderService(SERVICE({ kind: "stopped", label: "停止中", canStop: false }));
  assert.ok(renderedText(stopped).includes("停止中"));
  assert.ok(renderedText(stopped).includes("終了した会話の行から起動できます"));
  assert.ok(!renderedText(stopped).includes("停止する"));
  assert.ok(!stopped.includes("http://localhost:8016/"));

  const failed = renderService(SERVICE({ kind: "failed", label: "状態を取得できません", canStop: false }));
  assert.ok(renderedText(failed).includes("状態を取得できません"));
  assert.ok(!failed.includes("http://localhost:8016/"));
  assert.ok(!renderedText(failed).includes("停止"));

  const starting = renderService(
    SERVICE({ kind: "starting", label: "起動中…", canStop: false, launching: { title: "会話B", command: "pnpm dev" } }),
  );
  const startingText = renderedText(starting);
  assert.ok(startingText.includes("起動中…"));
  assert.ok(startingText.includes("会話B"));
  assert.ok(startingText.includes("pnpm dev"));
  assert.ok(startingText.includes("最大 10 秒"));
  assert.ok(!starting.includes("http://localhost:8016/"));
});

test("サービス行は停止の確認待ちと、直前の操作の失敗理由を出す", () => {
  const stopping = renderService(SERVICE({ url: "http://localhost:8016/" }), { stopping: true });
  assert.ok(renderedText(stopping).includes("停止を確認中…"));
  const failed = renderService(SERVICE({ canStop: false }), { error: "期限内に到達できませんでした" });
  assert.match(failed, /role="alert"/);
  assert.ok(renderedText(failed).includes("サービスの操作に失敗しました: 期限内に到達できませんでした"));
});

function finishedRow(overrides: Partial<SessionSummary> = {}): ActivityRow {
  const [row] = activityRows(
    [
      summary({
        sessionId: "done-1",
        title: "おえかきぼうとる",
        status: "completed",
        finishedAt: NOW - 60_000,
        serveCommand: { cwd: "sessions/done", command: "python3 -m http.server 8080" },
        ...overrides,
      }),
    ],
    [],
    NOW,
  );
  assert.ok(row);
  return row;
}

const NO_ACTION: ActivityRowServe = { served: false, action: "none", disabled: false };

function renderRow(row: ActivityRow, serve: ActivityRowServe, compact = false, error?: string): string {
  return renderToStaticMarkup(
    createElement(ActivityRowItem, { row, now: NOW, spaceName: "デモ", serve, compact, error, onStart: () => {} }),
  );
}

test("操作を持つ行はリンクと操作を分け、入れ子の interactive を作らない", () => {
  const row = finishedRow();
  const start = renderRow(row, {
    served: false,
    action: "start",
    disabled: false,
    ...(row.serveCommand ? { command: row.serveCommand } : {}),
  });
  // 行全体のリンクではなく、タイトル + メタのリンクと状態ピル + 操作の 2 つに分かれる
  assert.equal((start.match(/<a[\s>]/g) ?? []).length, 1);
  assert.ok(start.includes('href="/s/done-1?space=default"'));
  assert.match(start, /aria-label="「おえかきぼうとる」のサービスを起動"/);
  assert.match(start, /title="起動: sessions\/done \/ python3 -m http\.server 8080"/);
  assertNoNestedInteractive(start);

  const open = renderRow(row, { served: true, action: "open", disabled: false, url: "http://localhost:8016/" });
  assert.ok(renderedText(open).includes("稼働中"), "稼働中の行にチップを付ける");
  assert.match(open, /<a[^>]*href="http:\/\/localhost:8016\/"[^>]*aria-label="「おえかきぼうとる」のサービスを開く"/);
  assertNoNestedInteractive(open);

  const starting = renderRow(row, { served: false, action: "starting", disabled: true });
  assert.ok(renderedText(starting).includes("起動中…"));
  assert.ok(!starting.includes("サービスを起動"), "起動中の行は操作に変えない");
});

test("操作のない行は行全体をリンクにし、起動中は他の行の起動を無効にする", () => {
  const row = finishedRow();
  const plain = renderRow(row, NO_ACTION);
  assert.match(plain, /<a[^>]*href="\/s\/done-1\?space=default"[^>]*>[\s\S]*?<\/a>/);
  assert.equal((plain.match(/<a[\s>]/g) ?? []).length, 1);
  assert.equal((plain.match(/<button[\s>]/g) ?? []).length, 0);
  assertNoNestedInteractive(plain);

  const disabled = renderRow(row, {
    served: false,
    action: "start",
    disabled: true,
    command: { cwd: "app", command: "pnpm dev" },
  });
  assert.match(disabled, /<button[^>]*disabled[^>]*>起動<\/button>/);
  const compact = renderRow(
    row,
    { served: false, action: "start", disabled: false, command: { cwd: "app", command: "pnpm dev" } },
    true,
  );
  assert.match(compact, /<button[^>]*min-h-11/);
});

test("起動に失敗した理由はその行に出し、行の起動は再試行できる", () => {
  const row = finishedRow();
  const serve: ActivityRowServe = {
    served: false,
    action: "start",
    disabled: false,
    command: { cwd: "sessions/done", command: "python3 -m http.server 8080" },
  };
  const markup = renderRow(row, serve, false, "この作業ディレクトリには serve の実績がありません");
  assert.match(markup, /role="alert"/);
  assert.ok(
    renderedText(markup).includes("サービスの起動に失敗しました: この作業ディレクトリには serve の実績がありません"),
  );
  assert.match(markup, /aria-label="「おえかきぼうとる」のサービスを起動"/);
  assert.ok(markup.includes("起動: sessions/done / python3 -m http.server 8080"));
  assertNoNestedInteractive(markup);

  // 失敗していない行には出さない
  const other = renderRow(finishedRow({ sessionId: "done-2" }), serve);
  assert.equal(other.includes('role="alert"'), false);
  // 操作が無くなっても (状態を取得できない間も)、失敗した行の理由は残す
  const failedWithoutAction = renderRow(row, NO_ACTION, false, "サンドボックスに接続できません");
  assert.match(failedWithoutAction, /role="alert"/);
  assert.ok(renderedText(failedWithoutAction).includes("サービスの起動に失敗しました: サンドボックスに接続できません"));
  assert.equal((failedWithoutAction.match(/<a[\s>]/g) ?? []).length, 1, "行全体のリンクは維持する");
  assertNoNestedInteractive(failedWithoutAction);
  // 失敗していない操作なし行には出さない
  const plain = renderRow(row, NO_ACTION);
  assert.equal(plain.includes('role="alert"'), false);
});

test("起動失敗のあと状態も取得できなくても、失敗した行に理由が残る", async () => {
  let state = INITIAL_RUNTIME_SERVE_STATE;
  const controller = createRuntimeServeController({
    // 起動の後は状態を取得できない (サンドボックスへの接続が失われた経路)
    getStatus: async () => {
      throw new Error("サンドボックスに接続できません");
    },
    start: async () => {
      throw new Error("サンドボックスに接続できません");
    },
    stop: async () => {
      throw new Error("unused");
    },
    confirm: async () => true,
    onChange: (next) => {
      state = next;
    },
  });
  await controller.refresh();
  const result = await controller.start({
    sessionId: "done-1",
    confirm: { kind: "confirm", title: "サービスを起動", confirmLabel: "起動する" },
  });
  // 失敗の後の取り直しも失敗し、状態は「取得できない」になる
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(result, { kind: "failed", error: "サンドボックスに接続できません" });
  assert.equal(state.status, null);
  assert.equal(state.failed, true);

  const row = finishedRow();
  const serve = activityRowServe({
    row,
    status: state.status,
    failed: state.failed,
    starting: state.starting,
    hostname: "localhost",
    port: 8016,
  });
  assert.equal(serve.action, "none", "状態を取得できない間は操作を出さない");
  const markup = renderRow(row, serve, false, result.kind === "failed" ? result.error : undefined);
  assert.match(markup, /role="alert"/);
  assert.ok(renderedText(markup).includes("サービスの起動に失敗しました: サンドボックスに接続できません"));
});
