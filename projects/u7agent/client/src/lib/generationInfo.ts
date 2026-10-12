/**
 * 生成ツール（generate_image / generate_speech）の結果本文からモデル・ボイス・保存パスを読む。
 * 値は結果本文のまま返す（カタログの表示名へは解決しない）。
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

/** 投影は先頭 900 文字で切るため、本文全体を走査しても見つかる行は増えない（無関係な行を拾う危険だけが増える） */
const HEAD_LINE_COUNT = 3;

/**
 * 改行で終わる行だけを読む。投影で切られた最終行は値が欠けている可能性がある（例: 保存パスの断片）。
 */
function headValue(output: string, label: string): string | undefined {
  const lines = output.split("\n");
  for (const line of lines.slice(0, Math.min(lines.length - 1, HEAD_LINE_COUNT))) {
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
 * 生成ツールのカードからバッジの材料を読む。対象外のツールと失敗カードは undefined
 * （出さない条件の根拠は docs/image-generation.md#チャットのバッジ）。
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

export type GenerationBadge = { key: string; info: GenerationInfo };

/** カードを呼び出し順のままバッジだけにする */
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
