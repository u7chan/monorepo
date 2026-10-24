/**
 * 会話タイトルの AI 要約を 1 回だけ実行する補助呼び出し。会話の SDK セッションへメッセージを足さず、
 * 要約モデルへの独立した短いリクエストとして送る (ツール無し・入出力の上限つき)。
 * いつ・何回呼ぶかは会話ストアが決め、ここは 1 回の生成と結果の検証だけを持つ。
 */
import type { Api, AssistantMessage, Context, Model as PiAiModel } from "@earendil-works/pi-ai";
import type { ModelRef } from "./schema";
import type { SecretMasker } from "./redact";
import { buildTitlePrompt, parseGeneratedTitle } from "./session-title";
import type { TitleSummaryRuntimeSettings } from "./title-summary-settings";

export interface TitleSummaryUsage {
  inputTokens: number;
  outputTokens: number;
  costTotal: number;
}

export type TitleSummaryResult =
  | { ok: true; title: string; usage: TitleSummaryUsage | undefined }
  | { ok: false; error: string };

export interface TitleSummaryGenerateInput {
  model: ModelRef;
  definition: string;
  /** タイトルの元にした依頼本文 (定型プロンプトとスキル参照を除いたもの) */
  request: string;
  /** 判定点のランで確定した最終応答 */
  response: string;
  signal: AbortSignal;
}

export type TitleSummaryGenerate = (input: TitleSummaryGenerateInput) => Promise<TitleSummaryResult>;

export interface TitleSummaryHost {
  /** 予約時点の設定 (世代を含む) */
  settings(): TitleSummaryRuntimeSettings;
  generate: TitleSummaryGenerate;
}

/** 生成に渡るモデルの呼び出し。`completeSimple` は認証を ModelRuntime 側で解決する */
export interface TitleSummaryCompletion {
  resolveModel: (model: ModelRef) => PiAiModel<Api> | undefined;
  complete: (model: PiAiModel<Api>, context: Context) => Promise<AssistantMessage>;
}

/**
 * 1 回の生成。モデルが現在の候補に無ければ外部へ送らずに失敗にする (無断のフォールバックをしない)。
 * 出力は 1 行だけを受理し、空・複数行・例外はすべて「タイトルを更新しない」に畳む。
 */
export function createTitleSummaryGenerate(
  completion: TitleSummaryCompletion,
  masker: SecretMasker,
): TitleSummaryGenerate {
  return async (input) => {
    const model = completion.resolveModel(input.model);
    if (!model) return { ok: false, error: "選択したモデルは利用できません" };
    const prompt = buildTitlePrompt(input);
    try {
      const message = await completion.complete(model, {
        systemPrompt: prompt.system,
        messages: [{ role: "user", content: [{ type: "text", text: prompt.user }], timestamp: Date.now() }],
      });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return { ok: false, error: message.errorMessage ?? "要約モデルの呼び出しに失敗しました" };
      }
      const raw = textOf(message);
      // モデルが秘密値をそのまま返しても、既知の値はタイトルにも usage 記録にも残さない
      const title = parseGeneratedTitle(masker.mask(raw));
      if (!title) return { ok: false, error: "要約モデルの出力をタイトルとして使えません" };
      return { ok: true, title, usage: usageOf(message) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
