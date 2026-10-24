/**
 * 設定 → 会話タイトル (AI 要約) のサービス。アプリ DB の 1 行を正として On/Off・要約モデル・定義を持ち、
 * 予約時の値と世代を会話ストアへ渡す。保存は自分のロックで直列化し、起動時の適用も同じロックを通す
 * (web-search-settings.ts と同じ契約)。方針は docs/session-title.md を正とする。
 */
import type { TitleSummarySettingsRow } from "./app-db";
import { httpError, messageFor } from "./http";
import { MutationLock } from "./model-settings";
import type { ModelOption } from "./schema";
import { TITLE_DEFINITION_DEFAULT, TITLE_DEFINITION_MAX, type TitleSummaryModelChoice } from "./session-title";
import type { UpdateTitleSummaryBody, TitleSummarySettingsResponse } from "./schema";

export const TITLE_SUMMARY_SETTINGS_NOT_STORED_MESSAGE =
  "会話タイトルの設定をアプリデータ（SQLite）へ保存できませんでした";
export const TITLE_SUMMARY_MODEL_REQUIRED_MESSAGE = "AI要約を有効にするには要約モデルを選択してください";
export const TITLE_SUMMARY_MODEL_UNAVAILABLE_MESSAGE = "選択したモデルは利用できません";
export const TITLE_SUMMARY_DEFINITION_EMPTY_MESSAGE = "要約の定義を入力してください";
export const TITLE_SUMMARY_DEFINITION_TOO_LONG_MESSAGE = `要約の定義は${TITLE_DEFINITION_MAX}文字以内で入力してください`;

/** AI 要約の実効設定。generation は保存のたびに進み、古い結果の適用を防ぐ */
export interface TitleSummaryRuntimeSettings {
  enabled: boolean;
  model: { provider: string; id: string } | undefined;
  definition: string;
  generation: number;
}

export interface TitleSummarySettingsDb {
  /** 行が無ければ undefined = 既定 (Off / モデル未選択 / 既定の定義) */
  readTitleSummarySettings(): TitleSummarySettingsRow | undefined;
  saveTitleSummarySettings(settings: TitleSummarySettingsRow): void;
}

export interface TitleSummarySettingsOptions {
  db: TitleSummarySettingsDb;
  /** 認証済みで選択できるモデル。候補が無いプロセスでは常に空になる */
  models: () => readonly ModelOption[];
}

export type TitleSummaryMutationOutcome =
  | { status: 200; response: TitleSummarySettingsResponse }
  | { status: 400; error: string }
  | { status: 503; error: string };

interface StoredState {
  enabled: boolean;
  /** `provider/id` または null */
  model: string | null;
  definition: string;
}

export class TitleSummarySettingsService {
  #db: TitleSummarySettingsDb;
  #models: () => readonly ModelOption[];
  #lock = new MutationLock();
  #state: StoredState = { enabled: false, model: null, definition: TITLE_DEFINITION_DEFAULT };
  #generation = 0;
  #listeners = new Set<() => void>();

  constructor(options: TitleSummarySettingsOptions) {
    this.#db = options.db;
    this.#models = options.models;
  }

