/** どの面でも使う値 (実行状態 / thinking level / タイトル / モデル参照 / ask-user)。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";

export const RunStatusSchema = z.enum(["idle", "running", "queued", "compacting", "completed", "stopped", "error"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
/**
 * ランが終端したときの結末。`RunStatusSchema` の部分集合で、ターンの結末の表示 (`Done` /
 * `Stopped` / `Failed`) に使う。終端以外 (`idle` / `running` / `queued` / `compacting`) は載せない
 */
export const RunOutcomeSchema = z.enum(["completed", "stopped", "error"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;
export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
/** 会話タイトルの由来。auto = 依頼本文、ai = AI 要約、manual = 手動改名 */
export const TitleOriginSchema = z.enum(["auto", "ai", "manual"]);
export type TitleOrigin = z.infer<typeof TitleOriginSchema>;
export const TitleAttemptStateSchema = z.enum(["pending", "done", "failed", "skipped"]);
export type TitleAttemptState = z.infer<typeof TitleAttemptStateSchema>;
/** AI 要約を実行しなかった理由。画面の文言は client 側で写す */
export const TitleSkipReasonSchema = z.enum([
  "disabled",
  "model-unset",
  "manual",
  "no-request",
  "cancelled",
  "settings-changed",
  "not-ready",
  "interrupted",
]);
export type TitleSkipReason = z.infer<typeof TitleSkipReasonSchema>;
export const TitleAttemptSchema = z.object({
  runId: z.string().min(1),
  at: z.number().finite(),
  state: TitleAttemptStateSchema,
  /** 自動要約 / 会話メニューからの明示的な再要約 */
  trigger: z.enum(["auto", "manual"]).optional(),
  /** 予約時に確定したモデル (`provider/id`) */
  model: z.string().optional(),
  /** 予約時に確定した実効 Effort */
  thinkingLevel: ThinkingLevelSchema.optional(),
  /** 予約時の設定世代。保存後に設定が変わった結果は適用しない */
  generation: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costTotal: z.number().optional(),
  /** 生成にかかった時間 (順番待ちを含む)。画面の確認用 */
  durationMs: z.number().optional(),
  /** 失敗理由 (マスク済み・長さ上限あり)。依頼本文と生成タイトルは含めない */
  error: z.string().optional(),
  /** 実行しなかった理由 (skipped のとき) */
  skipReason: TitleSkipReasonSchema.optional(),
});
export type TitleAttempt = z.infer<typeof TitleAttemptSchema>;
/** 会話タイトルの由来と最新の AI 要約試行。タイトル本文は `title` が持つ */
export const SessionTitleSummarySchema = z.object({
  origin: TitleOriginSchema,
  attempt: TitleAttemptSchema.optional(),
});
export type SessionTitleSummary = z.infer<typeof SessionTitleSummarySchema>;
/** 設定画面の「動作確認」の結果。タイトルは保存しない */
export const TitleSummaryTestResponseSchema = z.object({
  ok: z.boolean(),
  title: z.string().optional(),
  error: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costTotal: z.number().optional(),
  durationMs: z.number(),
});
export type TitleSummaryTestResponse = z.infer<typeof TitleSummaryTestResponseSchema>;
/** 会話メニューからの再要約の結果。生成に失敗しても現在のタイトルと試行を返す */
export const SessionTitleSummaryResponseSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  titleSummary: SessionTitleSummarySchema,
});
export type SessionTitleSummaryResponse = z.infer<typeof SessionTitleSummaryResponseSchema>;
/** 認証済みモデルの provider/id 参照 (SDK の Model そのものではない) */
export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;
/**
 * スキル許可リスト (`commonSkillNames` / `builtinSkillNames`) の上限。配列全体は body の
 * 64 KiB でも押さえられるが、中身を正規化する防御線としてここにも置く。1 件の長さはワークスペースの
 * 1 セグメント名の上限 (`sandbox/protocol.ts` の `SANDBOX_MAX_ENTRY_NAME_LENGTH`) と揃える
 * (値は import せず複製。揃え方は `FilePreviewSchema` と同じ)。
 */
export const SKILL_NAMES_MAX = 200;
export const SKILL_NAME_MAX = 200;
/**
 * ツール許可リストの上限。スキル名の上限 (`SKILL_NAME_MAX`) はワークスペースの 1 セグメント名を
 * 根拠にしているが、ツール名に同じ根拠は無い (SDK 組込みとアプリの定義が決める) ため別に持つ。
 * どちらも名前の保存を弾くための防御線で、値そのものに意味は無い。
 */
export const TOOL_NAMES_MAX = 200;
export const TOOL_NAME_MAX = 200;
/**
 * ask_user の上限。ツールのパラメータ検証 (`server/src/ask-user-tool.ts` が throw) と
 * DTO / リクエスト本体の検証が同じ値を使う。
 */
export const ASK_USER_QUESTIONS_MIN = 1;
export const ASK_USER_QUESTIONS_MAX = 4;
export const ASK_USER_OPTIONS_MAX = 6;
export const ASK_USER_QUESTION_MAX = 500;
export const ASK_USER_HEADER_MAX = 40;
export const ASK_USER_LABEL_MAX = 80;
export const ASK_USER_DESCRIPTION_MAX = 200;
export const ASK_USER_ANSWER_TEXT_MAX = 2000;
/** ask_user の選択肢。選択は入力補助で、自由記入は常に受け付ける (`docs/ask-user.md`) */
export const AskUserOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export type AskUserOption = z.infer<typeof AskUserOptionSchema>;
export const AskUserQuestionSchema = z.object({
  question: z.string(),
  /** カードの短い見出し */
  header: z.string().optional(),
  /** 承認ツールが示す接続先。カードは host + HTTPS 443 のチップで表示する */
  host: z.string().optional(),
  /** 省略時は options の有無で決める (UI は options の有無だけを見る) */
  type: z.enum(["choice", "text"]).optional(),
  options: z.array(AskUserOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
  placeholder: z.string().optional(),
});
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;
/**
 * 質問への回答。`index` は questions の添字で、質問文の文字列では引かない (同じ質問文が 2 つあると壊れる)。
 * `skipped` は質問ごとの「回答しない」で、`selected` / `text` とは排他 (両方指定は 400)。
 * `approval` は承認を求めるツール (`request_network_access`) の回答だけで受け付け、他の項目とも排他。
 * `false` は「拒否」で、`undefined` (未回答) と区別する。
 */
export const AskUserAnswerSchema = z.object({
  index: z.number().int().min(0),
  selected: z.array(z.string().max(ASK_USER_LABEL_MAX)).max(ASK_USER_OPTIONS_MAX).optional(),
  text: z.string().max(ASK_USER_ANSWER_TEXT_MAX).optional(),
  skipped: z.boolean().optional(),
  approval: z.boolean().optional(),
});
export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>;
/**
 * 設定 → モデルのAPIキー入力の境界。短い値は通常出力のマスカーの下限 (MIN_SECRET_LENGTH) と揃え、
 * 長い値は DB / メモリを守るために上限を置く。
 */
export const PROVIDER_API_KEY_MIN_LENGTH = 8;
export const PROVIDER_API_KEY_MAX_LENGTH = 2048;
