/**
 * 生成ツール（generate_image / generate_speech）の結果本文から、実行に使ったモデル・ボイス・保存パスを読む。
 * 結果本文の値をそのまま返し、カタログの表示名へは解決しない（表示名は変わりうるが、履歴の意味は変えない）。
 */
import type { ToolCard } from "./chatTypes";

export type GenerationKind = "image" | "speech";

export type GenerationInfo = {
  kind: GenerationKind;
  /** 実行時に使ったモデル id */
  model: string;
  /** 音声のボイス。実行で指定が無いときはモデル既定を表す文言が結果本文に入る */
  voice?: string;
  /** 実際に保存された cwd 相対パス。結果本文の形が違って読めないときは undefined */
  path?: string;
};

const MODEL_LINE = "モデル:";
const VOICE_LINE = "ボイス:";
const PATH_LINE: Record<GenerationKind, string> = {
  image: "画像を生成して保存しました:",
  speech: "音声を生成して保存しました:",
};

/**
 * 探す範囲は結果本文の先頭だけでよい。投影（`SUMMARY_TEXT_MAX` = 900 文字）はモデル行が必ず残る位置で
 * 切るため、本文全体を走査しても見つかる行は増えず、無関係な行を拾う危険だけが増える。
 */
const HEAD_LINE_COUNT = 3;

function headValue(output: string, label: string): string | undefined {
  for (const line of output.split("\n", HEAD_LINE_COUNT)) {
    if (!line.startsWith(label)) continue;
    const value = line.slice(label.length).trim();
    if (value !== "") return value;
  }
  return undefined;
}

/** server の定数を import すると client が server の module を辿るため、ツール名はここで literal に持つ */
function generationKindOf(name: string): GenerationKind | undefined {
  if (name === "generate_image") return "image";
  if (name === "generate_speech") return "speech";
  return undefined;
}

/**
 * 生成ツールのカードからバッジの材料を読む。対象外のツール、結果本文にモデル行が無いカード
 * （モデル行を書く前のセッション）、失敗したカード（結果本文が残らない）は undefined になる。
 */
export function generationInfoOf(card: Pick<ToolCard, "name" | "phase" | "output">): GenerationInfo | undefined {
  const kind = generationKindOf(card.name);
  if (kind === undefined || card.phase === "failed") return undefined;
  const model = headValue(card.output, MODEL_LINE);
  if (model === undefined) return undefined;
  const info: GenerationInfo = { kind, model };
  if (kind === "speech") {
    const voice = headValue(card.output, VOICE_LINE);
    if (voice !== undefined) info.voice = voice;
  }
  const path = headValue(card.output, PATH_LINE[kind]);
  if (path !== undefined) info.path = path;
  return info;
}

/** バッジ 1 件。`key` はカードの安定 id で、同じカードが 2 つのバブルに現れない前提を表示側で使う */
export type GenerationBadge = { key: string; info: GenerationInfo };

/** カードを呼び出し順のままバッジだけにする（件数の上限は表示側が決める） */
export function generationBadgesOf(
  cards: readonly Pick<ToolCard, "id" | "name" | "phase" | "output">[],
): GenerationBadge[] {
  const badges: GenerationBadge[] = [];
  for (const card of cards) {
    const info = generationInfoOf(card);
    if (info !== undefined) badges.push({ key: card.id, info });
  }
  return badges;
}
