/**
 * BFF ローカルの `request_network_access` ツール。bash の外向き TCP 443 がポリシーで塞がれているとき、
 * モデルがユーザーへ承認を求める。質問文と選択肢は BFF が固定し、モデルには説明文 (`reason`) だけを書かせる。
 *
 * 承認の記録は SessionStore が回答の受理時に行う。ここは「聞いて、回答をそのまま details へ写す」だけで、
 * ツールの戻り値から承認を確定しない (`docs/sandbox.md`)。
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_MAX, type AskUserAnswer, type AskUserQuestion } from "./schema";
import type { AskUserToolDetails } from "./ask-user-tool";
import type { NetworkAccessMode } from "./network-access";

export const REQUEST_NETWORK_ACCESS_TOOL_NAME = "request_network_access";

export const REQUEST_NETWORK_ACCESS_DESCRIPTION =
  "Ask the user to allow outbound HTTPS (port 443) from bash for this conversation. " +
  "The user answers in a card, so the run stays running until they allow or deny it.";

export const REQUEST_NETWORK_ACCESS_GUIDELINES = [
  "Call this only after an outbound HTTPS connection from bash failed with a permission error (EACCES) or a connection error you believe is the egress policy.",
  "Explain in `reason` what you need to reach and why, in one or two sentences. The question and the choices are fixed by the app.",
  "After the user allows it, retry the same command. If they deny it, continue without network access and ask again only when the user asks you to retry.",
];

/** カードの見出し。質問文と選択肢はここで固定する (モデルに書かせない) */
export const NETWORK_ACCESS_QUESTION_HEADER = "通信の許可";
export const NETWORK_ACCESS_QUESTION = "この通信を許可しますか？";
export const NETWORK_ACCESS_APPROVE_LABEL = "許可";
export const NETWORK_ACCESS_DENY_LABEL = "拒否";

/**
 * `reason` から固定 1 問を組み立てる。ライブ (`run-events`)、payload、履歴 (`session-projection`) の
 * 3 経路が同じ関数を通る (片方だけ別の組み立てをしない)。
 */
export function networkAccessQuestions(reason: string): AskUserQuestion[] {
  const detail = reason.trim().slice(0, ASK_USER_QUESTION_MAX);
  return [
    {
      header: NETWORK_ACCESS_QUESTION_HEADER,
      question: detail === "" ? NETWORK_ACCESS_QUESTION : `${NETWORK_ACCESS_QUESTION}\n\n${detail}`,
      type: "choice",
      options: [{ label: NETWORK_ACCESS_APPROVE_LABEL }, { label: NETWORK_ACCESS_DENY_LABEL }],
    },
  ];
}

/**
 * モデルの引数 (または保存された args) から質問を導出する。`reason` が文字列でない形は壊れた引数として
 * undefined を返し、DTO には載せない。`reason` の省略は空文字として扱う (説明の無い承認要求を許す)。
 */
export function deriveNetworkAccessQuestions(raw: unknown): AskUserQuestion[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const reason = (raw as { reason?: unknown }).reason;
  if (reason !== undefined && typeof reason !== "string") return undefined;
  return networkAccessQuestions(typeof reason === "string" ? reason : "");
}

export interface NetworkAccessHost {
  /** このセッションが 443 を開いてよいか。exec のたびに解決する */
  allows(sessionId: string): boolean;
  /** 現在のモード。`allow` は質問せずに許可、`deny` は承認しても開かない */
  mode(): NetworkAccessMode;
  /** 承認の質問を 1 問だけ出し、回答まで待つ。待機の所有は SessionStore 側 */
  ask(
    sessionId: string,
    toolCallId: string,
    questions: AskUserQuestion[],
    signal: AbortSignal | undefined,
  ): Promise<AskUserAnswer[]>;
}

