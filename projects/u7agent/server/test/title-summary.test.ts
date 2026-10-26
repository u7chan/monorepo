// 会話タイトルの AI 要約 1 回分の生成 (マスク・中止の伝播・出力検証・usage) を検証する。
//   - 送信直前に、編集可能な定義を含む入力全体の既知の秘密値をマスクする
//   - 取消の AbortSignal をモデル呼び出しまで渡す
//   - 出力が不正 / 上限で打ち切られたら採用しないが、取得できた usage は返す

import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createSecretMasker } from "../src/redact";
import { createTitleSummaryGenerate, type TitleSummaryCompletion } from "../src/title-summary";
import { TITLE_OUTPUT_MAX_CHARS } from "../src/session-title";
import { STUB_MODEL, STUB_USAGE } from "./stub-pi";

const KEY = "sk-ant-dummy-key-0123456789abcdef";

const input = {
  model: { provider: STUB_MODEL.provider, id: STUB_MODEL.id },
  definition: "日本語20文字程度で。",
  request: "ログイン画面のエラー表示を改善したい",
  response: "エラー表示を整理します。",
  sessionId: "pi-session-test",
  thinkingLevel: "low" as const,
  signal: new AbortController().signal,
};

function completionWith(
  message: Partial<AssistantMessage>,
  recorded: {
    systemPrompt?: string;
    userText?: string;
    signal?: AbortSignal;
    sessionId?: string;
    maxTokens?: number;
    reasoning?: string;
  }[] = [],
): TitleSummaryCompletion {
  return {
    resolveModel: (model) => (model.id === STUB_MODEL.id ? STUB_MODEL : undefined),
    complete: async (_model, context, options) => {
      const user = context.messages[0];
      recorded.push({
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        userText: userTextOf(user),
        signal: options.signal,
        sessionId: options.sessionId,
        maxTokens: options.maxTokens,
        reasoning: options.reasoning,
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "タイトル" }],
        stopReason: "stop",
        usage: STUB_USAGE,
        ...message,
      } as AssistantMessage;
    },
  };
}

test("入力全体（編集可能な定義を含む）の既知の秘密値を送信直前にマスクする", async () => {
  const recorded: { systemPrompt?: string; userText?: string; signal?: AbortSignal }[] = [];
  const generate = createTitleSummaryGenerate(completionWith({}, recorded), createSecretMasker([KEY]));
  const result = await generate({
    ...input,
    definition: `定義に鍵 ${KEY} を書いた`,
    request: `鍵 ${KEY} の設定を見直したい`,
  });
  assert.equal(result.ok, true);
  const sent = `${recorded[0]?.systemPrompt}\n${recorded[0]?.userText}`;
  assert.ok(!sent.includes(KEY), sent);
  assert.match(sent, /\[REDACTED\]/);
});

test("sessionId・推論込みの出力予算・Effort をモデル呼び出しへ渡す", async () => {
  const recorded: { sessionId?: string; maxTokens?: number; reasoning?: string }[] = [];
  const generate = createTitleSummaryGenerate(completionWith({}, recorded as never), createSecretMasker([]));
  await generate({ ...input, thinkingLevel: "high" });
  assert.equal(recorded[0]?.sessionId, "pi-session-test");
  assert.equal(recorded[0]?.maxTokens, 1024);
  assert.equal(recorded[0]?.reasoning, "high");

  // off は pi-ai の reasoning では未指定として渡す (プロバイダーの既定推論を有効にしない)
  await generate({ ...input, thinkingLevel: "off" });
  assert.equal(recorded[1]?.reasoning, undefined);
});

test("取消の signal をモデル呼び出しまで渡す", async () => {
  const recorded: { signal?: AbortSignal }[] = [];
  const generate = createTitleSummaryGenerate(completionWith({}, recorded as never), createSecretMasker([]));
  const controller = new AbortController();
  await generate({ ...input, signal: controller.signal });
  assert.equal(recorded[0]?.signal, controller.signal);
});

test("長すぎる 1 行はタイトルとして採用しない", async () => {
  const generate = createTitleSummaryGenerate(
    completionWith({ content: [{ type: "text", text: "あ".repeat(TITLE_OUTPUT_MAX_CHARS + 1) }] }),
    createSecretMasker([]),
  );
  const result = await generate(input);
  assert.equal(result.ok, false);
  assert.equal(result.usage?.inputTokens, STUB_USAGE.input);
});

test("複数行の不正な出力は採用しないが、usage は失敗として返す", async () => {
  const generate = createTitleSummaryGenerate(
    completionWith({ content: [{ type: "text", text: "タイトル\n説明文" }] }),
    createSecretMasker([]),
  );
  const result = await generate(input);
  assert.equal(result.ok, false);
  assert.equal(result.usage?.inputTokens, STUB_USAGE.input);
  assert.equal(result.usage?.costTotal, STUB_USAGE.cost.total);
});

test("出力トークン上限で打ち切られた応答は予算超過として採用しない", async () => {
  const generate = createTitleSummaryGenerate(
    completionWith({ stopReason: "length", content: [{ type: "text", text: "打ち切られたタイトル" }] }),
    createSecretMasker([]),
  );
  const result = await generate(input);
  assert.equal(result.ok, false);
  assert.equal(result.usage?.outputTokens, STUB_USAGE.output);
});

test("モデル呼び出しの失敗も usage を残して失敗にする", async () => {
  const generate = createTitleSummaryGenerate(
    completionWith({ stopReason: "error", errorMessage: "rate limited" }),
    createSecretMasker([]),
  );
  const result = await generate(input);
  assert.equal(result.ok, false);
  assert.equal(result.usage?.inputTokens, STUB_USAGE.input);
});

test("選択モデルが候補に無ければ外部へ送らない", async () => {
  const recorded: unknown[] = [];
  const generate = createTitleSummaryGenerate(completionWith({}, recorded as never), createSecretMasker([]));
  const result = await generate({ ...input, model: { provider: "ghost", id: "missing" } });
  assert.equal(result.ok, false);
  assert.equal(recorded.length, 0);
});

test("1 行の出力はタイトルとして受理する", async () => {
  const generate = createTitleSummaryGenerate(
    completionWith({ content: [{ type: "text", text: "「ログイン画面のエラー表示改善」" }] }),
    createSecretMasker([]),
  );
  const result = await generate(input);
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.title : "", "ログイン画面のエラー表示改善");
});

/** 送った user メッセージの本文。配列の先頭は必ず text パート (画像は渡さない) */
function userTextOf(message: { content: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}
