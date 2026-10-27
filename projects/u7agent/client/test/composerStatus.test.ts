// 入力欄の上の状態行 (活動 / モデル - Effort の入口 / Context ゲージ) の描画。
// 入口のスロットを出す条件と配置、読み上げに載せる範囲 (aria-live) を react-dom/server で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerStatus } from "../src/components/composer/ComposerStatus";
import type { ToolCall } from "../src/types";

type Props = Parameters<typeof ComposerStatus>[0];

const render = (props: Props): string => renderToStaticMarkup(createElement(ComposerStatus, props));

/**
 * 経過時間のテスト用の基準時刻。描画側は `useElapsedMs` で描画時の `Date.now()` を読み、fixture も
 * `Date.now()` から作るので、テスト中はこの値に時計を固定して両者を同じ瞬間にする。
 */
const NOW = Date.now();

/** モデル / Effort の入口のスタブ。中身の描画はピッカーのテストが受け持つ */
const slot = (text = "GLM-5.3 Flash"): Props["modelSlot"] => createElement("span", null, text);

const context = { tokens: 114000, contextWindow: 272000, percent: 42 };

/** 回答待ちの ask_user (runTools)。待機の理由は、このカードとキューの件数で決まる */
const pendingQuestion = (): ToolCall => ({
  id: "q1",
  name: "ask_user",
  args: "",
  isError: false,
  done: false,
  output: "",
  questions: [{ question: "どちらで進めますか" }],
});

const runningTool = (id: string, name: string, args: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name,
  args,
  isError: false,
  done: false,
  output: "",
  ...extra,
});

test("描画: 実行中のツールは状態行に最新1件を出し、サーバーの汎用文言を上書きする", () => {
  const html = render({
    activity: "実行中…",
    runStatus: "running",
    runTools: {
      t1: runningTool("t1", "bash", "ls", { done: true, output: "ok" }),
      t2: runningTool("t2", "read", "docs/frontend.md"),
    },
  });

  assert.ok(html.includes("実行中 · read — docs/frontend.md"), "最新の実行中ツールを出す");
  assert.equal(html.includes("実行中…"), false, "汎用の活動文言ではなくツールを出す");
  assert.ok(html.includes('title="read — docs/frontend.md'), "全文を title に残す");
});

test("描画: 実行中ツールの文言は読み上げの連発を避けて aria-live の対象から外す", () => {
  const html = render({
    activity: "考え中…",
    runStatus: "running",
    runTools: { t1: runningTool("t1", "bash", "ls") },
  });

  const liveStart = html.indexOf('aria-live="off"');
  assert.ok(liveStart >= 0, "ツール文言は live の対象から外す");
  assert.ok(html.slice(liveStart, html.indexOf("</span>", liveStart)).includes("実行中 · bash — ls"));
  assert.equal(html.includes('aria-live="polite"'), false, "ツール名を polite で読み上げない");
});

test("描画: 並列実行は件数を出し、investigate の進捗を優先する", () => {
  const html = render({
    activity: "実行中…",
    runStatus: "running",
    runTools: {
      t1: runningTool("t1", "read", "a.md"),
      t2: runningTool("t2", "investigate", "docs を調べて", {
        progress: "bash rg -n foo\n結論: docs にある",
      }),
    },
  });

  assert.ok(html.includes("2件実行中 · investigate — bash rg -n foo"), "件数と現在の活動を出す");
  assert.ok(html.includes("結論: docs にある"), "本文末尾は title に残す");
});

test("描画: 実行中の行が無ければツール文言を出さず、サーバーの活動へ戻す", () => {
  const html = render({
    activity: "考え中…",
    runStatus: "running",
    runTools: { t1: runningTool("t1", "bash", "ls", { done: true, output: "ok" }) },
  });

  assert.equal(html.includes("bash — ls"), false, "完了した行だけなら出さない");
  assert.ok(html.includes("考え中…"));
});

