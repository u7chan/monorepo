// 状態行に出すライブのツール表示と、ツール履歴のコピーを完了まで出さない契約。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolHistoryView } from "../src/components/chat/ToolHistory";
import type { ToolCard } from "../src/lib/chatTypes";
import {
  LIVE_PROGRESS_BODY_LINES,
  LIVE_PROGRESS_BODY_MAX,
  liveToolProgress,
  liveToolRows,
  liveToolStatus,
  liveToolStatusView,
} from "../src/lib/liveToolCall";
import type { RunStatus, ToolCall } from "../src/types";

function call(id: string, name: string, args: string, done: boolean, extra: Partial<ToolCall> = {}): ToolCall {
  return { id, name, args, done, isError: false, output: done ? "ok" : "", ...extra };
}

function card(id: string, name: string, phase: ToolCard["phase"], timing: Partial<ToolCard> = {}): ToolCard {
  return { id, name, args: "", phase, output: "", ...timing };
}

test("行は走査順に返し、番号は完了分も含めて数える", () => {
  const runTools = {
    t1: call("t1", "bash", "curl -fsSL https://example.test/a.json", true),
    t2: call("t2", "bash", "jq -r '.areas[0]' a.json", false),
    t3: call("t3", "read", "/work/a.json", true),
    t4: call("t4", "grep", "-n osaka /work/a.json", false),
  };

  const rows = liveToolRows(runTools);
  assert.deepEqual(
    rows.map((row) => [row.id, row.index]),
    [
      ["t1", 1],
      ["t2", 2],
      ["t3", 3],
      ["t4", 4],
    ],
  );
  assert.equal(rows[1].summary, "bash — jq -r '.areas[0]' a.json");
});

test("スキル読み込みと ask_user は状態行に出さない (ツール履歴と同じ除外)", () => {
  const skill = { id: "s1", name: "a", path: "skills/a/SKILL.md" };
  const runTools = {
    t1: call("t1", "read", "skills/a/SKILL.md", false, { skill }),
    t2: call("t2", "ask_user", "{}", false, { questions: [{ question: "どこの地域?" }] }),
    t3: call("t3", "bash", "ls", false),
  };

  const rows = liveToolRows(runTools);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["t3"],
  );
  // 外した分は番号を詰める (履歴の行番号と同じ数え方)
  assert.equal(rows[0].index, 1);
});

test("全行には完了した行も入り、実行時間と履歴と同じ番号を持つ", () => {
  const skill = { id: "t3", name: "a", path: "skills/a/SKILL.md" };
  const runTools = {
    t1: call("t1", "bash", "ls", true, { startedAt: 1_000, endedAt: 2_200 }),
    t2: call("t2", "read", "a.md", false, { startedAt: 2_300 }),
    t3: call("t3", "read", "skills/a/SKILL.md", false, { skill }),
  };

  assert.deepEqual(
    liveToolRows(runTools).map((row) => [row.id, row.index, row.done, row.durationMs]),
    [
      ["t1", 1, true, 1_200],
      ["t2", 2, false, undefined],
    ],
  );
});

test("状態行は実行中の行だけを返し、最新を末尾にする", () => {
  const runTools = {
    t1: call("t1", "bash", "ls", true),
    t2: call("t2", "read", "a.md", false),
    t3: call("t3", "grep", "-n foo a.md", false),
  };

  const status = liveToolStatus(runTools, "running");
  assert.deepEqual(
    status.running.map((row) => row.id),
    ["t2", "t3"],
  );
  assert.equal(status.latest?.id, "t3");
  assert.equal(status.totalCount, 3, "完了分も含めた件数を持つ");
});

test("run が実行中でなければ状態行に出さない (停止で done が来なかったカードを残さない)", () => {
  const runTools = { t1: call("t1", "bash", "sleep 100", false) };
  // queued は run が動いていない状態 (次の run のツールは run_start まで runTools に入らない)
  for (const status of ["idle", "queued", "compacting", "completed", "stopped", "error"] as RunStatus[]) {
    const live = liveToolStatus(runTools, status);
    assert.deepEqual(live.running, [], `${status} の表示`);
    assert.equal(live.latest, undefined, `${status} の最新行`);
    assert.equal(live.totalCount, 1, `${status} でも全行数は返す`);
  }
  const empty = liveToolStatus({}, "running");
  assert.deepEqual(empty.running, [], "実行中でもツールが無ければ出さない");
  assert.equal(empty.totalCount, 0);
});

