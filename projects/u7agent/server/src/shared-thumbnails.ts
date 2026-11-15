/**
 * 共有物のサムネイル。クライアントが canvas で 16:10 に描き直した PNG を受け取るが、
 * 「クライアントが送ったバイト」を信用せずここで構造まで検証する（デコーダの依存は足さない）。
 * 実体は会話ストア / DB の兄弟 (`<storeDir>/shared-thumbnails`) に置き、DB にはメタだけを持つ。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

/** 会話ストア直下のディレクトリ名。`trials` と同じく DB の兄弟に置く */
export const SHARED_THUMBNAIL_DIR_NAME = "shared-thumbnails";

/** 1 枚の上限。クライアントも同じ値で寸法を落としてから送る */
export const SHARED_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 出力寸法の範囲。16:10 を保ったまま原寸を超えない幅を使う。
 * 幅の上限が宣言画素数の上界（1600 × 1000）を決め、デコード量を IHDR だけで抑える。
 */
export const SHARED_THUMBNAIL_MIN_WIDTH = 320;
export const SHARED_THUMBNAIL_MAX_WIDTH = 1600;

export const SHARED_THUMBNAIL_MIME = "image/png";

/** 保存名の形。外から来たパスを fs へ渡さないため、id はこの文字種だけを通す */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_NAME_PATTERN = /^([A-Za-z0-9_-]{1,64})\.png$/;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * メタデータを持つ付帯チャンク。canvas の再描画では出ないので、出てきた時点で
 * 「クライアントが作った PNG ではない」として拒否する。
 */
const METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);

/** 既知のクリティカルチャンク以外は通さない（未知の必須チャンクは描画できない） */
const KNOWN_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

/** 色種別 → 1 画素あたりのチャンネル数。キャンバスの PNG が取り得る範囲だけを受ける */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

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
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface SharedThumbnailInspection {
  width: number;
  height: number;
}

interface PngHeader extends SharedThumbnailInspection {
  colorType: number;
  channels: number;
}

function readHeader(view: DataView, offset: number): PngHeader | undefined {
  const width = view.getUint32(offset);
  const height = view.getUint32(offset + 4);
  const bitDepth = view.getUint8(offset + 8);
  const colorType = view.getUint8(offset + 9);
  const compression = view.getUint8(offset + 10);
  const filter = view.getUint8(offset + 11);
  const interlace = view.getUint8(offset + 12);
  const channels = CHANNELS[colorType];
  if (channels === undefined) return undefined;
  // 16:10 (8:5) ちょうど。幅が 8 の倍数であることと同じ規則を 1 つの式で表す
  if (width * 5 !== height * 8) return undefined;
  if (width < SHARED_THUMBNAIL_MIN_WIDTH || width > SHARED_THUMBNAIL_MAX_WIDTH) return undefined;
  // canvas.toBlob("image/png") は 8 bit・非インターレースで出す。それ以外は別経路の生成物として扱う
  if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) return undefined;
  return { width, height, colorType, channels };
}

/** パレットを持つ色種別か。PLTE が必須なのは 3 だけで、2 / 6 は任意に持てる */
function paletteAllowed(colorType: number): boolean {
  return colorType === 2 || colorType === 3 || colorType === 6;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/**
 * PNG を構造まで検証して寸法を返す。壊れていれば undefined。
 * 途中で切れたファイル・CRC 不一致・圧縮爆弾・メタデータ付きの画像を、保存の前にここで落とす。
 */
export function inspectSharedThumbnailPng(bytes: Uint8Array): SharedThumbnailInspection | undefined {
  if (bytes.byteLength > SHARED_THUMBNAIL_MAX_BYTES) return undefined;
  if (bytes.byteLength < PNG_SIGNATURE.length) return undefined;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let header: PngHeader | undefined;
  let palette = false;
  const data: Uint8Array[] = [];
  let ended = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + length;
    const next = bodyEnd + 4;
    // length は符号なしなので、加算の桁溢れだけをここで見る
    if (bodyEnd < bodyStart || next > bytes.byteLength) return undefined;
    if (crc32(bytes.subarray(offset + 4, bodyEnd)) !== view.getUint32(bodyEnd)) return undefined;
    if (METADATA_CHUNKS.has(type)) return undefined;
    const critical = type[0] !== undefined && type[0] === type[0].toUpperCase();
    if (critical && !KNOWN_CRITICAL_CHUNKS.has(type)) return undefined;
    switch (type) {
      case "IHDR":
        if (header !== undefined || length !== 13) return undefined;
        header = readHeader(view, bodyStart);
        if (header === undefined) return undefined;
        break;
      case "PLTE":
        // IHDR の後・IDAT の前。パレットを持てない色種別では拒否する
        if (header === undefined || palette || data.length > 0 || !paletteAllowed(header.colorType)) return undefined;
        if (length === 0 || length % 3 !== 0 || length > 256 * 3) return undefined;
        palette = true;
        break;
      case "IDAT":
        if (header === undefined) return undefined;
        // パレット形式は PLTE が必須
        if (header.colorType === 3 && !palette) return undefined;
        data.push(bytes.subarray(bodyStart, bodyEnd));
        break;
      case "IEND":
        if (length !== 0) return undefined;
        ended = true;
        break;
      default:
        break;
    }
    offset = next;
    if (ended) break;
  }
  if (header === undefined || !ended || offset !== bytes.byteLength || data.length === 0) return undefined;
  // 非インターレースでは、展開後の長さは IHDR だけで決まる。ここが合わなければ寸法とデータが食い違う
  const expected = header.height * (1 + header.width * header.channels);
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  } catch {
    return undefined;
  }
  if (inflated.byteLength !== expected) return undefined;
  return { width: header.width, height: header.height };
}

export interface SharedThumbnailStore {
  /** `<id>.png` を書く。一時名へ書いてから rename する（途中のファイルを見せない） */
  write(id: string, bytes: Uint8Array): Promise<void>;
  read(id: string): Promise<Uint8Array | undefined>;
  /** 無くても成功として扱う（冪等） */
  remove(id: string): Promise<void>;
  /** 置き場にある id。ディレクトリが無ければ空 */
  listIds(): Promise<string[]>;
}

/**
 * 置き場の実装。`dir` は会話ストア直下の `shared-thumbnails` だけで、外のパスは組み立てない。
 * 名前の検査をここに閉じるため、パスを作る経路は 1 つだけになる。
 */
export function createSharedThumbnailStore(dir: string): SharedThumbnailStore {
  const pathOf = (id: string): string => {
    if (!ID_PATTERN.test(id)) throw new Error("共有物 ID が不正です");
    return join(dir, `${id}.png`);
  };
  return {
    write: async (id, bytes) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temporary = `${pathOf(id)}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, pathOf(id));
    },
    read: async (id) => {
      try {
        const buffer = await readFile(pathOf(id));
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    remove: async (id) => {
      await rm(pathOf(id), { force: true });
    },
    listIds: async () => {
      try {
        return (await readdir(dir)).flatMap((name) => {
          const id = FILE_NAME_PATTERN.exec(name)?.[1];
          return id === undefined ? [] : [id];
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}