test("描画: 回答待ちで待機キューがあるとき、回答してもすぐ実行されない理由を状態行の下に出す", () => {
  // What: 回答待ちの run が終わらないと待機中の送信が始まらないことを、可視の 1 文で示す。
  // 状態行の中に置くと、幅が足りないときに活動ラベルと折り返しを奪い合うため、行の外に出す
  const html = render({
    activity: "回答を待っています…",
    runStatus: "running",
    runTools: { q1: pendingQuestion() },
    queueDepth: 1,
    context,
    modelSlot: slot(),
  });

  const reason = html.indexOf("回答後、この応答とツールが終わった時点で待機中の送信が反映されます");
  assert.ok(reason >= 0, "1 文を可視で出す");
  const liveStart = html.indexOf('aria-live="polite"');
  const liveEnd = html.indexOf("</span>", liveStart);
  assert.ok(
    !html.slice(liveStart, liveEnd).includes("回答しても"),
    "件数の増減で読み上げ直さないよう aria-live の外に置く",
  );
  assert.ok(reason > liveEnd, "活動ラベルと同じ span に置かない (折り返しを奪い合わない)");
  // 状態行 (ゲージ) を先に出しておく。無いまま indexOf を比較すると常に真になり、
  // 理由を状態行の中へ戻す退行を検知できない
  const gauge = html.indexOf('role="progressbar"');
  assert.ok(gauge >= 0, "ゲージを出す (下の比較の前提)");
  assert.ok(reason > gauge, "状態行より後ろ = 行の外に出す");

  const singleColumn = render({
    activity: "回答を待っています…",
    runStatus: "running",
    runTools: { q1: pendingQuestion() },
    queueDepth: 1,
    singleColumn: true,
  });
  assert.ok(singleColumn.includes("回答後、この応答とツールが終わった時点で待機中の送信が反映されます"));
});

test("描画: 回答待ちとキューが揃わなければ待機の理由を出さない", () => {
  const waiting = {
    activity: "回答を待っています…",
    runStatus: "running",
    runTools: { q1: pendingQuestion() },
  } as const;
  assert.ok(!render({ ...waiting }).includes("回答しても"), "キューが空なら待ちの理由が無い");
  assert.ok(!render({ ...waiting, queueDepth: 0 }).includes("回答しても"), "サーバーが 0 を配る縮退でも出さない");

  const running = render({
    activity: "実行中…",
    runStatus: "running",
    runTools: { t1: { id: "t1", name: "bash", args: "", isError: false, done: false, output: "" } },
    queueDepth: 1,
  });
  assert.ok(!running.includes("回答しても"), "回答待ちが無い待ちは状態行の活動文言に任せる");

  const settled = render({
    activity: "実行中…",
    runStatus: "running",
    runTools: { q1: { ...pendingQuestion(), done: true } },
    queueDepth: 1,
  });
  assert.ok(!settled.includes("回答しても"), "回答が settle した後は待ちの理由を出さない");

  const ended = render({
    activity: "前回の実行は停止されました",
    runStatus: "stopped",
    runTools: { q1: pendingQuestion() },
    queueDepth: 1,
  });
  assert.ok(!ended.includes("回答しても"), "回答できない終端では出さない");
});

test("描画: モデル / Effort の入口をゲージの左、圧縮ボタンの手前に置く", () => {
  const html = render({ activity: "", context, modelSlot: slot(), onCompact: () => {} });

  const slotIndex = html.indexOf("GLM-5.3 Flash");
  const gaugeIndex = html.indexOf("Context");
  const compactIndex = html.indexOf('aria-label="会話を圧縮"');
  assert.ok(slotIndex >= 0 && gaugeIndex > slotIndex, "ゲージより左に置く");
  assert.ok(compactIndex > gaugeIndex, "ゲージと圧縮ボタンの並びは変えない");
});

test("描画: 活動もコンテキストも無くても、入口があれば行を出す", () => {
  const html = render({ activity: "", modelSlot: slot() });

  assert.ok(html.includes(">GLM-5.3 Flash<"));
  assert.ok(!html.includes("Context"), "セッション未作成ではゲージを出さない");
});

test("描画: 活動が無いときは活動欄を出さない (空行の折り返しを残さない)", () => {
  const html = render({ activity: "", context, modelSlot: slot() });

  assert.ok(!html.includes("aria-live"), "活動欄ごと落とす");
  assert.ok(html.includes("GLM-5.3 Flash") && html.includes("Context"), "入口とゲージは残す");
});

test("描画: 入口も活動もコンテキストも無ければ何も出さない", () => {
  assert.equal(render({ activity: "" }), "");
});

