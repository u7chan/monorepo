/**
 * 取り込みテスト用の ZIP 組み立て。`server/src/sandbox/zip.ts` の writer では作れない形式
 * (data descriptor なし・暗号化フラグ・Zip64・symlink の外部属性・壊れた CRC / サイズ) を意図的に作り、
 * src の reader が受け付ける / 断る形式をテスト側から固定する。
 */
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/sandbox/zip";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

export interface ZipFixtureEntry {
  /** ディレクトリは末尾 `/` */
  name: string;
  data?: string | Buffer;
  /** 既定は store (無圧縮) */
  compression?: "store" | "deflate";
  /** data descriptor (bit 3) を付けるか。既定 true */
  descriptor?: boolean;
  /** bit 11 (UTF-8 名) を立てるか。既定 true */
  utf8?: boolean;
  /** 暗号化フラグ (bit 0) を立てる */
  encrypted?: boolean;
  /** 中央ディレクトリの external attributes (上位 16bit に UNIX mode) */
  externalAttributes?: number;
  /** version made by を DOS (0) にする */
  dosAttributes?: boolean;
  /** 圧縮方法を上書きする (未対応の method を作る) */
  method?: number;
  /** 中央ディレクトリに書く CRC (壊れた値を作る) */
  crcOverride?: number;
  /** ローカルヘッダにだけ書く CRC (central との不一致を作る。descriptor 無しのときだけ) */
  localCrcOverride?: number;
  /** ローカルヘッダにだけ書く非圧縮サイズ (central との不一致を作る。descriptor 無しのときだけ) */
  localSizeOverride?: number;
  /** data descriptor にだけ書く CRC (central との不一致を作る) */
  descriptorCrcOverride?: number;
  /** 中央ディレクトリに書く非圧縮サイズの上書き */
  sizeOverride?: number;
  /** 中央ディレクトリに書く圧縮サイズの上書き */
  compressedSizeOverride?: number;
  /** 中央ディレクトリの extra field */
  centralExtra?: Buffer;
  /** ローカルヘッダの extra field */
  localExtra?: Buffer;
}

export interface ZipFixtureOptions {
  /** EOCD の件数を 0xffff にして Zip64 を偽装する */
  zip64?: boolean;
  /** EOCD の直前に Zip64 EOCD locator を挿す */
  zip64Locator?: boolean;
  /** EOCD のコメント */
  comment?: string;
  /** 末尾から切り落とすバイト数 */
  truncate?: number;
}

/** 指定した形式の ZIP バイト列を組み立てる (テストの都合で最小限のフィールドだけ書く) */
export function buildZip(entries: readonly ZipFixtureEntry[], options: ZipFixtureOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const isDirectory = entry.name.endsWith("/");
    const content = isDirectory ? Buffer.alloc(0) : Buffer.from(entry.data ?? "");
    const compression = entry.compression ?? "store";
    const compressed = compression === "deflate" ? deflateRawSync(content) : content;
    const descriptor = entry.descriptor ?? true;
    const flags =
      (descriptor ? 0x0008 : 0) | ((entry.utf8 ?? true) ? 0x0800 : 0) | ((entry.encrypted ?? false) ? 0x0001 : 0);
    const method = entry.method ?? (compression === "deflate" ? 8 : 0);
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = entry.crcOverride ?? crc32(content);
    const size = entry.sizeOverride ?? content.length;
    const compressedSize = entry.compressedSizeOverride ?? compressed.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    // DOS 時刻は 2024-01-01 00:00:00 (値そのものは検証しない)
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE((44 << 9) | (1 << 5) | 1, 12);
    if (descriptor) {
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(0, 18);
      local.writeUInt32LE(0, 22);
    } else {
      local.writeUInt32LE(entry.localCrcOverride ?? crc, 14);
      local.writeUInt32LE(compressedSize, 18);
      local.writeUInt32LE(entry.localSizeOverride ?? size, 22);
    }
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(entry.localExtra?.length ?? 0, 28);
    const parts = [local, nameBytes, entry.localExtra ?? Buffer.alloc(0), compressed];
    if (descriptor) {
      const descriptorBuffer = Buffer.alloc(16);
      descriptorBuffer.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
      descriptorBuffer.writeUInt32LE(entry.descriptorCrcOverride ?? crc, 4);
      descriptorBuffer.writeUInt32LE(compressedSize, 8);
      descriptorBuffer.writeUInt32LE(size, 12);
      parts.push(descriptorBuffer);
    }
    const localBuffer = Buffer.concat(parts);
    locals.push(localBuffer);

    const externalAttributes =
      entry.externalAttributes ?? (isDirectory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    central.writeUInt16LE(entry.dosAttributes ? 0x0014 : 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE((44 << 9) | (1 << 5) | 1, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(entry.centralExtra?.length ?? 0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes, entry.centralExtra ?? Buffer.alloc(0)]));
    offset += localBuffer.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  const count = options.zip64 ? 0xffff : entries.length;
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  eocd.writeUInt16LE(comment.length, 20);

  const locator = Buffer.alloc(20);
  if (options.zip64Locator) locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
  const tail = options.zip64Locator ? locator : Buffer.alloc(0);
  const buffer = Buffer.concat([...locals, centralBuffer, tail, eocd, comment]);
  return options.truncate ? buffer.subarray(0, buffer.length - options.truncate) : buffer;
}

/** スキル 1 件分 (SKILL.md + 付随ファイル) のエントリを組む */
export function skillEntries(
  name: string,
  files: Record<string, string>,
  options: Partial<ZipFixtureEntry> = {},
): ZipFixtureEntry[] {
  const entries: ZipFixtureEntry[] = [{ name: `${name}/`, ...options }];
  for (const [path, data] of Object.entries(files)) {
    entries.push({ name: `${name}/${path}`, data, ...options });
  }
  return entries;
}
