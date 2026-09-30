/**
 * 画像プレビューのパス行に出すメタ表記。寸法は `<img>` の読み込み結果、サイズはツリーの行から来るため、
 * どちらか片方だけ分かる場合がある。分かる項目だけを並べ、両方分からなければ null (行ごと出さない) を返す。
 * DOM に依存しない純関数だけを置く。
 */
import { formatBytes } from "./attachments";

/** 画像の内在ピクセル (デバイスピクセル)。表示倍率は持たない */
export type ImageDimensions = { width: number; height: number };

export function imageMetaLabel(size: number | undefined, dimensions: ImageDimensions | undefined): string | null {
  const dimensionLabel =
    dimensions !== undefined &&
    Number.isFinite(dimensions.width) &&
    Number.isFinite(dimensions.height) &&
    dimensions.width > 0 &&
    dimensions.height > 0
      ? `${dimensions.width} × ${dimensions.height}`
      : "";
  // formatBytes は不正な値で空文字を返す (0 B は返すため、サイズ 0 のファイルも表記は残る)
  const sizeLabel = size === undefined ? "" : formatBytes(size);
  const parts = [dimensionLabel, sizeLabel].filter((part) => part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}