test("描画: モデル / Effort の入口とゲージは aria-live の外へ置く", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const html = render({
    activity: "実行中…（タブを閉じても処理は続きます）",
    runningSince: Date.now(),
    context,
    modelSlot: slot(),
  });
  const liveStart = html.indexOf('aria-live="polite"');
  const liveEnd = html.indexOf("</span>", liveStart);
  const live = html.slice(liveStart, liveEnd);

  assert.ok(live.includes("実行中…（タブを閉じても処理は続きます）"), "活動テキストは読み上げる");
  assert.ok(!live.includes("GLM-5.3 Flash"), "モデル / Effort の入口は毎回読み上げない");
  assert.ok(!live.includes("Context"), "ゲージは毎回読み上げない");
  assert.ok(html.includes("(実行 0s)"), "経過時間は run の経過だと分かる形で aria-hidden の別スパンに出す");
});

test("描画: 活動欄はツールの有無で折り返しを変えず、常に1行に切る", () => {
  const activity = "investigate を実行中…".repeat(12);
  const idle = render({ activity, modelSlot: slot() });
  const live = render({
    activity,
    runStatus: "running",
    modelSlot: slot(),
    runTools: { t1: runningTool("t1", "investigate", activity) },
  });

  for (const html of [idle, live]) {
    const span = /<span aria-live="(?:polite|off)" title="([^"]*)" class="([^"]*)">/.exec(html);
    assert.ok(span);
    assert.ok(span[2].includes("truncate"), "1行に切る");
    assert.equal(span[2].includes("break-words"), false, "ツールの有無で折り返しを変えない");
  }
  const idleTitle = /<span aria-live="polite" title="([^"]*)"/.exec(idle)?.[1];
  assert.ok(idleTitle?.includes(activity), "切った全文は title で読める");
});

test("描画: 活動が空なら活動欄ごと出さない (空行を残さない)", () => {
  // 合計時間は会話のメタ行が担うため、状態行に残るのは活動の語だけ
  const html = render({ activity: "完了", modelSlot: slot() });
  assert.ok(html.includes(">完了<"), "活動の語は残す");
  assert.equal(render({ activity: "" }), "");
});

test("描画: 実行中の経過時間は 10 秒の拍の枠に出し、1 分以降だけ色を残す", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const fresh = render({
    activity: "実行中…",
    runningSince: Date.now(),
    modelSlot: slot(),
  });
  assert.ok(fresh.includes("elapsed-beat"), "数字は拍の枠に出す");
  assert.ok(!fresh.includes("elapsed-beat-tier"), "1 分未満では色を残さない");
  assert.ok(fresh.includes("run-spinner"), "実行中はスピナーを出す");

  const long = render({
    activity: "実行中…",
    runningSince: Date.now() - 90_000,
    modelSlot: slot(),
  });
  assert.match(long, /\(実行 1m 3\ds\)/, "1 分を超えたら分と秒で出す");
  assert.ok(long.includes("elapsed-beat-tier"), "長いランは色を残す");
});

// What: 状態行の数字は run 全体の経過で、直前のツールの所要時間ではない。
test("描画: 経過時間は直近ツールの所要時間ではなく run 全体の経過を出す", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const now = Date.now();
  const html = render({
    activity: "bash を実行中…",
    runningSince: now - 70_000,
    runStatus: "running",
    runTools: {
      t1: { id: "t1", name: "bash", args: "", isError: false, done: false, output: "", startedAt: now - 2_000 },
    },
  });

  assert.match(html, /\(実行 1m 1[01]s\)/, "run の経過を出す");
  assert.ok(!html.includes("(実行 2s)"), "ツールの所要時間を run の経過として出さない");
});

test("描画: 実行中の経過時間は回答待ち (ask_user の区間) を除く", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const now = Date.now();
  const runningSince = now - 70_000;
  const open = (id: string, startedAt: number) => ({
    id,
    name: "ask_user",
    args: "",
    isError: false,
    done: false,
    output: "",
    startedAt,
  });
  const html = render({
    activity: "回答を待っています…",
    runningSince,
    runStatus: "running",
    // 並行に 2 枚待っても同じ実時間 (60 秒) を 2 回引かない
    runTools: { q1: open("q1", now - 60_000), q2: open("q2", now - 50_000) },
  });

  assert.match(html, /\(実行 10s\)/, "待機 60 秒を引いた 10 秒を出す");
  assert.ok(!html.includes("elapsed-beat-tier"), "待機を引いた値で色を判定する");
});

