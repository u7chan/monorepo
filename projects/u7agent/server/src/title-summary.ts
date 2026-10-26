/**
 * 会話タイトルの AI 要約を 1 回だけ実行する補助呼び出し。会話の SDK セッションへメッセージを足さず、
 * 要約モデルへの独立した短いリクエストとして送る (ツール無し・入出力の上限つき)。
 * いつ・何回呼ぶかは会話ストアが決め、ここは 1 回の生成と結果の検証だけを持つ。
 */
import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Context, Model as PiAiModel } from "@earendil-works/pi-ai";
import type { ModelRef, ThinkingLevel, TitleSummaryTestResponse } from "./schema";
import type { SecretMasker } from "./redact";
import { truncate } from "./session-projection";
import {
  TITLE_ATTEMPT_ERROR_MAX,
  TITLE_MAX_OUTPUT_TOKENS,
  buildTitlePrompt,
  parseGeneratedTitle,
} from "./session-title";
import type { TitleSummaryRuntimeSettings } from "./title-summary-settings";

export interface TitleSummaryUsage {
  inputTokens: number;
  outputTokens: number;
  costTotal: number;
}

/**
 * 補助呼び出しの結果。usage はタイトルを採用できたかと独立に返す
 * (失敗した要求も課金され得るため、状態 `failed` でも診断へ残す)。
 */
export type TitleSummaryResult =
  | { ok: true; title: string; usage: TitleSummaryUsage | undefined }
  | { ok: false; error: string; usage: TitleSummaryUsage | undefined };

export interface TitleSummaryGenerateInput {
  model: ModelRef;
  definition: string;
  /** タイトルの元にした依頼本文 (定型プロンプトとスキル参照を除いたもの) */
  request: string;
  /** 判定点のランで確定した最終応答 */
  response: string;
  /**
   * 会話の SDK セッション ID。opencode-go のように x-opencode-session を要求する
   * プロバイダーは、この値が無いと要約リクエストをルーティングできない。
   */
  sessionId: string;
  /** 実効 Effort。モデルが推論に対応しない場合は off */
  thinkingLevel?: ThinkingLevel;
  /** 取消 (Off への変更・停止)。実際の HTTP 呼び出しまで伝播させる */
  signal: AbortSignal;
}

export type TitleSummaryGenerate = (input: TitleSummaryGenerateInput) => Promise<TitleSummaryResult>;

export interface TitleSummaryHost {
  /** 予約時点の設定 (世代を含む) */
  settings(): TitleSummaryRuntimeSettings;
  generate: TitleSummaryGenerate;
}

/** pi-ai の reasoning は off を取らない (未指定 = off)。保存値の off は省略へ写す */
export type TitleSummaryReasoningLevel = Exclude<ThinkingLevel, "off">;

export interface TitleSummaryCompletionOptions {
  signal: AbortSignal;
  sessionId: string;
  maxTokens: number;
  reasoning?: TitleSummaryReasoningLevel;
}

/** 生成に渡るモデルの呼び出し。`completeSimple` は認証を ModelRuntime 側で解決する */
export interface TitleSummaryCompletion {
  resolveModel: (model: ModelRef) => PiAiModel<Api> | undefined;
  complete: (
    model: PiAiModel<Api>,
    context: Context,
    options: TitleSummaryCompletionOptions,
  ) => Promise<AssistantMessage>;
}

/**
 * 1 回の生成。モデルが現在の候補に無ければ外部へ送らずに失敗にする (無断のフォールバックをしない)。
 * 出力は 1 行だけを受理し、空・複数行・出力上限での打ち切り・例外は「タイトルを更新しない」に畳む。
 */