test("状態行は最新ツールのサマリーを出し、並列は件数を添える", () => {
  const one = liveToolStatus({ t1: call("t1", "bash", "ls -la", false) }, "running");
  assert.deepEqual(liveToolStatusView(one), {
    text: "実行中 · bash — ls -la",
    title: "bash — ls -la\n実行中のツール",
  });

  const two = liveToolStatus(
    {
      t1: call("t1", "bash", "ls", false),
      t2: call("t2", "read", "a.md", false),
    },
    "running",
  );
  assert.equal(liveToolStatusView(two)?.text, "2件実行中 · read — a.md", "最新の行を件数の後ろに出す");
});

test("状態行は investigate の現在の活動を優先し、本文末尾は title に残す", () => {
  const status = liveToolStatus(
    {
      t1: call("t1", "investigate", "docs を調べて", false, {
        progress: "bash rg -n foo\n結論: docs にある",
      }),
    },
    "running",
  );
  const view = liveToolStatusView(status);
  assert.equal(view?.text, "実行中 · investigate — bash rg -n foo", "現在の子の活動を優先する");
  assert.equal(
    view?.title,
    "investigate — docs を調べて\nbash rg -n foo\n結論: docs にある\n実行中のツール",
    "本文末尾は title に残す",
  );
});

test("完了した行だけなら状態行は何も出さない (サーバーの活動文言へ戻す)", () => {
  const status = liveToolStatus({ t1: call("t1", "bash", "ls", true) }, "running");
  assert.equal(liveToolStatusView(status), undefined);
});

test("進捗の本文は先頭行を活動、末尾の 1 行を title 用の本文として読む", () => {
  assert.deepEqual(liveToolProgress("bash rg -n foo\n結論: docs にある"), {
    activity: "bash rg -n foo",
    body: "結論: docs にある",
  });
  // 1 行だけの進捗 (活動だけ / 本文だけ) は活動として出す。分けられない以上、1 行として見せれば足りる
  assert.deepEqual(liveToolProgress("生成中です"), { activity: "生成中です", body: "" });
  const multi = liveToolProgress("bash ls\n\n本文 1\n本文 2");
  assert.deepEqual(multi, { activity: "bash ls", body: "本文 2" }, "title に載せる本文は 1 行だけ残す");
});

test("子の本文末尾は行数の上限まで残し、末尾を優先する", () => {
  const body = Array.from({ length: LIVE_PROGRESS_BODY_LINES + 2 }, (_, index) => `本文${index + 1}`).join("\n");
  const result = liveToolProgress(`bash ls\n${body}`);

  assert.equal(result.body.split("\n").length, LIVE_PROGRESS_BODY_LINES, "行数の上限まで残す");
  assert.ok(result.body.endsWith(`本文${LIVE_PROGRESS_BODY_LINES + 2}`), "末尾を優先する");
  assert.equal(result.body.includes("本文1"), false, "先頭の行は落とす");

  const long = `bash ls\n${"あ".repeat(LIVE_PROGRESS_BODY_MAX + 20)}`;
  const { body: clipped } = liveToolProgress(long);
  assert.equal(clipped.length, LIVE_PROGRESS_BODY_MAX + 1, "長さの上限まで残す");
  assert.ok(clipped.startsWith("…"), "切ったことを示す");
  assert.ok(clipped.endsWith("あ"));
});

function renderHistory(cards: ToolCard[], live: boolean): string {
  return renderToStaticMarkup(
    createElement(ToolHistoryView, {
      cards,
      hasResponse: false,
      live,
      copiedId: "",
      copyFailure: () => undefined,
      copiedAll: false,
      onCopyAll: () => {},
      singleColumn: false,
      onCopyTool: () => {},
    }),
  );
}

test("ツール履歴の「すべてコピー」は進行中のターンでは出さず、完了で出す", () => {
  const cards = [card("t1", "bash", "done")];
  assert.equal(renderHistory(cards, true).includes("ツール履歴をすべてコピー"), false);
  assert.equal(renderHistory(cards, false).includes("ツール履歴をすべてコピー"), true);
});

test("進行中のターンでは実行中のカードを履歴に出さず、ターンが終われば並べる", () => {
  const cards = [card("t1", "bash", "done"), card("t2", "bash", "running")];

  const live = renderHistory(cards, true);
  assert.ok(live.includes("1件"), "実行中のカードは件数に数えない");
  assert.equal(live.includes("実行中"), false, "実行中は状態行が受け持つ");

  // 停止・中断で tool_end が来なかったカードは、ターンを抜けた後もここに残す
  const finished = renderHistory(cards, false);
  assert.ok(finished.includes("2件"));
  assert.ok(finished.includes("実行中"));
});