test("描画: 回答が届いたカードは待機の続きから数え、開始の無いカードは従来どおり数える", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const now = Date.now();
  const runningSince = now - 70_000;
  const base = { name: "ask_user", args: "", isError: false, done: false, output: "" };
  const answered = render({
    activity: "実行中…",
    runningSince,
    runStatus: "running",
    runTools: { q1: { ...base, id: "q1", done: true, startedAt: now - 60_000, endedAt: now - 50_000 } },
  });
  assert.match(answered, /\(実行 1m 0s\)/, "待機 10 秒だけを引いて続きを数える");

  const noStart = render({
    activity: "実行中…",
    runningSince,
    runStatus: "running",
    runTools: { q1: { ...base, id: "q1", endedAt: now - 50_000 } },
  });
  assert.match(noStart, /\(実行 1m 1[01]s\)/, "startedAt が無ければ待機を含めて数える");
});

test("描画: 圧縮中の経過時間は前の run の回答待ちを引かない", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const now = Date.now();
  const html = render({
    activity: "会話を整理中…",
    runningSince: now - 70_000,
    runStatus: "compacting",
    runTools: {
      q1: {
        id: "q1",
        name: "ask_user",
        args: "",
        isError: false,
        done: true,
        output: "",
        startedAt: now - 60_000,
        endedAt: now - 50_000,
      },
    },
  });

  assert.match(html, /\(実行 1m 1[01]s\)/, "圧縮の起点からの経過をそのまま出す");
});

// --- 手動圧縮の導線 ---

test("描画: セッションがあると Context ゲージの右に圧縮ボタンを出す", () => {
  const html = render({
    activity: "",
    context,
    modelSlot: slot(),
    onCompact: () => {},
  });

  const gaugeIndex = html.indexOf('aria-label="コンテキスト使用量"');
  const compactIndex = html.indexOf('aria-label="会話を圧縮"');
  assert.ok(gaugeIndex >= 0 && compactIndex > gaugeIndex, "モデル名 + ゲージと同じ組の右端に置く");
  assert.ok(html.includes("composer-status-icon"), "36px の .icon-button ではなく状態行用の小さい variant");
  assert.ok(!html.includes('aria-label="会話を圧縮" title='), "アイコンだけのボタンは aria-label で名前を伝える");
  // 押す前に読ませる補足は置かない。不可逆性と課金は押した時点の確認 (window.confirm) が示す
  assert.ok(!html.includes("圧縮の注意"), "注意を開く専用のボタンを並べない");
  assert.ok(!html.includes("元のメッセージは GUI から戻せません"), "状態行に注意書きを出さない");
  assert.ok(!html.includes("aria-describedby"), "押せるときは補足の文を持たない");
  assert.ok(!html.includes("disabled"), "idle では押せる");
});

test("描画: ゲージが無くても (SDK 未対応) セッションがあれば圧縮ボタンを出す", () => {
  const html = render({ activity: "", modelSlot: slot(), onCompact: () => {} });

  assert.ok(!html.includes("Context"), "ゲージは出さない");
  assert.ok(html.includes('aria-label="会話を圧縮"'));
});

test("描画: 未作成チャット (onCompact なし) では圧縮ボタンも押せない理由も出さない", () => {
  const html = render({ activity: "", context, modelSlot: slot() });

  assert.ok(!html.includes("会話を圧縮"));
  assert.ok(!html.includes("今は圧縮できません"));
});

