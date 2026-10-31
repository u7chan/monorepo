import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

export type ProbeProviderId = "codex" | "opencodeGo";

type ProbeModel = Model<Api>;

export type ProbeModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** 画面の選択肢。ネットワークは叩かず、`package.json` で固定した pi-ai の catalog だけを使う。 */
export type ProbeModelSummary = {
  id: string;
  name: string;
  thinkingLevels: ModelThinkingLevel[];
  cost: ProbeModelCost;
};

export type ProbeCatalog = { codex: ProbeModelSummary[]; opencodeGo: ProbeModelSummary[] };

/**
 * Google の adapter は custom fetch を受け付けない。status を捕捉できないと
 * 401 / 429 を同じ契約で丸められないため、probe の対象から外す。
 */
const PROBE_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "openai-codex-responses",
]);

export function readProbeCatalog(): ProbeCatalog {
  return { codex: listProbeModels("codex"), opencodeGo: listProbeModels("opencodeGo") };
}

/** 一覧と lookup で同じ絞り込みと重複除去を使う。片方だけ規則が違うと画面の選択肢が送れなくなる。 */
export function listProbeModels(provider: ProbeProviderId): ProbeModelSummary[] {
  return probeModels(provider).map(toSummary);
}

export function findProbeModel(provider: ProbeProviderId, id: string): ProbeModel | null {
  return probeModels(provider).find((model) => model.id === id) ?? null;
}

export function probeThinkingLevels(model: ProbeModel): ModelThinkingLevel[] {
  return getSupportedThinkingLevels(model);
}

export function isProbeThinkingLevel(value: string): value is ModelThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

/** 保存値は文字列なので、model が対応するかをここで確かめてから送る。 */
export function supportsProbeThinking(model: ProbeModel, level: string): boolean {
  return isProbeThinkingLevel(level) && probeThinkingLevels(model).includes(level);
}

/** 設定 API の検証。catalog に無いモデルと、そのモデルが対応しない思考レベルを弾く。 */
export function validateProbeConfig(
  provider: ProbeProviderId,
  model: string,
  thinking: string,
): "invalid_model" | "invalid_thinking" | null {
  const found = findProbeModel(provider, model);

  if (found === null) {
    return "invalid_model";
  }

  return supportsProbeThinking(found, thinking) ? null : "invalid_thinking";
}

/**
 * 同じ model が API 違いで並ぶことがある。id が重複したら先勝ちにし、
 * 送信時の lookup でも同じ 1 件へ解決させる。
 */
function probeModels(provider: ProbeProviderId): ProbeModel[] {
  const source = provider === "codex" ? openaiCodexProvider().getModels() : opencodeGoProvider().getModels();
  const seen = new Set<string>();
  const models: ProbeModel[] = [];

  for (const model of source as readonly ProbeModel[]) {
    if (model.type !== undefined && model.type !== "chat") {
      continue;
    }

    if (!PROBE_APIS.has(model.api) || seen.has(model.id)) {
      continue;
    }

    seen.add(model.id);
    models.push(model);
  }

  return models;
}

function toSummary(model: ProbeModel): ProbeModelSummary {
  return {
    id: model.id,
    name: model.name,
    thinkingLevels: probeThinkingLevels(model),
    // tier は表示しない。1M token あたりの基本料金だけを参考値として出す。
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
  };
}
