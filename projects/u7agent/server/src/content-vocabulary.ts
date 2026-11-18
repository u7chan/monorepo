/**
 * コンテンツ生成の語彙 (zod の enum を作るための値)。schema モジュールはここから読む。
 * ここへ値を集めているのは、schema が content-cost / content-trial-artifacts / content-trials を
 * (型だけでなく値として) 参照すると、モジュール初期化の時点で循環の相手を読むことになるため。
 */
import { PROVIDER_FAILURE_CODES } from "./provider-failure";
import { SPEECH_TEXT_MAX_LENGTH } from "./speech";

/** 上流の `unit` 語彙。これ以外の行は捨て、`0` へ丸めない */
export const COST_UNITS = ["image", "megapixel", "token", "character", "byte", "minute", "request"] as const;

/** 入力 / 出力の区別。マスタの `billable` はここへ正規化してから DTO に載せる */
export const COST_SIDES = ["input", "output"] as const;

/** 保存・配信できる形式。拡張子と配信 MIME はこの一覧に固定する */
export const TRIAL_ARTIFACT_FORMATS = ["png", "jpeg", "webp", "mp3", "wav"] as const;

/** 試行の種別。画像 / 音声 / BGM は同じレジストリ・DB・履歴の経路を使う */
export const CONTENT_TRIAL_KINDS = ["image", "speech", "bgm"] as const;

/** 終端状態は不変で、`running` からしか遷移しない */
export const CONTENT_TRIAL_STATES = ["running", "succeeded", "failed", "canceled", "interrupted"] as const;

/** 成果物の状態。`stored` は「保存に成功し、`succeeded` として確定した」ことを表す */
export const CONTENT_TRIAL_ARTIFACT_STATES = ["none", "stored"] as const;

/**
 * 試行の失敗分類。provider の分類に、生成は成功したが成果物を保存できなかった `storage` を足す
 * （保存できていない結果を成功として見せない）。
 */
export const CONTENT_TRIAL_FAILURE_CODES = [...PROVIDER_FAILURE_CODES, "storage"] as const;

/** プロンプトの上限。provider の上限ではなく、履歴に残す本文としての歯止め */
export const CONTENT_TRIAL_PROMPT_MAX_LENGTH = 4_000;

/** 音声の演技指示の上限。本文と同じ上限を課金前に見る */
export const CONTENT_TRIAL_INSTRUCTIONS_MAX_LENGTH = SPEECH_TEXT_MAX_LENGTH;