test("描画: 押せないときは disabled にし、理由を状態行の下に可視の 1 行で出す", () => {
  const html = render({
    activity: "会話を整理中…",
    context,
    modelSlot: slot(),
    onCompact: () => {},
    compactDisabled: true,
    compactDisabledReason: "設定の変更中",
  });

  assert.ok(html.includes('disabled=""'));
  // 理由は hover や読み上げだけに閉じず、画面上に出す (設定の変更中など活動テキストが理由を示さない状態がある)
  const paragraph = /<p id="[^"]+" class="([^"]*)">今は圧縮できません（設定の変更中）<\/p>/.exec(html);
  assert.ok(paragraph, "理由の文を状態行の下に出す");
  assert.ok(!paragraph[1].includes("sr-only"), "読み上げ専用にしない (タッチ端末でも読める)");
  // 小さい文字で右寄せにする体裁は、待機の理由と共有する説明の行が持つ
  const notice = /<div class="([^"]*)"><p[^>]*>今は圧縮できません/.exec(html);
  assert.ok(notice, "理由を説明の行へ入れる");
  assert.ok(notice[1].includes("text-2xs") && notice[1].includes("text-right"), "小さい文字で押した行の下へ寄せる");
  const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(described, "押せない理由を読み上げへ渡す");
  assert.ok(html.includes(`id="${described}"`), "describedby の参照先が存在する");
});

test("描画: 実行中は状態行が理由を兼ね、圧縮の理由行で高さを動かさない", () => {
  const html = render({
    activity: "実行中…",
    runStatus: "running",
    modelSlot: slot(),
    onCompact: () => {},
    compactDisabled: true,
    compactDisabledReason: "実行中",
  });

  assert.ok(html.includes('disabled=""'), "圧縮ボタンは引き続き無効");
  assert.equal(html.includes("今は圧縮できません"), false, "実行中の理由行を出さない");
});

// --- 最終失敗の再実行カード ---

const failure = {
  code: "rate_limit",
  text: "レート制限により実行に失敗しました（自動再試行4回）。時間をおいて再実行してください",
} as const;

test("描画: 回復し得る失敗ではカードを状態行の上に出し、文言をカードへ移す", () => {
  for (const code of ["rate_limit", "unknown"] as const) {
    const html = render({
      activity: "",
      modelSlot: slot(),
      runStatus: "error",
      runError: { ...failure, code },
      onRetry: () => {},
    });

    assert.ok(html.includes(failure.text), `${code} は BFF の 1 文をそのまま出す`);
    assert.ok(html.includes("dot-danger"), "RuntimeAlert と同じ赤ドットで揃える");
    assert.ok(html.includes("前回の続きから送信します"), "デスクトップは補助行で送信内容を示す");
    const button = /<button[^>]*>.*?<\/button>/s.exec(html)?.[0] ?? "";
    assert.ok(button.includes(">再実行<"), "デスクトップのラベルは補助行の分だけ短くする");
    assert.ok(button.includes("<svg"), "押すと何が起きるかを取り直しのアイコンで示す (ReloadButton)");
    assert.ok(!html.includes('role="alert"'), "同じ文言を RuntimeAlert と二重に読み上げない");
    assert.ok(html.indexOf(failure.text) < html.indexOf("GLM-5.3 Flash"), "状態行 (モデル / ゲージ) の上に置く");
  }
});

test("描画: singleColumn はボタンを全幅にし、ラベルが送信内容を兼ねる (補助行は出さない)", () => {
  const html = render({
    activity: "",
    singleColumn: true,
    runStatus: "error",
    runError: failure,
    onRetry: () => {},
  });

  assert.ok(html.includes("再実行（前回の続きから送信）"), "singleColumn はラベルで送信内容を示す");
  assert.ok(!html.includes("前回の続きから送信します"), "同じ内容を 2 回出さない");
  const button = /<button[^>]*>.*?<\/button>/s.exec(html)?.[0] ?? "";
  assert.ok(button.includes("btn-quiet") && button.includes("w-full"), "細いボタンを押し損ねないよう全幅にする");
});

test("描画: 同じ送信では直らない分類と、コードが無い縮退ではカードを出さない", () => {
  for (const code of ["auth_required", "oauth_expired", "insufficient_quota", "context_overflow"] as const) {
    const html = render({
      activity: "エラー: テスト",
      runStatus: "error",
      runError: { ...failure, code },
      onRetry: () => {},
    });

    assert.ok(!html.includes("ドット") && !html.includes("dot-danger"), `${code} はカードを出さない`);
    assert.ok(!html.includes("再実行"), `${code} は再実行の導線を出さない`);
    assert.ok(html.includes("エラー: テスト"), "状態行の現行文言を残す");
  }

  // 旧 payload などの縮退。run.error の文言は状態行に出たままにする
  const legacy = render({ activity: "エラー: 旧 payload", runStatus: "error", onRetry: () => {} });
  assert.ok(!legacy.includes("dot-danger"));
  assert.ok(legacy.includes("エラー: 旧 payload"));
});

