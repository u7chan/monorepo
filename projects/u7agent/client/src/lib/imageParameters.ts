/**
 * 画像の生成パラメータを、モデルの宣言から入力欄と下書きへ落とす純関数。設定画面の既定の編集と
 * 試行の入力が同じ規則（どのキーを欄にするか・未指定の扱い・宣言外の値の落とし方）を使う。
 */
import type { ImageModel, ImageParameterValues } from "../types";
import { modelRefKey } from "./modelSettings";

/**
 * 画像の生成パラメータの名前。server の許可リスト（`server/src/images.ts`）と同じ 6 キーで、画面もこの順に出す。
 * client からは schema の型しか引けないため、和集合をキーから取り直す。
 */
export type ImageParameterName = keyof ImageParameterValues;

/** 欄と表示の並び。provider の語彙ではなく許可リストの順で固定する */
export const IMAGE_PARAMETER_ORDER: readonly ImageParameterName[] = [
  "aspect_ratio",
  "resolution",
  "quality",
  "output_format",
  "background",
  "seed",
];

/** カタログ 1 件が持つ宣言と、その 1 項目。宣言が読めないモデルは `undefined`（＝不明） */
export type ImageParameterDeclarations = NonNullable<ImageModel["parameters"]>;
type ImageParameterDescriptor = NonNullable<ImageParameterDeclarations[ImageParameterName]>;

/** 未指定の表示名。押し付けの日本語ラベルは作らず、キーと値はそのまま出す */
export const IMAGE_PARAMETER_DEFAULT_LABEL = "モデル既定（provider）";

/** `seed` の上限（schema の検証と同じ 2^31-1） */
export const IMAGE_PARAMETER_SEED_MAX = 2 ** 31 - 1;

/** 画面の下書き。空文字は「未指定（モデル既定）」で、送るときだけ型へ寄せる */
export type ImageParameterDraft = Partial<Record<ImageParameterName, string>>;

/** 画面に出す入力欄。`enum` は選択、`seed` は整数だけを扱う */
export type ImageParameterField =
  | { name: Exclude<ImageParameterName, "seed">; kind: "enum"; values: string[] }
  | { name: "seed"; kind: "integer"; min: number; max: number };

/** 試行に使うモデルの宣言。カタログに無いモデル（カタログ外・削除済み）は `undefined`（＝不明） */
export function imageModelParameterDeclarations(
  models: readonly ImageModel[],
  model: string,
): ImageParameterDeclarations | undefined {
  return models.find((entry) => modelRefKey({ provider: entry.provider, id: entry.id }) === model)?.parameters;
}

/**
 * 入力欄の一覧。`enum` と `seed` だけを出し、値の語彙が読めない宣言（`boolean`）と
 * `seed` 以外の `range` は欄にしない（不明を既定として見せない）。並びは許可リストの順で固定する。
 */
export function imageParameterFields(declarations: ImageParameterDeclarations | undefined): ImageParameterField[] {
  if (!declarations) return [];
  const fields: ImageParameterField[] = [];
  for (const name of IMAGE_PARAMETER_ORDER) {
    const descriptor: ImageParameterDescriptor | undefined = declarations[name];
    if (!descriptor) continue;
    if (name === "seed") {
      // `seed` は「受け付ける」だけの宣言でも整数欄を出す（値の型は 1 つしかない）
      const range = descriptor.type === "range" ? descriptor : undefined;
      fields.push({
        name: "seed",
        kind: "integer",
        min: range ? Math.max(0, range.min) : 0,
        max: range ? Math.min(IMAGE_PARAMETER_SEED_MAX, range.max) : IMAGE_PARAMETER_SEED_MAX,
      });
      continue;
    }
    if (descriptor.type === "enum") fields.push({ name, kind: "enum", values: [...descriptor.values] });
  }
  return fields;
}

/**
 * 宣言に無いキーを下書きから落とす。モデルを切り替えたときに欄を隠すだけだと、隠れた値が要求に残って
 * 400 になるため、画面の state からも落とす（保存値には触らない）。選択肢に無い `enum` の値も同じ理由で落とす。
 * 何も落とさないときは同じ参照を返す（呼び出し側が state の更新を無限に起こさないため）。
 */
export function pruneImageTrialParameters(
  declarations: ImageParameterDeclarations | undefined,
  draft: ImageParameterDraft,
): ImageParameterDraft {
  const fields = imageParameterFields(declarations);
  const kept: ImageParameterDraft = {};
  let dropped = false;
  for (const name of IMAGE_PARAMETER_ORDER) {
    const value = draft[name];
    if (value === undefined) continue;
    const field = fields.find((entry) => entry.name === name);
    if (!field || (field.kind === "enum" && !field.values.includes(value))) {
      dropped = true;
      continue;
    }
    kept[name] = value;
  }
  return dropped ? kept : draft;
}

/** 保存値・スナップショットを入力欄の値へ。`seed` は整数欄の文字列にし、未指定は空欄にする */
export function imageParameterDraftOf(values: ImageParameterValues | null | undefined): ImageParameterDraft {
  const draft: ImageParameterDraft = {};
  if (!values) return draft;
  for (const name of IMAGE_PARAMETER_ORDER) {
    const value = values[name];
    if (value !== undefined) draft[name] = String(value);
  }
  return draft;
}