/** セッションの登録名へ足す。公開の判定は `sessionToolPlan` の `enabled` と同じにする */
export function withRequestNetworkAccessTool(base: readonly string[], enabled: boolean): string[] {
  return enabled ? [...base, REQUEST_NETWORK_ACCESS_TOOL_NAME] : [...base];
}

const requestNetworkAccessSchema = Type.Object({
  reason: Type.String({
    description:
      "Why you need outbound HTTPS, in one or two sentences (what you fetch and what for). Shown under the fixed question.",
  }),
});
type RequestNetworkAccessParams = Static<typeof requestNetworkAccessSchema>;

/** 承認の結果をモデルへ返す 1 文。選択肢のラベル文字列は解釈せず、`approval` の真偽だけを読む */
function resultText(approved: boolean): string {
  return approved
    ? "ユーザーが許可しました。同じ操作をもう一度実行してください。"
    : "ユーザーが拒否しました。外向き通信なしで続けてください。ユーザーが再実行を求めたら、もう一度承認を求めてください。";
}

export function createRequestNetworkAccessToolDefinitions(options: {
  enabled: boolean;
  /**
   * 承認の key になる SDK のセッション id。定義の生成時点では決まらない (永続化なしの会話は SDK が
   * 発行する) ため、実行のたびに解決する。
   */
  sessionId: () => string | undefined;
  host: NetworkAccessHost;
}): ToolDefinition[] {
  if (!options.enabled) return [];
  const definition: ToolDefinition<typeof requestNetworkAccessSchema> = {
    name: REQUEST_NETWORK_ACCESS_TOOL_NAME,
    label: REQUEST_NETWORK_ACCESS_TOOL_NAME,
    description: REQUEST_NETWORK_ACCESS_DESCRIPTION,
    promptSnippet: "Ask the user to allow outbound HTTPS from bash",
    promptGuidelines: [...REQUEST_NETWORK_ACCESS_GUIDELINES],
    parameters: requestNetworkAccessSchema,
    // codemode のスクリプトからは呼ばせない (ユーザーへの承認要求はモデル自身のターンでだけ行う)
    exposure: "model-only",
    async execute(toolCallId, params: RequestNetworkAccessParams, signal) {
      const questions = networkAccessQuestions(params.reason ?? "");
      const mode = options.host.mode();
      // 承認が要らない / 承認しても開かないモードではカードを出さない (押しても何も変わらない質問をしない)
      if (mode === "allow") {
        return {
          content: [{ type: "text", text: "この環境では外向き通信は常に許可されています。承認は不要です。" }],
          details: { questions, answers: [] } satisfies AskUserToolDetails,
        };
      }
      if (mode === "deny") {
        return {
          content: [{ type: "text", text: "この環境では外向き通信は拒否されています。承認しても開きません。" }],
          details: { questions, answers: [] } satisfies AskUserToolDetails,
          isError: true,
        };
      }
      const sessionId = options.sessionId();
      if (sessionId === undefined) {
        // id を解決できないと承認を記録できない。開かないまま止める (fail-closed)
        return {
          content: [{ type: "text", text: "会話を特定できないため、この通信は許可できません。" }],
          details: { questions, answers: [] } satisfies AskUserToolDetails,
          isError: true,
        };
      }
      let answers: AskUserAnswer[];
      try {
        answers = await options.host.ask(sessionId, toolCallId, questions, signal);
      } catch {
        // abort / 取り消しでは throw しない。details を残し、停止後の再読込でもカードを復元できるようにする
        return {
          content: [{ type: "text", text: "回答が得られないまま停止しました" }],
          details: { questions, answers: [] } satisfies AskUserToolDetails,
          isError: true,
        };
      }
      // 承認の記録は SessionStore が済ませている。ここは回答の写しだけを持つ
      return {
        content: [{ type: "text", text: resultText(answers[0]?.approval === true) }],
        details: { questions, answers } satisfies AskUserToolDetails,
      };
    },
  };
  return [definition];
}
