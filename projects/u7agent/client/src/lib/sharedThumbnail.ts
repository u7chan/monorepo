/**
 * 共有物のサムネイルの切り抜き計算。16:10 の枠を原寸で満たす範囲まで倍率を上げられる。
 * 描画 (canvas) は `sharedThumbnailFile.ts` に閉じ、ここは数値だけを返す（テストできる形を保つ）。
 */
import type { SharedContentThumbnail, SharedContentResponse } from "../types";

/** 16:10。サーバーの検証（`width * 5 === height * 8`）と同じ比 */
export const THUMBNAIL_ASPECT = 1.6;
export const THUMBNAIL_MAX_WIDTH = 1600;
export const THUMBNAIL_MIN_WIDTH = 320;
/** サーバーの上限と同じ値。超えたら寸法を落として作り直す */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
/** 矢印キー 1 回で動かす量（枠の幅に対する比） */
export const THUMBNAIL_PAN_STEP = 0.1;

export interface ThumbnailCrop {
  /** 1 = 枠いっぱい。大きいほど拡大（枠が狭くなる） */
  zoom: number;
  /** -1 〜 1。0 が中央。端は画像の端で止まる */
  offsetX: number;
  offsetY: number;
}

export const INITIAL_THUMBNAIL_CROP: ThumbnailCrop = { zoom: 1, offsetX: 0, offsetY: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 画像に内接する 16:10 の枠（原寸、引き伸ばさない） */
export function thumbnailFrame(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { width: 0, height: 0 };
  const width = Math.min(sourceWidth, Math.floor(sourceHeight * THUMBNAIL_ASPECT));
  return { width, height: Math.floor(width / THUMBNAIL_ASPECT) };
}

/** 枠の幅が保存できる最小幅を割らない範囲で拡大できる上限 */
export function thumbnailMaxZoom(sourceWidth: number, sourceHeight: number): number {
  const frame = thumbnailFrame(sourceWidth, sourceHeight);
  if (frame.width < THUMBNAIL_MIN_WIDTH) return 1;
  return frame.width / THUMBNAIL_MIN_WIDTH;
}

/** 小さすぎる画像は保存しない（引き伸ばすと一覧でも粗く、拡大表示に耐えない） */
export function thumbnailSourceProblem(sourceWidth: number, sourceHeight: number): string | undefined {
  const frame = thumbnailFrame(sourceWidth, sourceHeight);
  if (frame.width >= THUMBNAIL_MIN_WIDTH) return undefined;
  return `画像が小さすぎます（${THUMBNAIL_MIN_WIDTH}×${Math.round(THUMBNAIL_MIN_WIDTH / THUMBNAIL_ASPECT)} 以上が必要です）`;
}

/** 出力幅は 8 の倍数（16:10 を整数の高さで表せる最小の刻み）に切り捨てる。原寸を超えて引き伸ばさない */
function snapWidth(value: number): number {
  return clamp(Math.floor(value / 8) * 8, THUMBNAIL_MIN_WIDTH, THUMBNAIL_MAX_WIDTH);
}

export function clampThumbnailCrop(crop: ThumbnailCrop, sourceWidth: number, sourceHeight: number): ThumbnailCrop {
  return {
    zoom: clamp(Number.isFinite(crop.zoom) ? crop.zoom : 1, 1, thumbnailMaxZoom(sourceWidth, sourceHeight)),
    offsetX: clamp(Number.isFinite(crop.offsetX) ? crop.offsetX : 0, -1, 1),
    offsetY: clamp(Number.isFinite(crop.offsetY) ? crop.offsetY : 0, -1, 1),
  };
}

export interface ThumbnailCropRect {
  /** 元画像の切り抜き範囲 */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** 保存する PNG の寸法。元画像の切り抜き範囲を超えない */
  outputWidth: number;
  outputHeight: number;
}

export function thumbnailCropRect(crop: ThumbnailCrop, sourceWidth: number, sourceHeight: number): ThumbnailCropRect {
  const frame = thumbnailFrame(sourceWidth, sourceHeight);
  const clamped = clampThumbnailCrop(crop, sourceWidth, sourceHeight);
  const sw = frame.width / clamped.zoom;
  const sh = frame.height / clamped.zoom;
  const slackX = Math.max(0, sourceWidth - sw);
  const slackY = Math.max(0, sourceHeight - sh);
  const outputWidth = snapWidth(sw);
  return {
    sx: slackX * (0.5 + clamped.offsetX / 2),
    sy: slackY * (0.5 + clamped.offsetY / 2),
    sw,
    sh,
    outputWidth,
    outputHeight: outputWidth / THUMBNAIL_ASPECT,
  };
}

/**
 * ドラッグの移動量を倍率に反映する。`dx` / `dy` はプレビューの CSS px で、
 * 画像の余白（`slack`）に対する比へ直してから offset を動かす。
 */
export function panThumbnailCrop(
  crop: ThumbnailCrop,
  delta: { dx: number; dy: number },
  previewWidth: number,
  previewHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ThumbnailCrop {
  const clamped = clampThumbnailCrop(crop, sourceWidth, sourceHeight);
  const rect = thumbnailCropRect(clamped, sourceWidth, sourceHeight);
  const slackX = Math.max(0, sourceWidth - rect.sw);
  const slackY = Math.max(0, sourceHeight - rect.sh);
  const scaleX = previewWidth > 0 ? rect.sw / previewWidth : 0;
  const scaleY = previewHeight > 0 ? rect.sh / previewHeight : 0;
  return clampThumbnailCrop(
    {
      zoom: clamped.zoom,
      offsetX: slackX === 0 ? 0 : clamped.offsetX - (2 * delta.dx * scaleX) / slackX,
      offsetY: slackY === 0 ? 0 : clamped.offsetY - (2 * delta.dy * scaleY) / slackY,
    },
    sourceWidth,
    sourceHeight,
  );
}

/** キーボード操作。矢印で位置、+ / - で倍率。扱わないキーは undefined を返す */
export function thumbnailKeyStep(
  crop: ThumbnailCrop,
  key: string,
  sourceWidth: number,
  sourceHeight: number,
): ThumbnailCrop | undefined {
  const clamped = clampThumbnailCrop(crop, sourceWidth, sourceHeight);
  const step = THUMBNAIL_PAN_STEP;
  const zoomStep = 0.1;
  switch (key) {
    case "ArrowLeft":
      return clampThumbnailCrop({ ...clamped, offsetX: clamped.offsetX - step }, sourceWidth, sourceHeight);
    case "ArrowRight":
      return clampThumbnailCrop({ ...clamped, offsetX: clamped.offsetX + step }, sourceWidth, sourceHeight);
    case "ArrowUp":
      return clampThumbnailCrop({ ...clamped, offsetY: clamped.offsetY - step }, sourceWidth, sourceHeight);
    case "ArrowDown":
      return clampThumbnailCrop({ ...clamped, offsetY: clamped.offsetY + step }, sourceWidth, sourceHeight);
    case "+":
    case "=":
    case "PageUp":
      return clampThumbnailCrop({ ...clamped, zoom: clamped.zoom + zoomStep }, sourceWidth, sourceHeight);
    case "-":
    case "_":
    case "PageDown":
      return clampThumbnailCrop({ ...clamped, zoom: clamped.zoom - zoomStep }, sourceWidth, sourceHeight);
    default:
      return undefined;
  }
}

/**
 * 一覧の枠へ画像をまとめて落としたときに添える理由。2 枚目以降は設定できない。
 */
export const THUMBNAIL_DROP_EXTRA_NOTE = "一度に設定できる画像は 1 枚です。最初の 1 枚を読み込みました";

/**
 * ドロップされたファイルから、サムネイルに使う 1 枚を選ぶ。枠は 1 枚しか持てないので、増えた分は
 * 捨てた枚数として返し、画面が理由を出せるようにする（黙って落とさない）。
 */
export function thumbnailDropPick<T>(files: readonly T[]): { file: T; ignored: number } | undefined {
  const [first] = files;
  if (first === undefined) return undefined;
  return { file: first, ignored: files.length - 1 };
}

/**
 * サムネイル操作の失敗で一覧を取り直すか。BFF が `state: "not_stored"`（この要求で保存していない）と
 * 確定した失敗だけ取り直さない。中継の 502 や通信断は結果不明なので、再取得して確定状態へ寄せる。
 */
export function thumbnailFailureNeedsRefetch(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("state" in error)) return true;
  return (error as { state?: unknown }).state !== "not_stored";
}

/**
 * 配信 URL。版をクエリに載せるので、差し替えると別 URL になり、変わらなければキャッシュから出る。
 * サーバーも `immutable` を返すため、この URL に版を含めないと差し替えが反映されない。
 */
export function sharedContentThumbnailUrl(id: string, updatedAt: number): string {
  return `/api/shared-contents/${encodeURIComponent(id)}/thumbnail?v=${updatedAt}`;
}

/**
 * 一覧の行のサムネイルを、版が巻き戻らないように差し替える。
 * 保存より前に発行した一覧が遅れて届いても、新しい画像を古い版で上書きしない。
 */
export function withSharedContentThumbnail(
  items: readonly SharedContentResponse[],
  id: string,
  thumbnail: SharedContentThumbnail | null,
): SharedContentResponse[] {
  return items.map((item) => {
    if (item.id !== id) return item;
    if (thumbnail === null) return { ...item, thumbnail: null };
    if (item.thumbnail !== null && item.thumbnail.updatedAt > thumbnail.updatedAt) return item;
    return { ...item, thumbnail };
  });
}
