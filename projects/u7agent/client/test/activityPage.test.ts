// 実行状況ページの描画。DOM テスト基盤を持たないため react-dom/server の静的描画で、全スペースの件数・
// スペースバッジ・状態ラベル・経過時間・行のリンク・空状態・取得失敗の警告だけを検査する
// (class 名や CSS 値は検査しない)。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Space } from "server";
import { ActivityPage } from "../src/components/ActivityPage";
import type { SessionsFetchSnapshot } from "../src/lib/sessionsFetch";
import type { Project, SessionSummary } from "../src/types";

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
    ...overrides,
  };
}

function render(
  sessions: SessionSummary[],
  options: { fetch?: SessionsFetchSnapshot; onOpenNav?: () => void; compact?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(ActivityPage, {
      sessions,
      projects: PROJECTS,
      spaces: SPACES,
      fetch: options.fetch ?? LOADED,
      onReload: async () => true,
      onBack: () => {},
      onOpenNav: options.onOpenNav,
      compact: options.compact,
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
});

test("経過時間は状態ごとに出し分け、終了行は終了時刻と所要時間を出す", () => {
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
