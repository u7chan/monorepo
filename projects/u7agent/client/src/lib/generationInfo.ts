/**
 * 生成ツール（generate_image / generate_speech）の結果本文からモデル・ボイス・保存パスを読む。
 * 値は結果本文のまま返す（カタログの表示名へは解決しない）。
 */
import type { Bubble, ToolCard } from "./chatTypes";
import { fileTreeFetchPath } from "./fileTree";
import { resolveFileRef } from "./fileRef";
import { headValue } from "./toolOutput";

export type GenerationKind = "image" | "speech" | "bgm";

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
  bgm: "BGMを生成して保存しました:",
};

/** server の定数を import すると client が server の module を辿るため、ツール名はここで literal に持つ */
function generationKindOf(name: string): GenerationKind | undefined {
  if (name === "generate_image") return "image";
  if (name === "generate_speech") return "speech";
  if (name === "generate_bgm") return "bgm";
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

/** バブル id → (root 相対パス → そのパスの生成情報)。ターンの切り方は generationCaptionsOf と同じ */
export type GenerationCaptions = Map<number, Map<string, GenerationInfo>>;

/**
 * 生成カードの保存パスを root 相対へ解決し、ターン (user バブルの次から次の user バブルまで) の
 * 各バブルへ同じ表を配る。ターン単位にする理由は docs/image-generation.md#生成物のキャプション。
 */
export function generationCaptionsOf(
  bubbles: readonly Bubble[],
  { rootCwd, cwd }: { rootCwd: string; cwd: string },
): GenerationCaptions {
  const captions: GenerationCaptions = new Map();
  if (cwd === "") return captions;
  let turn = new Map<string, GenerationInfo>();
  for (const bubble of bubbles) {
    if (bubble.role === "user") {
      turn = new Map();
      continue;
    }
    for (const badge of generationBadgesOf(bubble.tools)) {
      const { info } = badge;
      if (info.path === undefined) continue;
      const resolved = resolveFileRef(info.path, rootCwd, cwd);
      if (resolved === null) continue;
      // 同じパスが 1 ターンに複数あるときは実行順で後を優先する (同名はサンドボックスが退避するため通常は起きない)
      turn.set(fileTreeFetchPath(cwd, resolved), info);
    }
    captions.set(bubble.id, turn);
  }
  return captions;
}
