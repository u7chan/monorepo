/**
 * BFF ローカルの `investigate` ツール。読み取り専用の子セッションへ調査を 1 回委譲し、親の context には
 * 報告だけを返す。子の生成・並列・打ち切りは host (SessionStore 側の runner) が持ち、ここは契約と整形を持つ
 * (`docs/subagent.md`)。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SecretMasker } from "./redact";
import type { Usage } from "./schema";
import { wrapToolDefinitionWithSecretMasker } from "./secret-guard";
import { truncate } from "./session-projection";

export const INVESTIGATE_TOOL_NAME = "investigate";

/** モデルが読む報告の上限。親の context を守るため、末尾を落としても先頭の結論は残す */
export const INVESTIGATE_REPORT_MAX = 4_000;

/** 子を打ち切るまでの既定値。設定 UI / env は持たず、getter で毎回解決する */
export const INVESTIGATE_TIMEOUT_MS = 600_000;

export const INVESTIGATE_DESCRIPTION =
  "Delegate one read-only investigation to a disposable child agent and get a short report back. " +
  "Use it to search across many files, read many files, or trace history without spending your own context on it. " +
  "The child cannot change files, cannot ask the user, and cannot delegate another investigation, so it is not for implementation work.";

export const INVESTIGATE_GUIDELINES = [
  "Write a self-contained request: the child sees only this prompt and the working directory, never this conversation. Name what to decide and where to start.",
  "Bundle independent investigations into one call instead of calling the tool once per question.",
  "The report is one short summary that lands in your context, so keep the request narrow: conclusion, evidence, and the referenced file paths.",
  "Do not ask it to change files, start services, ask the user, or implement anything; it cannot do that and the call only returns a partial or failed report.",
  "If the report is inconclusive, narrow the request and call again instead of repeating the same prompt.",
];

export type InvestigateOutcome = "completed" | "timeout" | "aborted" | "error";

/** 子の途中経過。親の live 表示にだけ使い、履歴には残らない */
export interface InvestigateProgress {
  /** 直近の子ツール実行の 1 行要約 */
  activity: string;
  /** 生成中の子の本文末尾 (3 行 / 200 文字まで) */
  text: string;
}

export interface InvestigateRunResult {
  outcome: "completed" | "aborted" | "error";
  /** 成功は子の最後の assistant 本文、打ち切りはその時点までの部分報告 (空もありうる) */
  report: string;
  /** 子のツール実行回数 */
  toolCalls: number;
  usage?: Usage;
  /** 子が compaction した回数。報告が欠けたときの切り分け用 */
  compactions?: number;
}

/** ツール結果の `details`。子の過程は残さず、報告の内訳だけを載せる */
export interface InvestigateToolDetails {
  outcome: InvestigateOutcome;
  toolCalls: number;
  usage?: Usage;
  compactions?: number;
}

export interface InvestigateHost {
  /** 子を 1 回だけ走らせる。`signal` は親 run の stop とツールのタイムアウトの合成 */
  investigate(request: {
    sessionId: string;
    toolCallId: string;
    prompt: string;
    signal: AbortSignal;
    onProgress?: (progress: InvestigateProgress) => void;
  }): Promise<InvestigateRunResult>;
}

const investigateSchema = Type.Object({
  prompt: Type.String({
    description: "Self-contained request for the child investigation. It sees only this text and the working directory",
  }),
});
type InvestigateParams = Static<typeof investigateSchema>;

const STOPPED_MESSAGE = "停止しました";
const TIMED_OUT_MESSAGE = "時間切れで打ち切りました";
const FAILED_MESSAGE = "子エージェントの実行に失敗しました";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 報告の本文を作る。先に全文を mask する: 切り詰めてからでは、境界に掛かった秘密値が
 * 末尾を欠いた断片になり、後段の maskSafe (完全一致と先頭部分一致) でも検出できない。
 */
function formatReport(report: string, masker: SecretMasker): string {
  return truncate(masker.mask(report.trim()), INVESTIGATE_REPORT_MAX);
}

