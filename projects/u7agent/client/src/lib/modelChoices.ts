/**
 * Model ピッカーの選択肢。表示名（`ModelOption.name`）を基本にし、候補全体で同名が衝突する
 * ときだけ provider を添える。provider ごとに `provider/id` の表記系が違うため、生 ID を
 * 常時出しても読み手は対応を取れない。衝突の解消に必要な最小の情報だけを足す。
 */
import type { ModelOption, ModelRef } from "../types";
import { modelRefKey } from "./modelSettings";

export interface ModelChoice {
  /** onChange に渡す値。`modelRefKey()` と同じ `provider/id` 表記 */
  value: string;
  label: string;
  /** 候補に無い行（利用不可）は null。選び直しても現在値のままになる */
  model: ModelRef | null;
}

/**
 * 選択肢の表示名。同名の候補があるときだけ provider を添える:
 * 同じ `(provider, name)` が別 id で 2 件以上あるときは `name（provider/id）`、そうでなく
 * 同名が 2 つ以上の provider にあるときは `name（provider）`、それ以外は `name`。
 * 数えるのは distinct な id / provider で、同じ `(provider, id)` の重複では判定を変えない。
 */
export function modelChoices(options: ModelOption[]): ModelChoice[] {
  const providersByName = new Map<string, Set<string>>();
  const idsByName = new Map<string, Map<string, Set<string>>>();
  for (const option of options) {
    let providers = providersByName.get(option.name);
    if (!providers) providersByName.set(option.name, (providers = new Set()));
    providers.add(option.provider);

    let idsByProvider = idsByName.get(option.name);
    if (!idsByProvider) idsByName.set(option.name, (idsByProvider = new Map()));
    let ids = idsByProvider.get(option.provider);
    if (!ids) idsByProvider.set(option.provider, (ids = new Set()));
    ids.add(option.id);
  }

  return options.map((option) => {
    const model: ModelRef = { provider: option.provider, id: option.id };
    const value = modelRefKey(model);
    // name は DTO 上は空を許す。表示名に使えないときは一意な value をそのまま出す
    if (option.name === "") return { value, label: value, model };
    if ((idsByName.get(option.name)?.get(option.provider)?.size ?? 0) > 1) {
      return { value, label: `${option.name}（${value}）`, model };
    }
    if ((providersByName.get(option.name)?.size ?? 0) > 1) {
      return { value, label: `${option.name}（${option.provider}）`, model };
    }
    return { value, label: option.name, model };
  });
}

/** 候補一覧に無いモデル（利用不可）の 1 行。value と label は `provider/id（利用不可）` */
export function unavailableModelChoice(model: string): ModelChoice {
  return { value: model, label: `${model}（利用不可）`, model: null };
}