  /** GET。DB の読取失敗は既定を返さず 503 として伝える (設定画面が気付ける経路を残す) */
  settings(): TitleSummarySettingsResponse {
    const row = this.#readStoredOrThrow();
    return this.#response(
      row ? { enabled: row.enabled, model: row.model, definition: definitionOf(row) } : this.#defaultState(),
    );
  }

  /**
   * 予約に使う実効値。保存前の古い値を読むと、Off へ変えた直後の結果を適用してしまうため、
   * 書込の確定後だけ #state を差し替える。
   */
  runtime(): TitleSummaryRuntimeSettings {
    return {
      enabled: this.#state.enabled,
      model: parseModelRef(this.#state.model),
      definition: this.#state.definition,
      generation: this.#generation,
    };
  }

  /** 設定変更の購読。Off への変更で未開始の要約を取り消すために使う */
  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  /** DB を読めないだけで起動を止めない。行が無い = 既定として読み、読取失敗は既定のままにする */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      let row: TitleSummarySettingsRow | undefined;
      try {
        row = this.#db.readTitleSummarySettings();
      } catch {
        console.warn("[u7agent] title summary settings unavailable");
      }
      this.#state = row
        ? { enabled: row.enabled, model: row.model, definition: definitionOf(row) }
        : this.#defaultState();
    });
  }

  /**
   * 3 項目の保存。省略した項目は保存値を保つ (Off から On へ戻したときにモデルを選び直させない)。
   * 有効化には利用可能なモデルを要求し、未選択・利用不可は 400 にする (勝手に既定へ畳まない)。
   */
  async put(body: UpdateTitleSummaryBody): Promise<TitleSummaryMutationOutcome> {
    return this.#lock.run(async () => {
      const current = this.#state;
      let model = current.model;
      if (body.model !== undefined) model = body.model === null ? null : body.model.trim();
      const definitionError = body.definition === undefined ? undefined : definitionInvalidReason(body.definition);
      if (definitionError !== undefined) return { status: 400, error: definitionError };
      const definition = body.definition === undefined ? current.definition : body.definition.trim();
      if (body.model) {
        if (!this.#models().some((option) => model === `${option.provider}/${option.id}`)) {
          return { status: 400, error: TITLE_SUMMARY_MODEL_UNAVAILABLE_MESSAGE };
        }
      }
      if (body.enabled && !model) return { status: 400, error: TITLE_SUMMARY_MODEL_REQUIRED_MESSAGE };
      const next: StoredState = { enabled: body.enabled, model, definition };
      try {
        this.#db.saveTitleSummarySettings(next);
      } catch (error) {
        console.warn(`[u7agent] title summary settings save failed: ${messageFor(error)}`);
        return { status: 503, error: TITLE_SUMMARY_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#state = next;
      this.#generation += 1;
      for (const listener of this.#listeners) listener();
      return { status: 200, response: this.#response(next) };
    });
  }

  #readStoredOrThrow(): TitleSummarySettingsRow | undefined {
    try {
      return this.#db.readTitleSummarySettings();
    } catch (error) {
      throw httpError(503, `会話タイトルの設定を読み込めませんでした: ${messageFor(error)}`);
    }
  }

  #defaultState(): StoredState {
    return { enabled: false, model: null, definition: TITLE_DEFINITION_DEFAULT };
  }

  #response(state: StoredState): TitleSummarySettingsResponse {
    const models = this.#models().map((option) => ({
      provider: option.provider,
      id: option.id,
      name: option.name,
    })) satisfies TitleSummaryModelChoice[];
    const selected = parseModelRef(state.model);
    return {
      enabled: state.enabled,
      model: state.model,
      definition: definitionOf(state),
      defaultDefinition: TITLE_DEFINITION_DEFAULT,
      models,
      modelAvailable:
        selected === undefined
          ? false
          : models.some((option) => option.provider === selected.provider && option.id === selected.id),
    };
  }
}

/** 保存値をそのまま使うと、空白だけの定義で保存不能な状態が固定されるため、既定へ読み替える */
function definitionOf(state: { definition: string }): string {
  return state.definition.trim() === "" ? TITLE_DEFINITION_DEFAULT : state.definition;
}

function definitionInvalidReason(definition: string): string | undefined {
  const trimmed = definition.trim();
  if (trimmed === "") return TITLE_SUMMARY_DEFINITION_EMPTY_MESSAGE;
  if (trimmed.length > TITLE_DEFINITION_MAX) return TITLE_SUMMARY_DEFINITION_TOO_LONG_MESSAGE;
  return undefined;
}

export function parseModelRef(model: string | null): { provider: string; id: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}