test("ツール履歴の行は実行時間を出し、見出しは重なりを除いた合計を出す", () => {
  const cards = [
    card("t1", "bash", "done", { startedAt: 0, endedAt: 1_000 }),
    card("t2", "grep", "done", { startedAt: 500, endedAt: 1_500 }),
  ];
  const html = renderHistory(cards, false);
  assert.ok(html.includes("1.0s"), "行ごとの実行時間が出る");
  assert.ok(html.includes("計 1.5s"), "重なった 1 秒を二重に数えない合計を出す");
});

test("実行時間の控えが無いカード (旧サーバー / 停止) では合計を出さない", () => {
  const missing = renderHistory([card("t1", "bash", "done")], false);
  assert.equal(missing.includes("計 "), false, "1 枚でも区間が閉じていなければ出さない");

  // 停止・中断で tool_end が来なかったカードは終了時刻を持たない
  const stopped = renderHistory(
    [card("t1", "bash", "done", { startedAt: 0, endedAt: 1_000 }), card("t2", "bash", "running", { startedAt: 2_000 })],
    false,
  );
  assert.equal(stopped.includes("計 "), false);
});

const IMAGE_OUTPUT =
  "モデル: openai/gpt-image-2\n" +
  "画像を生成して保存しました: generated/cat.png\n" +
  "本文に示すときは Markdown 画像 ![alt](generated/cat.png) で示してください。";

const SPEECH_OUTPUT =
  "モデル: google/gemini-3.8-flash-tts\n" +
  "ボイス: Kore\n" +
  "音声を生成して保存しました: generated/intro.mp3\n" +
  "本文に示すときは、このパス (generated/intro.mp3) を示してください。";

/** 生成のチップだけを読む。展開した出力本文にもモデル行があるため、目印の属性で区別する */
function chips(html: string): string[] {
  return [...html.matchAll(/data-generation-chip="([^"]*)"/g)].map((match) => match[1]);
}

const WEB_SEARCH_OUTPUT =
  "現在日時: 2026-10-07 (Asia/Tokyo)\n" +
  "検索プロバイダー: Exa\n" +
  "出典:\n" +
  "[1] First — https://example.com/a\n" +
  "\n" +
  "[1] First — https://example.com/a\n抜粋";

/** provider のチップだけを読む (生成モデルのチップと同じく属性で区別する) */
function webSearchChips(html: string): string[] {
  return [...html.matchAll(/data-web-search-chip="([^"]*)"/g)].map((match) => match[1]);
}

test("ツール履歴は生成に使ったモデルをヘッダと行のチップに出し、畳んだままでも読める", () => {
  const html = renderHistory([card("t1", "generate_image", "done", { output: IMAGE_OUTPUT })], false);
  assert.deepEqual(chips(html), ["openai/gpt-image-2", "openai/gpt-image-2"], "ヘッダと行の両方に出す");
  assert.ok(html.includes('title="openai/gpt-image-2"'), "切れたときに読めるよう全文を title に残す");

  const speech = renderHistory([card("t1", "generate_speech", "done", { output: SPEECH_OUTPUT })], false);
  assert.deepEqual(chips(speech), ["google/gemini-3.8-flash-tts", "google/gemini-3.8-flash-tts"]);
  assert.equal(
    chips(speech).some((chip) => chip.includes("Kore")),
    false,
    "ボイスは本文の上のバッジが担う",
  );
});

test("ツール履歴のヘッダはモデルが混在したときに片方だけを見せない", () => {
  const html = renderHistory(
    [
      card("t1", "generate_image", "done", { output: IMAGE_OUTPUT }),
      card("t2", "generate_image", "done", { output: IMAGE_OUTPUT.replace("openai/gpt-image-2", "x-ai/grok-image") }),
    ],
    false,
  );
  assert.deepEqual(chips(html), ["mixed", "openai/gpt-image-2", "x-ai/grok-image"]);
  assert.ok(html.includes("複数モデル"));
  assert.ok(html.includes('title="openai/gpt-image-2 / x-ai/grok-image"'), "内訳を title に残す");
});

