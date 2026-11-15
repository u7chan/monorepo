/**
 * 選択した画像を 16:10 の PNG にする。File のデコード・canvas・toBlob は DOM 依存で単体テストできないため、
 * この 1 箇所に閉じる（数値の計算は `sharedThumbnail.ts`）。
 */
import {
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MIN_WIDTH,
  thumbnailCropRect,
  thumbnailSourceProblem,
  type ThumbnailCrop,
} from "./sharedThumbnail";

/** デコード前の入力上限。canvas へ載せる前に止めないと、巨大な画像でメモリを消費する */
export const THUMBNAIL_INPUT_MAX_BYTES = 20 * 1024 * 1024;

export interface ThumbnailSource {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/**
 * 選ばれたファイルをデコードする。SVG は寸法が不定で、スクリプトや外部参照も持ち込めるため受けない
 * （ラスタライズの是非を別に決める必要が出る）。
 */
export async function loadThumbnailSource(file: File): Promise<ThumbnailSource> {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
    throw new Error("SVG は選べません。PNG か JPEG の画像を選んでください");
  }
  if (file.size > THUMBNAIL_INPUT_MAX_BYTES) {
    throw new Error("画像が大きすぎます。20 MiB 以下の画像を選んでください");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("画像として読み込めませんでした。この形式はブラウザが表示できません");
  }
  const problem = thumbnailSourceProblem(bitmap.width, bitmap.height);
  if (problem !== undefined) {
    bitmap.close();
    throw new Error(problem);
  }
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像を変換できませんでした");
  return context;
}

/** プレビュー用の canvas へ、いまの切り抜き範囲を描く */
export function drawThumbnailPreview(canvas: HTMLCanvasElement, source: ThumbnailSource, crop: ThumbnailCrop): void {
  const rect = thumbnailCropRect(crop, source.width, source.height);
  const context = context2d(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source.bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
}

function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("画像を変換できませんでした"));
    }, "image/png");
  });
}

/**
 * いまの切り抜き範囲を PNG にする。2 MiB を超えたら寸法を 1 段ずつ落として作り直す
 * （PNG に品質指定は無いため、縮小以外に容量を下げる手段が無い）。
 */
export async function renderThumbnailPng(source: ThumbnailSource, crop: ThumbnailCrop): Promise<Uint8Array> {
  const rect = thumbnailCropRect(crop, source.width, source.height);
  for (let width = rect.outputWidth; width >= THUMBNAIL_MIN_WIDTH; width = Math.round((width * 0.8) / 8) * 8) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(width / 1.6);
    context2d(canvas).drawImage(source.bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, canvas.height);
    const blob = await encodePng(canvas);
    if (blob.size <= THUMBNAIL_MAX_BYTES) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("画像を保存できるサイズに収められませんでした。別の画像を選んでください");
}