test("描画: 停止・完了・キュー待ちではカードを出さない", () => {
  for (const runStatus of ["queued", "stopped", "completed", "idle", "running"] as const) {
    const html = render({ activity: "完了", runStatus, runError: failure, onRetry: () => {} });

    assert.ok(!html.includes("dot-danger"), `${runStatus} ではカードを出さない`);
    assert.ok(!html.includes("再実行"), `${runStatus} では再実行を出さない`);
  }
});

test("描画: カードだけでも描画する (activity が空でも早期 return しない)", () => {
  const html = render({ activity: "", runStatus: "error", runError: failure, onRetry: () => {} });

  assert.ok(html.includes("dot-danger"));
  assert.ok(html.includes("再実行"));
});

test("描画: 再実行が押せないときは理由を 1 行で出し、圧縮の文言を流用しない", () => {
  const html = render({
    activity: "",
    modelSlot: slot(),
    context,
    onCompact: () => {},
    runStatus: "error",
    runError: failure,
    onRetry: () => {},
    retryDisabled: true,
    retryDisabledReason: "添付のアップロード中",
  });

  assert.ok(html.includes('disabled=""'), "押せない間は無効にする");
  const paragraph = /<p id="([^"]+)" class="[^"]*">([^<]*)<\/p>/.exec(html);
  assert.ok(paragraph, "押せない理由を状態行の下に 1 行で出す");
  assert.equal(paragraph[2], "今は再実行できません（添付のアップロード中）");
  assert.ok(!html.includes("今は圧縮できません"), "再実行だけが無効なときに圧縮を押せないと誤案内しない");
  assert.ok(html.includes(`aria-describedby="${paragraph[1]}"`), "理由を読み上げへ渡す");
  assert.ok(!html.includes('aria-label="再実行"'), "押せるときと同じく可視のラベルで名前を伝える");
});

test("描画: 圧縮と再実行が同時に無効なときも理由の行は 1 つにまとめる", () => {
  const html = render({
    activity: "",
    modelSlot: slot(),
    context,
    onCompact: () => {},
    compactDisabled: true,
    compactDisabledReason: "送信中",
    runStatus: "error",
    runError: failure,
    onRetry: () => {},
    retryDisabled: true,
    retryDisabledReason: "送信中",
  });

  assert.equal((html.match(/<p id=/g) ?? []).length, 1, "理由の行を増やさない");
  assert.ok(html.includes("今は圧縮も再実行もできません（送信中）"));
});

test("描画: 操作の結果 (取り消しの失敗理由) を状態行の下に残し、活動文言と並べて出す", () => {
  // What: 取り消せなかった理由は活動行 (aria-live) ではなく下の 1 行に出す。後から届く status で
  // 活動文言が入れ替わっても理由は読める位置に残る
  const html = render({
    activity: "実行中…",
    activityState: "thinking",
    runStatus: "running",
    notice: "実行が始まったため取り消せません",
  });

  const reason = html.indexOf("実行が始まったため取り消せません");
  assert.ok(reason >= 0, "理由を可視で出す");
  assert.ok(html.includes('role="status"'), "自分の live region で 1 回読み上げる");
  const liveStart = html.indexOf('aria-live="polite"');
  const liveEnd = html.indexOf("</span>", liveStart);
  assert.ok(!html.slice(liveStart, liveEnd).includes("実行が始まった"), "活動の読み上げに混ぜない");
  assert.ok(reason > liveEnd, "活動ラベルと同じ span に置かない (折り返しを奪い合わない)");
  assert.ok(html.includes("実行中…"), "活動文言は消さない");
  // 状態行が無い (活動もゲージも無い) 状態でも、操作の結果だけは落とさない
  assert.ok(render({ activity: "", notice: "待機中のメッセージが見つかりません" }).includes("待機中のメッセージ"));
  assert.ok(!render({ activity: "実行中…" }).includes('role="status"'), "結果が無ければ行ごと出さない");
});
