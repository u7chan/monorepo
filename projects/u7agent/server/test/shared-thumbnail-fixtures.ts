// テスト用の架空 PNG。共有物のサムネイルは 16:10 の PNG だけを受け付けるため、
// 実在の画像を使わずに、寸法・破損・余剰バイト・付帯チャンクを組み立てて検証する。
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** PNG のチャンク。type は 4 文字、crc を差し替えると破損を作れる */
function chunk(type: string, body: Uint8Array, crcOverride?: number): Uint8Array {
  const typed = new Uint8Array([...type].map((char) => char.charCodeAt(0)));
  const crcBody = concat([typed, body]);
  return concat([u32(body.byteLength), typed, body, u32(crcOverride ?? crc32(crcBody))]);
}

interface PngOptions {
  width: number;
  height: number;
  colorType?: number;
  bitDepth?: number;
  interlace?: number;
  /** 前後に足すチャンク（メタデータの混入を作る） */
  extra?: readonly Uint8Array[];
  /** 実際のデータは宣言より小さく作る（寸法とデータの食い違い） */
  shrinkData?: boolean;
  /** 走査線の先頭に書くフィルタ種別（PNG は 0〜4 だけ） */
  filterByte?: number;
  /** 末尾に足す不正なバイト（IEND 後の余剰） */
  trailing?: number;
  /** IHDR の CRC を壊す */
  corrupt?: boolean;
}

export function png(options: PngOptions): Uint8Array {
  const { width, height, colorType = 6, bitDepth = 8, interlace = 0 } = options;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] ?? 4;
  const dataWidth = width * channels;
  const rows = options.shrinkData ? height - 1 : height;
  const raw = new Uint8Array(rows * (1 + dataWidth));
  for (let row = 0; row < rows; row += 1) {
    raw[row * (1 + dataWidth)] = options.filterByte ?? 0;
    for (let column = 0; column < dataWidth; column += 1) {
      raw[row * (1 + dataWidth) + 1 + column] = (row + column) % 256;
    }
  }
  const header = concat([u32(width), u32(height), new Uint8Array([bitDepth, colorType, 0, 0, interlace])]);
  return concat([
    new Uint8Array(PNG_SIGNATURE),
    chunk("IHDR", header, options.corrupt ? 0 : undefined),
    ...(options.extra ?? []),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
    ...(options.trailing === undefined ? [] : [new Uint8Array(options.trailing)]),
  ]);
}

export function textChunk(keyword: string, value: string): Uint8Array {
  const body = new Uint8Array([...keyword].map((char) => char.charCodeAt(0)).concat([0]));
  return chunk("tEXt", concat([body, new Uint8Array([...value].map((char) => char.charCodeAt(0)))]));
}
