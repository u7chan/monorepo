/**
 * BFF ローカルの `ask_user` ツール。モデルが選択肢つきの質問を投げ、`execute()` は回答が届くまで待つ。
 * pause / resume の状態は持たず、待機の実体は SessionStore が持つ (`docs/ask-user.md`)。
 * 所有者はモデルに申告させず、定義の生成時に束縛した会話 id へ紐づける。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_DESCRIPTION_MAX,
  ASK_USER_HEADER_MAX,
  ASK_USER_LABEL_MAX,
  ASK_USER_OPTIONS_MAX,
  ASK_USER_QUESTIONS_MAX,
  ASK_USER_QUESTIONS_MIN,
  ASK_USER_QUESTION_MAX,
  type AskUserAnswer,
  type AskUserOption,
  type AskUserQuestion,
} from "./schema";

export const ASK_USER_TOOL_NAME = "ask_user";

export const ASK_USER_DESCRIPTION =
  "Ask the user the questions you need and wait for the answers before continuing. " +
  "The user answers in a card in the chat, so the run stays running until every question is answered, " +
  "skipped, or the user stops the run.";

export const ASK_USER_GUIDELINES = [
  "Ask everything you need in one call (at most 4 questions) instead of asking one question at a time.",
  "Offer 2–6 options when the likely answers are known (with a short description where it helps). The options are only a convenience: the user can always type a free-form answer, and can choose to skip a question.",
  "After the answers arrive, continue the work without asking the same thing again.",
  "If a run ended without answers (the user stopped it or the server restarted) and the user asks you to ask again, re-issue the same questions.",
];

/** ツール結果の `details`。ライブの `tool_end` と履歴の復元が同じ形を読む */
export interface AskUserToolDetails {
  questions: AskUserQuestion[];
  answers: AskUserAnswer[];
}

export interface AskUserHost {
  /** 回答・取り消しのいずれかまで待つ。abort と stop の取り消しでは reject する */
  ask(
    sessionId: string,
    toolCallId: string,
    questions: AskUserQuestion[],
    signal: AbortSignal | undefined,
  ): Promise<AskUserAnswer[]>;
}

const askUserOptionSchema = Type.Object({
  label: Type.String({ description: `Option label shown on a button (at most ${ASK_USER_LABEL_MAX} characters)` }),
  description: Type.Optional(
    Type.String({ description: `Optional one-line explanation of the option (at most ${ASK_USER_DESCRIPTION_MAX})` }),
  ),
});

const askUserSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({
        description: `The question to ask the user (at most ${ASK_USER_QUESTION_MAX} characters)`,
      }),
      header: Type.Optional(
        Type.String({
          description: `Short heading for the question card (about 16 characters, at most ${ASK_USER_HEADER_MAX})`,
        }),
      ),
      type: Type.Optional(
        Type.Union([Type.Literal("choice"), Type.Literal("text")], {
          description: "choice: offer options. text: free-form only. Defaults from whether options are present",
        }),
      ),
      options: Type.Optional(
        Type.Array(askUserOptionSchema, {
          description: `Selectable options (at most ${ASK_USER_OPTIONS_MAX}). Omit for a free-form question`,
        }),
      ),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option (default false)" })),
      placeholder: Type.Optional(Type.String({ description: "Placeholder for the free-form input" })),
    }),
    {
      minItems: ASK_USER_QUESTIONS_MIN,
      maxItems: ASK_USER_QUESTIONS_MAX,
      description: `The questions to ask in this call (${ASK_USER_QUESTIONS_MIN}–${ASK_USER_QUESTIONS_MAX})`,
    },
  ),
});
type AskUserParams = Static<typeof askUserSchema>;

/**
 * モデルの引数 (または保存された args) から質問を導出する。形が壊れていれば undefined を返し、
 * DTO には載せない (上限の検証は validateAskUserQuestions が持ち、導出側は違反も undefined にする)。
 */