test("ツール履歴のチップは生成ツールの行だけに出し、モデル行や結果が無ければ出さない", () => {
  // 生成以外のツールはモデル行と同じ文言が結果にあってもチップを出さない
  const other = renderHistory([card("t1", "bash", "done", { output: IMAGE_OUTPUT })], false);
  assert.deepEqual(chips(other), []);

  // モデル行を書く前のセッション (旧サーバー) と、失敗したカード
  const legacy = renderHistory(
    [card("t1", "generate_image", "done", { output: "画像を生成して保存しました: generated/legacy.png" })],
    false,
  );
  assert.deepEqual(chips(legacy), []);

  // 全行が同じモデルならヘッダのチップは 1 つに畳む
  const same = renderHistory(
    [
      card("t1", "generate_image", "done", { output: IMAGE_OUTPUT }),
      card("t2", "generate_image", "done", { output: IMAGE_OUTPUT }),
    ],
    false,
  );
  assert.deepEqual(chips(same), ["openai/gpt-image-2", "openai/gpt-image-2", "openai/gpt-image-2"]);
  const failed = renderHistory(
    [
      card("t1", "generate_image", "failed", {
        output: "画像生成が混雑しています（レート制限またはプロバイダー障害）",
      }),
    ],
    false,
  );
  assert.deepEqual(chips(failed), []);

  // 進行中のターンでは実行中のカードを出さないため、完了した生成の分だけが残る
  const running = renderHistory(
    [card("t1", "generate_image", "done", { output: IMAGE_OUTPUT }), card("t2", "generate_image", "running")],
    true,
  );
  assert.deepEqual(chips(running), ["openai/gpt-image-2", "openai/gpt-image-2"]);
});

test("ツール履歴は検索プロバイダーを行とヘッダのチップに出し、畳んだままでも読める", () => {
  const html = renderHistory([card("t1", "web_search", "done", { output: WEB_SEARCH_OUTPUT })], false);
  assert.deepEqual(webSearchChips(html), ["Exa", "Exa"], "ヘッダと行の両方に出す");
  assert.ok(html.includes('title="Exa"'), "切れたときに読めるよう全文を title に残す");

  // 失敗カードの本文にも provider 行が入るため、失敗でもチップを出す
  const failed = renderHistory(
    [
      card("t1", "web_search", "failed", {
        output: "現在日時: 2026-10-07 (Asia/Tokyo)\n検索プロバイダー: Tavily\n検索が混雑しています（レート制限）",
      }),
    ],
    false,
  );
  assert.deepEqual(webSearchChips(failed), ["Tavily", "Tavily"]);
});

test("ツール履歴のヘッダは provider が混在したときに片方だけを見せない", () => {
  const html = renderHistory(
    [
      card("t1", "web_search", "done", { output: WEB_SEARCH_OUTPUT }),
      card("t2", "web_search", "done", { output: WEB_SEARCH_OUTPUT.replace("Exa", "Tavily") }),
    ],
    false,
  );
  assert.deepEqual(webSearchChips(html), ["mixed", "Exa", "Tavily"]);
  assert.ok(html.includes("複数プロバイダー"));
  assert.ok(html.includes('title="Exa / Tavily"'), "内訳を title に残す");
});

test("provider のチップは web_search の行だけに出し、provider 行が無ければ出さない", () => {
  // 検索以外のツールは provider 行と同じ文言が結果にあってもチップを出さない
  const other = renderHistory([card("t1", "bash", "done", { output: WEB_SEARCH_OUTPUT })], false);
  assert.deepEqual(webSearchChips(other), []);

  // provider 行を書く前のセッション (旧サーバー) と、設定を読めずに失敗したカード
  const legacy = renderHistory(
    [card("t1", "web_search", "done", { output: "現在日時: 2026-10-07 (Asia/Tokyo)\n出典:\n[1] T" })],
    false,
  );
  assert.deepEqual(webSearchChips(legacy), []);

  const same = renderHistory(
    [
      card("t1", "web_search", "done", { output: WEB_SEARCH_OUTPUT }),
      card("t2", "web_search", "done", { output: WEB_SEARCH_OUTPUT }),
    ],
    false,
  );
  assert.deepEqual(webSearchChips(same), ["Exa", "Exa", "Exa"], "全行が同じ provider ならヘッダは 1 つに畳む");
});

test("生成モデルと provider のチップは同じターンに同居する", () => {
  const html = renderHistory(
    [
      card("t1", "generate_image", "done", { output: IMAGE_OUTPUT }),
      card("t2", "web_search", "done", { output: WEB_SEARCH_OUTPUT }),
    ],
    false,
  );
  assert.deepEqual(chips(html), ["openai/gpt-image-2", "openai/gpt-image-2"]);
  assert.deepEqual(webSearchChips(html), ["Exa", "Exa"]);
});