export function createTitleSummaryGenerate(
  completion: TitleSummaryCompletion,
  masker: SecretMasker,
): TitleSummaryGenerate {
  return async (input) => {
    const model = completion.resolveModel(input.model);
    if (!model) return errorResult("選択したモデルは利用できません");
    // 編集可能な定義・応答・再登録された秘密値を含む実送信入力の全体を、外部へ出す直前にマスクする
    const prompt = buildTitlePrompt(input);
    const systemPrompt = masker.mask(prompt.system);
    const userText = masker.mask(prompt.user);
    try {
      const message = await completion.complete(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
        },
        {
          signal: input.signal,
          sessionId: input.sessionId,
          maxTokens: model.maxTokens > 0 ? Math.min(TITLE_MAX_OUTPUT_TOKENS, model.maxTokens) : TITLE_MAX_OUTPUT_TOKENS,
          ...(input.thinkingLevel && input.thinkingLevel !== "off" ? { reasoning: input.thinkingLevel } : {}),
        },
      );
      const usage = usageOf(message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return errorResult(message.errorMessage ?? "要約モデルの呼び出しに失敗しました", usage);
      }
      // 出力トークンの上限で切れた応答は、1 行に見えても予算超過として採用しない
      if (message.stopReason === "length") {
        return errorResult("要約モデルの出力が上限に達しました", usage);
      }
      const raw = textOf(message);
      // モデルが秘密値をそのまま返しても、既知の値はタイトルにも usage 記録にも残さない
      const title = parseGeneratedTitle(masker.mask(raw));
      if (!title) return errorResult("要約モデルの出力をタイトルとして使えません", usage);
      return { ok: true, title, usage };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }

    /** 失敗理由は外部由来の文字列を含むため、保存・表示の前にマスクして長さを抑える */
    function errorResult(
      message: string,
      usage?: TitleSummaryUsage,
    ): {
      ok: false;
      error: string;
      usage: TitleSummaryUsage | undefined;
    } {
      return { ok: false, error: truncate(masker.mask(message), TITLE_ATTEMPT_ERROR_MAX), usage };
    }
  };
}

/** 設定画面の動作確認に使う固定の依頼 / 応答。利用者の会話は送らない */
const TITLE_SUMMARY_TEST_REQUEST = "ログイン画面のエラー表示が分かりにくいので改善したい";
const TITLE_SUMMARY_TEST_RESPONSE =
  "ログイン画面のエラー表示を整理し、入力漏れと認証失敗で文言を分けます。あわせて支援技術へエラーを通知するようにします。";

export type TitleSummaryTest = () => Promise<TitleSummaryTestResponse>;

/**
 * 設定画面の「動作確認」。保存済みのモデル / Effort / 定義で 1 回だけ生成し、結果を返す。
 * 会話にもタイトルにも保存せず、入力は固定のサンプルだけを使う。Off / モデル未選択は生成しない。
 */
export function createTitleSummaryTest(
  settings: () => TitleSummaryRuntimeSettings,
  generate: TitleSummaryGenerate,
): TitleSummaryTest {
  return async () => {
    const runtime = settings();
    const startedAt = Date.now();
    const model = runtime.model;
    const base = {
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      ...(runtime.thinkingLevel ? { thinkingLevel: runtime.thinkingLevel } : {}),
    };
    if (!runtime.enabled) {
      return { ok: false, error: "AI要約は Off です", ...base, durationMs: Date.now() - startedAt };
    }
    if (!model) {
      return { ok: false, error: "要約モデルが選択されていません", ...base, durationMs: Date.now() - startedAt };
    }
    const result = await generate({
      model,
      definition: runtime.definition,
      request: TITLE_SUMMARY_TEST_REQUEST,
      response: TITLE_SUMMARY_TEST_RESPONSE,
      sessionId: `title-test-${randomUUID()}`,
      thinkingLevel: runtime.thinkingLevel,
      signal: AbortSignal.timeout(60_000),
    });
    const usage = result.usage;
    return {
      ok: result.ok,
      ...(result.ok ? { title: result.title } : { error: result.error }),
      ...base,
      ...(usage
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costTotal: usage.costTotal }
        : {}),
      durationMs: Date.now() - startedAt,
    };
  };
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function usageOf(message: AssistantMessage): TitleSummaryUsage | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    costTotal: usage.cost?.total ?? 0,
  };
}