export function parseAskUserQuestions(raw: unknown): AskUserQuestion[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const list = (raw as { questions?: unknown }).questions;
  if (!Array.isArray(list)) return undefined;
  const questions: AskUserQuestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.question !== "string" || record.question.trim() === "") return undefined;
    if (record.type !== undefined && record.type !== "choice" && record.type !== "text") return undefined;
    const parsed: AskUserQuestion = { question: record.question.trim() };
    if (typeof record.header === "string" && record.header.trim() !== "") parsed.header = record.header.trim();
    if (record.type === "choice" || record.type === "text") parsed.type = record.type;
    if (record.multiSelect === true) parsed.multiSelect = true;
    if (typeof record.placeholder === "string" && record.placeholder.trim() !== "") {
      parsed.placeholder = record.placeholder.trim();
    }
    if (record.options !== undefined) {
      if (!Array.isArray(record.options)) return undefined;
      const options: AskUserOption[] = [];
      for (const item of record.options) {
        if (!item || typeof item !== "object") return undefined;
        const option = item as Record<string, unknown>;
        if (typeof option.label !== "string" || option.label.trim() === "") return undefined;
        const description =
          typeof option.description === "string" && option.description.trim() !== ""
            ? option.description.trim()
            : undefined;
        options.push({ label: option.label.trim(), ...(description ? { description } : {}) });
      }
      if (options.length > 0) parsed.options = options;
    }
    questions.push(parsed);
  }
  return questions;
}

/** 引数の導出と検証をまとめる。導出できない / 上限違反は undefined (カードを出さない) */
export function deriveAskUserQuestions(raw: unknown): AskUserQuestion[] | undefined {
  const questions = parseAskUserQuestions(raw);
  if (!questions || validateAskUserQuestions(questions)) return undefined;
  return questions;
}

/**
 * ツール結果の `details.answers` から回答を導出する。停止・中止では空配列を返すので、
 * 呼び出し側は「回答なしで終了」として復元できる。形が崩れていれば undefined (= 未回答と同じ扱い)。
 */
export function parseAskUserAnswers(details: unknown): AskUserAnswer[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const list = (details as { answers?: unknown }).answers;
  if (!Array.isArray(list)) return undefined;
  const answers: AskUserAnswer[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.index !== "number" || !Number.isInteger(record.index) || record.index < 0) return undefined;
    const answer: AskUserAnswer = { index: record.index };
    if (Array.isArray(record.selected)) {
      const selected = record.selected.filter((value): value is string => typeof value === "string" && value !== "");
      if (selected.length > 0) answer.selected = selected;
    }
    const text = typeof record.text === "string" ? record.text : "";
    if (text.trim() !== "") answer.text = text;
    if (record.skipped === true) answer.skipped = true;
    answers.push(answer);
  }
  answers.sort((a, b) => a.index - b.index);
  return answers;
}

/** 質問の上限検証。違反は人間が読める 1 文で返し、ツールはこれを throw する */
export function validateAskUserQuestions(questions: readonly AskUserQuestion[]): string | undefined {
  if (questions.length < ASK_USER_QUESTIONS_MIN || questions.length > ASK_USER_QUESTIONS_MAX) {
    return `questions must contain ${ASK_USER_QUESTIONS_MIN} to ${ASK_USER_QUESTIONS_MAX} items`;
  }
  for (const [index, question] of questions.entries()) {
    const at = `questions[${index}]`;
    if (question.question.trim() === "") return `${at}.question must not be empty`;
    if (question.question.length > ASK_USER_QUESTION_MAX) {
      return `${at}.question must be at most ${ASK_USER_QUESTION_MAX} characters`;
    }
    if (question.header !== undefined && question.header.length > ASK_USER_HEADER_MAX) {
      return `${at}.header must be at most ${ASK_USER_HEADER_MAX} characters`;
    }
    if (question.options !== undefined && question.options.length > ASK_USER_OPTIONS_MAX) {
      return `${at}.options must contain at most ${ASK_USER_OPTIONS_MAX} items`;
    }
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      if (option.label.trim() === "") return `${at}.options[${optionIndex}].label must not be empty`;
      if (option.label.length > ASK_USER_LABEL_MAX) {
        return `${at}.options[${optionIndex}].label must be at most ${ASK_USER_LABEL_MAX} characters`;
      }
      if (option.description !== undefined && option.description.length > ASK_USER_DESCRIPTION_MAX) {
        return `${at}.options[${optionIndex}].description must be at most ${ASK_USER_DESCRIPTION_MAX} characters`;
      }
    }
  }
  return undefined;
}

