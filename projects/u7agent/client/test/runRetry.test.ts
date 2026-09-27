// 最終失敗したランの再実行導線。カードの表示条件と押せない理由は純関数で固定し、
// 送信の配線 (App → handleSend) はソース走査で確かめる (compaction.test.ts の前例)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  blockedButtonsNotice,
  retryableRunError,
  runErrorFrom,
  runRetryBlockedReason,
  RUN_RETRY_LABEL,
  RUN_RETRY_LABEL_COMPACT,
  RUN_RETRY_NOTE,
  RUN_RETRY_PROMPT,
  type RunErrorInfo,
} from "../src/lib/runRetry";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const error = (code: RunErrorInfo["code"], text = "レート制限により実行に失敗しました"): RunErrorInfo => ({
  code,
  text,
});

// --- 文言 ---

test("再実行は直前のターンを再実行する API が無いため、続きを促す固定文言を送る", () => {
  assert.equal(RUN_RETRY_PROMPT, "前回の続きから再開してください");
});

test("ラベルはデスクトップで短くし、compact は送信内容を兼ねる", () => {
  assert.equal(RUN_RETRY_LABEL, "再実行");
  assert.equal(RUN_RETRY_LABEL_COMPACT, "再実行（前回の続きから送信）");
  assert.ok(RUN_RETRY_LABEL_COMPACT.startsWith(RUN_RETRY_LABEL), "ボタンの名前は同じ「再実行」");
  assert.ok(RUN_RETRY_LABEL_COMPACT.includes("前回の続きから送信"), "compact はラベルで送信内容を示す");
  assert.equal(RUN_RETRY_NOTE, "前回の続きから送信します");
});

// --- 表示条件 ---

test("再実行カードは時間をおけば回復し得る分類だけに出す", () => {
  assert.deepEqual(retryableRunError("error", error("rate_limit")), error("rate_limit"));
  assert.deepEqual(retryableRunError("error", error("unknown")), error("unknown"));
  for (const code of ["auth_required", "insufficient_quota", "context_overflow"] as const) {
    assert.equal(retryableRunError("error", error(code)), undefined, `${code} は同じ送信では直らない`);
  }
  assert.equal(retryableRunError("error", undefined), undefined, "分類コードが無い縮退では出さない");
});

test("カードは runStatus が error のときだけ出す (キュー待ちと停止では出さない)", () => {
  for (const status of ["idle", "running", "queued", "compacting", "completed", "stopped"] as const) {
    assert.equal(retryableRunError(status, error("rate_limit")), undefined, `${status} では出さない`);
  }
});

test("保持する失敗は status === error のときだけ作る", () => {
  assert.deepEqual(runErrorFrom("error", "rate_limit", "レート制限です"), {
    code: "rate_limit",
    text: "レート制限です",
  });
  assert.deepEqual(runErrorFrom("error", "unknown", undefined), { code: "unknown", text: "実行に失敗しました" });
  assert.equal(runErrorFrom("stopped", "rate_limit", "レート制限です"), undefined, "停止を正とする");
  assert.equal(runErrorFrom("error", undefined, "旧 payload の文言"), undefined, "コードが無ければカードを出さない");
});

// --- 押せない理由 ---

test("再実行のガードは送信経路と同じ順で、実際に遮っている理由を返す", () => {
  const open = { sending: false, settingsChanging: false, attachmentsBusy: false, runtimeReady: true };
  assert.equal(runRetryBlockedReason(open), undefined);
  assert.equal(runRetryBlockedReason({ ...open, sending: true }), "送信中");
  assert.equal(runRetryBlockedReason({ ...open, sending: true, settingsChanging: true }), "送信中");
  assert.equal(runRetryBlockedReason({ ...open, settingsChanging: true }), "設定の変更中");
  assert.equal(runRetryBlockedReason({ ...open, attachmentsBusy: true }), "添付のアップロード中");
  assert.equal(runRetryBlockedReason({ ...open, runtimeReady: false }), "ランタイム未接続");
});

test("押せない理由の行は無効な操作の名前を実際のものに揃える", () => {
  assert.equal(blockedButtonsNotice({}), undefined);
  assert.equal(blockedButtonsNotice({ compact: "実行中" }), "今は圧縮できません（実行中）");
  assert.equal(
    blockedButtonsNotice({ retry: "添付のアップロード中" }),
    "今は再実行できません（添付のアップロード中）",
    "再実行だけが無効なときに圧縮を押せないと誤案内しない",
  );
  assert.equal(
    blockedButtonsNotice({ compact: "送信中", retry: "送信中" }),
    "今は圧縮も再実行もできません（送信中）",
    "同じ理由は 1 つに畳む",
  );
  assert.equal(
    blockedButtonsNotice({ compact: "実行中", retry: "添付のアップロード中" }),
    "今は圧縮も再実行もできません（実行中・添付のアップロード中）",
  );
});

// --- 配線 ---

test("配線: 再実行は固定文言を App の handleSend へ渡す (通常の送信経路だけを使う)", () => {
  const source = read("src/App.tsx");
  const handler = source.indexOf("const handleRetry");
  const send = source.indexOf("handleSend(RUN_RETRY_PROMPT, { includeAttachments: false })");

  assert.ok(handler >= 0, "App に再実行の入口を置く");
  assert.ok(send > handler, "再実行は通常の送信経路 (handleSend) を通す");
  assert.equal((source.match(/handleSend\(RUN_RETRY_PROMPT/g) ?? []).length, 1, "固定文言の送信経路を 1 つに保つ");
  assert.ok(source.includes("onRetry={handleRetry}"), "入口を Composer のカードへ配線する");
});

test("配線: 再実行は添付を送らず、編集中のチップも消費しない", () => {
  const source = read("src/App.tsx");
  const hooks = read("src/hooks/useU7Agent.ts");

  assert.ok(
    source.includes("handleSend(RUN_RETRY_PROMPT, { includeAttachments: false })"),
    "再実行は添付なしの送信として渡す",
  );
  assert.match(source, /onSend=\{handleSend\}/, "通常の送信は options を渡さず従来どおり添付を載せる");
  // 添付の選択と消費は純関数へ集約し、再実行では何も載せない (挙動は attachments.test.ts で固定する)
  assert.match(
    hooks,
    /attachmentsForSend\(\s*attachmentsRef\.current,\s*sessionIdRef\.current,\s*includeAttachments,?\s*\)/,
    "includeAttachments を添付の選択へ渡す",
  );
  assert.match(hooks, /onSent: includeAttachments/, "再実行ではチップを消費する onSent を渡さない");
});

test("配線: 文言は runRetry の純関数 module から取り、コンポーネントへ書き戻さない", () => {
  const status = read("src/components/composer/ComposerStatus.tsx");

  for (const text of [RUN_RETRY_PROMPT, RUN_RETRY_NOTE, RUN_RETRY_LABEL_COMPACT]) {
    assert.ok(!status.includes(text), `文言 ${text} を直接書かない`);
  }
  // 固定文言の module から取る (コンポーネントは見た目だけを持つ)
  assert.ok(status.includes("RUN_RETRY_LABEL_COMPACT") && status.includes("RUN_RETRY_NOTE"));
});

test("配線: BFF から prompt を再発行しない (固定文言のユーザーメッセージだけを送る)", () => {
  const source = read("src/App.tsx");

  assert.ok(!source.includes("sendMessage(RUN_RETRY_PROMPT"), "handleSend を経由する");
});
