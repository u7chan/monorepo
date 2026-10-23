/**
 * 参照画像のバイト判定。`generate_image` の入力と、サンドボックスの入力読取の両方がこれを通し、
 * 「拡張子ではなく実バイトの形式を正とする」規則を 1 箇所に閉じる（docs/image-generation.md）。
 * ヘッダの検証までで、深い破損は provider の入力エラーに任せる（デコーダーは足さない）。
 */

/** 参照画像として受け付ける MIME。自動変換・自動縮小はしない */
export const IMAGE_INPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type ImageInputMimeType = (typeof IMAGE_INPUT_MIME_TYPES)[number];

/** 1 枚の上限。raw / 添付の 100 MiB を入力の上限に流用しない */
export const IMAGE_INPUT_MAX_BYTES = 10 * 1024 * 1024;

/** 1 枚の画素数の上限。base64 の約 4/3 倍と JSON 化のメモリ増加も見込んだ提案値 */
export const IMAGE_INPUT_MAX_PIXELS = 40_000_000;

export interface ImageInputFormat {
  mimeType: ImageInputMimeType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** IHDR は必ず先頭チャンクで、長さ 13 / 型 `IHDR` / 幅と高さが続く */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 33) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) return undefined;
  const chunkType = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunkType !== "IHDR") return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** SOF マーカー（フレームヘッダ）。DHT(C4) / JPG(C8) / DAC(CC) は除く */
function isJpegFrameMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** SOI から SOF までマーカーを辿り、高さ・幅を読む。SOF より前に EOI が来たら画像として扱わない */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // スタンドアロンマーカー（TEM / RSTn）は長さを持たない
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) return undefined;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return undefined;
    if (isJpegFrameMarker(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

/** RIFF の `WEBP` 配下の 3 形式（VP8X / VP8 / VP8L）から大きさを読む */
function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return { width: readUint24(bytes, 24) + 1, height: readUint24(bytes, 27) + 1 };
  }
  if (chunk === "VP8 ") {
    // フレームタグ 3 バイト + 開始コード 9d 01 2a の後に 14bit の幅・高さが続く
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return undefined;
    // 署名 1 バイトの後、14bit 幅 / 14bit 高さ（それぞれ -1 で格納）
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function formatOf(bytes: Uint8Array): ImageInputFormat | undefined {
  if (isPng(bytes)) {
    const size = pngSize(bytes);
    return size ? { mimeType: "image/png", ...size } : undefined;
  }
  const jpeg = jpegSize(bytes);
  if (jpeg) return { mimeType: "image/jpeg", ...jpeg };
  const webp = webpSize(bytes);
  if (webp) return { mimeType: "image/webp", ...webp };
  return undefined;
}

/**
 * 実バイトから形式と大きさを決める。対応外・ヘッダ不正・大きさ 0 は undefined。
 * 上限（バイト数・画素数）は呼び出し側が別々の文言で拒むため、ここでは判定しない。
 */
export function inspectImageInput(bytes: Uint8Array): ImageInputFormat | undefined {
  const format = formatOf(bytes);
  if (!format || format.width <= 0 || format.height <= 0) return undefined;
  return format;
}

/** 画素数の上限内か。幅 × 高さが Number の安全域を超えないよう割り算で比べる */
export function fitsImageInputPixels(width: number, height: number): boolean {
  return width > 0 && height > 0 && height <= IMAGE_INPUT_MAX_PIXELS / width;
}

/** base64 の画像を provider へ渡す data URL にする */
export function imageDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

const DATA_URL_PATTERN = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/gi;

/**
 * 入力画像の data URL / base64 を本文から取り除く。provider のエラー本文が送った入力を反射しても、
 * 結果・ログ・履歴へ base64 を載せないための境界（docs/image-generation.md）。
 */
export function stripImageInputData(text: string, base64Payloads: readonly string[] = []): string {
  let stripped = text.replace(DATA_URL_PATTERN, "data:<image omitted>");
  for (const payload of base64Payloads) {
    if (payload.length < 32) continue;
    stripped = stripped.split(payload).join("<image omitted>");
  }
  return stripped;
}