/**
 * 回答の検証。全質問に 1 つずつ答え、各回答は `selected` / `text` / `skipped` のどれかを持つ。
 * `skipped` と `selected` / `text` の同時指定は 400 にする (選択と自由記入の同時指定は正しい形)。
 */
export function validateAskUserAnswers(
  questions: readonly AskUserQuestion[],
  answers: readonly AskUserAnswer[],
): string | undefined {
  if (answers.length !== questions.length) return "answers must cover every question";
  const seen = new Set<number>();
  for (const answer of answers) {
    if (answer.index < 0 || answer.index >= questions.length) return `answers[].index ${answer.index} is out of range`;
    if (seen.has(answer.index)) return `answers[].index ${answer.index} is duplicated`;
    seen.add(answer.index);
    const selected = (answer.selected ?? []).filter((value) => value.trim() !== "");
    const text = (answer.text ?? "").trim();
    if (answer.skipped === true) {
      if (selected.length > 0 || text !== "") return "skipped cannot be combined with selected or text";
      continue;
    }
    if (selected.length === 0 && text === "") return `answers[${answer.index}] needs selected or text (or skipped)`;
  }
  return undefined;
}

/** モデルへ返す回答の要約。質問の並び順で出し、停止時に使わない (停止は呼び出し側が固定文言を返す) */
export function formatAskUserAnswers(questions: readonly AskUserQuestion[], answers: readonly AskUserAnswer[]): string {
  const byIndex = new Map(answers.map((answer) => [answer.index, answer]));
  const lines = ["ユーザーの回答:"];
  for (const [index, question] of questions.entries()) {
    lines.push(`${index + 1}. ${question.question}`);
    const answer = byIndex.get(index);
    if (!answer || answer.skipped === true) {
      lines.push("   - 回答なし（ユーザーは「回答しない」を選択）");
      continue;
    }
    if (answer.selected && answer.selected.length > 0) lines.push(`   - 選択: ${answer.selected.join(", ")}`);
    if (answer.text) lines.push(`   - 自由記入: ${answer.text}`);
  }
  lines.push("回答が得られました。同じ内容を質問し直さず、作業を続けてください。");
  return lines.join("\n");
}

export function withAskUserTool(base: readonly string[], enabled: boolean): string[] {
  return enabled ? [...base, ASK_USER_TOOL_NAME] : [...base];
}

export function createAskUserToolDefinitions(options: {
  enabled: boolean;
  sessionId?: string | undefined;
  host: AskUserHost;
}): ToolDefinition[] {
  const sessionId = options.sessionId;
  if (!options.enabled || !sessionId) return [];
  const definition: ToolDefinition<typeof askUserSchema> = {
    name: ASK_USER_TOOL_NAME,
    label: ASK_USER_TOOL_NAME,
    description: ASK_USER_DESCRIPTION,
    promptSnippet: "Ask the user questions with selectable options and wait for the answers",
    promptGuidelines: [...ASK_USER_GUIDELINES],
    parameters: askUserSchema,
    // codemode のスクリプトから呼ばせない (ユーザーへの質問はモデル自身のターンでだけ行う)。
    // 入れ子の配列 / オブジェクトを含むため、provider の strict JSON schema は要求しない
    exposure: "model-only",
    async execute(toolCallId, params: AskUserParams, signal) {
      const questions = parseAskUserQuestions(params);
      const invalid = questions ? validateAskUserQuestions(questions) : "questions are invalid";
      if (!questions || invalid) {
        // 検証の失敗だけは throw する。残すデータが無く、モデルにやり直させる
        throw new Error(`ask_user のパラメータが不正です: ${invalid}`);
      }
      let answers: AskUserAnswer[];
      try {
        answers = await options.host.ask(sessionId, toolCallId, questions, signal);
      } catch {
        // abort / 取り消しでは throw しない。details を残し、停止後の再読込でもカードを復元できるようにする
        // (throw すると SDK の createErrorToolResult が details を空にする)
        return {
          content: [{ type: "text", text: "回答が得られないまま停止しました" }],
          details: { questions, answers: [] } satisfies AskUserToolDetails,
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: formatAskUserAnswers(questions, answers) }],
        details: { questions, answers } satisfies AskUserToolDetails,
      };
    },
  };
  return [definition];
}