function formatFailure(reason: string, report: string, masker: SecretMasker): string {
  const partial = formatReport(report, masker);
  return partial === "" ? `${reason}。報告はありません` : `${reason}。途中までの報告:\n${partial}`;
}

export function withInvestigateTool(base: readonly string[], enabled: boolean): string[] {
  return enabled ? [...base, INVESTIGATE_TOOL_NAME] : [...base];
}

export function createInvestigateToolDefinitions(options: {
  enabled: boolean;
  sessionId?: string | undefined;
  host: InvestigateHost;
  masker: SecretMasker;
  /** execute のたびに解決する打ち切り時間 (テストの短縮用)。未指定は INVESTIGATE_TIMEOUT_MS */
  timeoutMs?: () => number;
}): ToolDefinition[] {
  const sessionId = options.sessionId;
  if (!options.enabled || !sessionId) return [];
  const timeoutMs = options.timeoutMs ?? (() => INVESTIGATE_TIMEOUT_MS);
  const definition: ToolDefinition<typeof investigateSchema> = {
    name: INVESTIGATE_TOOL_NAME,
    label: INVESTIGATE_TOOL_NAME,
    description: INVESTIGATE_DESCRIPTION,
    promptSnippet: "Delegate a read-only investigation to a child agent and get a short report",
    promptGuidelines: [...INVESTIGATE_GUIDELINES],
    parameters: investigateSchema,
    // codemode のスクリプトから呼ばせない (文脈を分けるのはモデル自身のターンでだけ行う)
    exposure: "model-only",
    async execute(toolCallId, params: InvestigateParams, signal, onUpdate) {
      const prompt = params.prompt.trim();
      if (prompt === "") {
        // 検証の失敗だけは throw する。残すデータが無く、モデルにやり直させる
        throw new Error("investigate の prompt が空です");
      }
      // 打ち切りは親 run の signal と合成し、タイマーは execute の間だけ保持する
      const timeout = new AbortController();
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          timeout.abort();
        },
        Math.max(0, Math.floor(timeoutMs())),
      );
      timer.unref?.();
      const combined = AbortSignal.any(signal ? [signal, timeout.signal] : [timeout.signal]);
      let result: InvestigateRunResult;
      try {
        result = await options.host.investigate({
          sessionId,
          toolCallId,
          prompt,
          signal: combined,
          onProgress: onUpdate
            ? (progress) => {
                const text = [progress.activity, progress.text].filter((line) => line.trim() !== "").join("\n");
                if (text === "") return;
                // 途中結果の details は使わない (SDK の partialResult は live 表示用で、履歴には載らない)
                onUpdate({ content: [{ type: "text", text }], details: undefined });
              }
            : undefined,
        });
      } catch (error) {
        // 子セッションを作れなかった (モデルの許可リスト外など) も throw せず同じ形へ寄せる。
        // throw すると SDK の createErrorToolResult が details を空にする
        return {
          content: [{ type: "text", text: `${FAILED_MESSAGE}。${messageFor(error)}` }],
          details: { outcome: "error" as const, toolCalls: 0 } satisfies InvestigateToolDetails,
          isError: true,
        };
      } finally {
        clearTimeout(timer);
      }
      const outcome: InvestigateOutcome = result.outcome === "aborted" && timedOut ? "timeout" : result.outcome;
      const details: InvestigateToolDetails = {
        outcome,
        toolCalls: result.toolCalls,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.compactions ? { compactions: result.compactions } : {}),
      };
      if (outcome === "completed") {
        return {
          content: [{ type: "text", text: formatReport(result.report, options.masker) }],
          details,
        };
      }
      const reason =
        outcome === "timeout" ? TIMED_OUT_MESSAGE : outcome === "aborted" ? STOPPED_MESSAGE : FAILED_MESSAGE;
      return {
        content: [{ type: "text", text: formatFailure(reason, result.report, options.masker) }],
        details,
        isError: true,
      };
    },
  };
  return [wrapToolDefinitionWithSecretMasker(definition, options.masker)];
}
