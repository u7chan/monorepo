// 入力欄の上の状態行 (活動 / モデル / Context ゲージ) の描画。
// モデル名を出す条件と、読み上げに載せる範囲 (aria-live) を react-dom/server で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerStatus } from "../src/components/composer/ComposerStatus";

type Props = Parameters<typeof ComposerStatus>[0];

const render = (props: Props): string => renderToStaticMarkup(createElement(ComposerStatus, props));

const context = { tokens: 114000, contextWindow: 272000, percent: 42 };

test("描画: モデル名は表示名で出し、provider/id を title に持つ", () => {
  const html = render({ activity: "", model: "anthropic/claude-sonnet-4-5", modelLabel: "Claude Sonnet 4.5" });

  assert.ok(html.includes(">Claude Sonnet 4.5<"), "表示名を出す");
  assert.ok(html.includes('title="anthropic/claude-sonnet-4-5"'), "切り詰めたときのために provider/id を残す");
});

test("描画: 活動もコンテキストも無くても、モデルが解決できていれば行を出す", () => {
  const html = render({ activity: "", model: "zai/glm-5.3-flash", modelLabel: "GLM-5.3 Flash" });

  assert.ok(html.includes(">GLM-5.3 Flash<"));
  assert.ok(!html.includes("Context"), "セッション未作成ではゲージを出さない");
});

test("描画: 活動が無いときは活動欄を出さない (空行の折り返しを残さない)", () => {
  const html = render({ activity: "", context, model: "zai/glm-5.3-flash", modelLabel: "GLM-5.3 Flash" });

  assert.ok(!html.includes("aria-live"), "活動欄ごと落とす");
  assert.ok(html.includes("GLM-5.3 Flash") && html.includes("Context"), "モデル名とゲージは残す");
});

test("描画: モデルも活動もコンテキストも無ければ何も出さない", () => {
  assert.equal(render({ activity: "" }), "");
});

test("描画: モデル名とゲージは aria-live の外へ置く", () => {
  const html = render({
    activity: "実行中…（タブを閉じても処理は続きます）",
    runningSince: Date.now(),
    context,
    model: "zai/glm-5.3-flash",
    modelLabel: "GLM-5.3 Flash",
  });
  const liveStart = html.indexOf('aria-live="polite"');
  const liveEnd = html.indexOf("</span>", liveStart);
  const live = html.slice(liveStart, liveEnd);

  assert.ok(live.includes("実行中…（タブを閉じても処理は続きます）"), "活動テキストは読み上げる");
  assert.ok(!live.includes("GLM-5.3 Flash"), "モデル名は毎回読み上げない");
  assert.ok(!live.includes("Context"), "ゲージは毎回読み上げない");
  assert.ok(html.includes("(0s)"), "経過時間は aria-hidden の別スパンに出す");
});

test("描画: 利用できないモデルは warn 色にする", () => {
  const missing = render({ activity: "", model: "ghost/none", modelLabel: "ghost/none", modelUnavailable: true });
  const available = render({ activity: "", model: "ghost/none", modelLabel: "ghost/none" });

  assert.ok(missing.includes("text-warn"));
  assert.ok(!available.includes("text-warn"), "利用できるときは warn 色にしない");
});

// --- 手動圧縮の導線 ---

test("描画: セッションがあると Context ゲージの右に圧縮ボタンを出す", () => {
  const html = render({
    activity: "",
    context,
    model: "zai/glm-5.3-flash",
    modelLabel: "GLM-5.3 Flash",
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
  const html = render({ activity: "", model: "zai/glm-5.3-flash", modelLabel: "GLM-5.3 Flash", onCompact: () => {} });

  assert.ok(!html.includes("Context"), "ゲージは出さない");
  assert.ok(html.includes('aria-label="会話を圧縮"'));
});

test("描画: 未作成チャット (onCompact なし) では圧縮ボタンも押せない理由も出さない", () => {
  const html = render({ activity: "", context, model: "zai/glm-5.3-flash", modelLabel: "GLM-5.3 Flash" });

  assert.ok(!html.includes("会話を圧縮"));
  assert.ok(!html.includes("今は圧縮できません"));
});

test("描画: 押せないときは disabled にし、理由を状態行の下に可視の 1 行で出す", () => {
  const html = render({
    activity: "会話を整理中…",
    context,
    model: "zai/glm-5.3-flash",
    modelLabel: "GLM-5.3 Flash",
    onCompact: () => {},
    compactDisabled: true,
    compactDisabledReason: "圧縮中",
  });

  assert.ok(html.includes('disabled=""'));
  // 理由は hover や読み上げだけに閉じず、画面上に出す (設定の変更中など活動テキストが理由を示さない状態がある)
  const paragraph = /<p id="[^"]+" class="([^"]*)">今は圧縮できません（圧縮中）<\/p>/.exec(html);
  assert.ok(paragraph, "理由の文を状態行の下に出す");
  assert.ok(!paragraph[1].includes("sr-only"), "読み上げ専用にしない (タッチ端末でも読める)");
  assert.ok(
    paragraph[1].includes("text-2xs") && paragraph[1].includes("text-right"),
    "小さい文字で押した行の下へ寄せる",
  );
  const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(described, "押せない理由を読み上げへ渡す");
  assert.ok(html.includes(`id="${described}"`), "describedby の参照先が存在する");
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
      model: "zai/glm-5.3-flash",
      modelLabel: "GLM-5.3 Flash",
      runStatus: "error",
      runError: { ...failure, code },
      onRetry: () => {},
    });

    assert.ok(html.includes(failure.text), `${code} は BFF の 1 文をそのまま出す`);
    assert.ok(html.includes("dot-danger"), "RuntimeAlert と同じ赤ドットで揃える");
    assert.ok(html.includes("前回の続きから送信します"), "デスクトップは補助行で送信内容を示す");
    const button = /<button[^>]*>.*?<\/button>/s.exec(html)?.[0] ?? "";
    assert.ok(button.includes(">再実行<"), "デスクトップのラベルは補助行の分だけ短くする");
    assert.ok(button.includes("<svg"), "押すと何が起きるかを更新アイコンで示す (RefreshIcon)");
    assert.ok(!html.includes('role="alert"'), "同じ文言を RuntimeAlert と二重に読み上げない");
    assert.ok(html.indexOf(failure.text) < html.indexOf("GLM-5.3 Flash"), "状態行 (モデル / ゲージ) の上に置く");
  }
});

test("描画: compact はボタンを全幅にし、ラベルが送信内容を兼ねる (補助行は出さない)", () => {
  const html = render({
    activity: "",
    compact: true,
    runStatus: "error",
    runError: failure,
    onRetry: () => {},
  });

  assert.ok(html.includes("再実行（前回の続きから送信）"), "compact はラベルで送信内容を示す");
  assert.ok(!html.includes("前回の続きから送信します"), "同じ内容を 2 回出さない");
  const button = /<button[^>]*>.*?<\/button>/s.exec(html)?.[0] ?? "";
  assert.ok(button.includes("btn-quiet") && button.includes("w-full"), "細いボタンを押し損ねないよう全幅にする");
});

test("描画: 同じ送信では直らない分類と、コードが無い縮退ではカードを出さない", () => {
  for (const code of ["auth_required", "insufficient_quota", "context_overflow"] as const) {
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
    model: "zai/glm-5.3-flash",
    modelLabel: "GLM-5.3 Flash",
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
    model: "zai/glm-5.3-flash",
    modelLabel: "GLM-5.3 Flash",
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
