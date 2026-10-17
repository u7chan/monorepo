/**
 * 取り込み用の ZIP リーダ。外部ライブラリも `unzip` バイナリも使わない (dev / CI の test stage に無く、
 * エントリ名のエンコーディングもロケール依存)。中央ディレクトリを起点に読み、store / deflate だけを扱う。
 * 形式の検証 (署名・暗号化・Zip64・未対応圧縮・CRC・サイズ・切り詰め) はここに閉じ、
 * パスやスキルとしての妥当性は呼び出し側 (service) が判定する。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import type { ArchiveLimits } from "./archive";
import { crc32 } from "./zip";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const GENERAL_PURPOSE_ENCRYPTED = 0x0001;
const GENERAL_PURPOSE_DATA_DESCRIPTOR = 0x0008;
const GENERAL_PURPOSE_STRONG_ENCRYPTION = 0x0040;
const GENERAL_PURPOSE_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const ZIP64_EXTRA_FIELD_ID = 0x0001;
const AES_EXTRA_FIELD_ID = 0x9901;

const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_DIRECTORY_ENTRY_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

/** 不正なアーカイブは 400 (形式の検証) で断る。上限超過だけは呼び出し側が 413 にする */
export function zipReadError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function zipTooLargeError(maxBytes: number): Error & { statusCode: number } {
  return Object.assign(new Error(`Import archive is too large (max ${maxBytes} bytes)`), { statusCode: 413 });
}

function zipTooManyEntriesError(maxEntries: number): Error & { statusCode: number } {
  return Object.assign(new Error(`Import archive has too many entries (max ${maxEntries})`), { statusCode: 413 });
}

/** 中央ディレクトリから読んだ 1 エントリ。本文の位置と期待値だけを持ち、展開は extractZipEntry が行う */
export interface ZipReadEntry {
  /** ZIP 内のパス。ディレクトリは末尾が `/` のまま入る */
  name: string;
  isDirectory: boolean;
  /** 0 = store, 8 = deflate */
  compression: number;
  /** general purpose bit flag (bit 3 = data descriptor, bit 11 = UTF-8) */
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** ローカルヘッダのファイル位置 */
  localHeaderOffset: number;
  /** 中央ディレクトリの external attributes の上位 16bit (version made by が UNIX のときだけ)。symlink の判定に使う */
  unixMode: number | undefined;
}

export interface ZipReadArchive {
  entries: ZipReadEntry[];
  /** 検証に使ったエントリ数 (ディレクトリを含む) */
  entryCount: number;
  /** 中央ディレクトリの非圧縮サイズの合計 */
  bytes: number;
  /** 本文が置ける範囲の終端 (中央ディレクトリの位置)。本文がこれを越える要求は壊れたアーカイブ */
  dataLimit: number;
}

export interface ZipExtractedEntry {
  /** 展開したバイト列の SHA-256 (hex) */
  digest: string;
  size: number;
}

/** ファイルの位置から exactly 読む。EOF に達したら切り詰めとして 400 にする */
async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) throw zipReadError("Invalid ZIP archive: the archive is truncated");
    read += result.bytesRead;
  }
  return buffer;
}

/** Zip64 の extra field (id 0x0001) と AES 暗号化の extra field (id 0x9901) を探す */
function hasUnsupportedExtraField(extra: Buffer): boolean {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (id === ZIP64_EXTRA_FIELD_ID) return true;
    if (id === AES_EXTRA_FIELD_ID) return true;
    offset += 4 + size;
  }
  return false;
}

/**
 * 名前のバイト列を UTF-8 として厳密に読む。bit 11 が無い名前は ASCII だけを受け付ける
 * (cp437 などの非 ASCII 名を勝手に解釈しない)。
 */
function decodeEntryName(bytes: Buffer, flags: number): string {
  if ((flags & GENERAL_PURPOSE_UTF8) === 0 && bytes.some((byte) => byte >= 0x80)) {
    throw zipReadError("Invalid ZIP archive: non-ASCII entry names must be flagged as UTF-8");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw zipReadError("Invalid ZIP archive: entry names must be valid UTF-8");
  }
}

/** 末尾コメントの範囲から EOCD を探す。見つからなければ壊れたアーカイブとして 400 にする */
async function findEndOfCentralDirectory(handle: FileHandle, fileSize: number): Promise<number> {
  if (fileSize < END_OF_CENTRAL_DIRECTORY_SIZE) {
    throw zipReadError("Invalid ZIP archive: the archive is too small");
  }
  const tailSize = Math.min(fileSize, END_OF_CENTRAL_DIRECTORY_SIZE + MAX_COMMENT_BYTES);
  const tail = await readExact(handle, tailSize, fileSize - tailSize);
  for (let index = tailSize - END_OF_CENTRAL_DIRECTORY_SIZE; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    // コメント長が実ファイルの末尾と一致する位置だけを EOCD と見る (本文中の署名を拾わない)
    if (fileSize - tailSize + index + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength === fileSize) {
      return fileSize - tailSize + index;
    }
  }
  throw zipReadError("Invalid ZIP archive: end of central directory not found");
}

/**
 * 中央ディレクトリを読み、エントリの一覧と上限の判定を返す。本文は読まない。
 * 上限 (件数 / 合計サイズ) は 413 で断り、形式不正は 400 にする。
 */
export async function readZipArchive(path: string, limits: ArchiveLimits): Promise<ZipReadArchive> {
  const handle = await open(path, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const eocdOffset = await findEndOfCentralDirectory(handle, fileSize);
    const eocd = await readExact(handle, END_OF_CENTRAL_DIRECTORY_SIZE, eocdOffset);
    const diskNumber = eocd.readUInt16LE(4);
    const centralDiskNumber = eocd.readUInt16LE(6);
    const entriesOnDisk = eocd.readUInt16LE(8);
    const entryCount = eocd.readUInt16LE(10);
    const centralSize = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);
    if (diskNumber !== 0 || centralDiskNumber !== 0) {
      throw zipReadError("Invalid ZIP archive: multi-disk archives are not supported");
    }
    if (entriesOnDisk !== entryCount) {
      throw zipReadError("Invalid ZIP archive: the entry counts do not match");
    }
    if (entryCount === ZIP64_SENTINEL_16 || centralSize === ZIP64_SENTINEL_32 || centralOffset === ZIP64_SENTINEL_32) {
      throw zipReadError("Invalid ZIP archive: Zip64 is not supported");
    }
    if (eocdOffset >= 20) {
      const locator = await readExact(handle, 4, eocdOffset - 20);
      if (locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE) {
        throw zipReadError("Invalid ZIP archive: Zip64 is not supported");
      }
    }
    if (centralOffset + centralSize !== eocdOffset) {
      throw zipReadError("Invalid ZIP archive: the central directory range does not match the file");
    }
    const central = await readExact(handle, centralSize, centralOffset);

    const entries: ZipReadEntry[] = [];
    let bytes = 0;
    let offset = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + CENTRAL_DIRECTORY_ENTRY_SIZE > central.length) {
        throw zipReadError("Invalid ZIP archive: the central directory is truncated");
      }
      if (central.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw zipReadError("Invalid ZIP archive: the central directory signature is invalid");
      }
      const versionMadeBy = central.readUInt16LE(offset + 4);
      const flags = central.readUInt16LE(offset + 8);
      const compression = central.readUInt16LE(offset + 10);
      const crc = central.readUInt32LE(offset + 16);
      const compressedSize = central.readUInt32LE(offset + 20);
      const size = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const startDisk = central.readUInt16LE(offset + 34);
      const externalAttributes = central.readUInt32LE(offset + 38);
      const localHeaderOffset = central.readUInt32LE(offset + 42);
      if (offset + CENTRAL_DIRECTORY_ENTRY_SIZE + nameLength + extraLength + commentLength > central.length) {
        throw zipReadError("Invalid ZIP archive: the central directory is truncated");
      }
      if ((flags & GENERAL_PURPOSE_ENCRYPTED) !== 0 || (flags & GENERAL_PURPOSE_STRONG_ENCRYPTION) !== 0) {
        throw zipReadError("Invalid ZIP archive: encrypted entries are not supported");
      }
      if (compression !== METHOD_STORE && compression !== METHOD_DEFLATE) {
        throw zipReadError(`Invalid ZIP archive: unsupported compression method ${compression}`);
      }
      if (
        compressedSize === ZIP64_SENTINEL_32 ||
        size === ZIP64_SENTINEL_32 ||
        localHeaderOffset === ZIP64_SENTINEL_32
      ) {
        throw zipReadError("Invalid ZIP archive: Zip64 is not supported");
      }
      if (startDisk !== 0) throw zipReadError("Invalid ZIP archive: multi-disk archives are not supported");
      const nameStart = offset + CENTRAL_DIRECTORY_ENTRY_SIZE;
      const extra = central.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
      if (hasUnsupportedExtraField(extra)) {
        throw zipReadError("Invalid ZIP archive: Zip64 and AES entries are not supported");
      }
      const name = decodeEntryName(central.subarray(nameStart, nameStart + nameLength), flags);
      const unixMode = versionMadeBy >> 8 === 3 ? externalAttributes >>> 16 : undefined;
      const isDirectory = name.endsWith("/") || (unixMode !== undefined && (unixMode & 0o170000) === 0o040000);
      if (isDirectory && (size !== 0 || compressedSize !== 0)) {
        throw zipReadError(`Invalid ZIP archive: a directory entry has data: ${name}`);
      }
      if (localHeaderOffset + LOCAL_FILE_HEADER_SIZE > centralOffset) {
        throw zipReadError(`Invalid ZIP archive: the local header is out of range: ${name}`);
      }
      entries.push({
        name,
        isDirectory,
        compression,
        flags,
        crc32: crc,
        compressedSize,
        size,
        localHeaderOffset,
        unixMode,
      });
      if (!isDirectory) bytes += size;
      if (entries.length > limits.maxEntries) throw zipTooManyEntriesError(limits.maxEntries);
      if (bytes > limits.maxBytes) throw zipTooLargeError(limits.maxBytes);
      offset += CENTRAL_DIRECTORY_ENTRY_SIZE + nameLength + extraLength + commentLength;
    }
    if (offset !== central.length) {
      throw zipReadError("Invalid ZIP archive: the central directory has trailing bytes");
    }
    return { entries, entryCount: entries.length, bytes, dataLimit: centralOffset };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** data descriptor (bit 3) の CRC / サイズと中央ディレクトリの値を突き合わせる */
async function verifyDataDescriptor(
  handle: FileHandle,
  entry: ZipReadEntry,
  dataEnd: number,
  fileSize: number,
): Promise<void> {
  const available = fileSize - dataEnd;
  if (available < 12) throw zipReadError(`Invalid ZIP archive: the data descriptor is missing: ${entry.name}`);
  const length = Math.min(24, available);
  const descriptor = await readExact(handle, length, dataEnd);
  const start = descriptor.readUInt32LE(0) === DATA_DESCRIPTOR_SIGNATURE ? 4 : 0;
  if (descriptor.length < start + 12) {
    throw zipReadError(`Invalid ZIP archive: the data descriptor is truncated: ${entry.name}`);
  }
  const match =
    descriptor.readUInt32LE(start) === entry.crc32 &&
    descriptor.readUInt32LE(start + 4) === entry.compressedSize &&
    descriptor.readUInt32LE(start + 8) === entry.size;
  if (!match) throw zipReadError(`Invalid ZIP archive: the data descriptor does not match: ${entry.name}`);
}

/** 展開したバイト数を数えながら CRC と SHA-256 を取る。中央ディレクトリのサイズを越えたら即座に止める */
function inspectBytes(
  entry: ZipReadEntry,
  hash: ReturnType<typeof createHash>,
): { transform: Transform; stats: () => { size: number; crc: number } } {
  const state = { size: 0, crc: 0 };
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      state.size += chunk.length;
      if (state.size > entry.size) {
        callback(zipReadError(`Invalid ZIP archive: the entry expands beyond its size: ${entry.name}`));
        return;
      }
      state.crc = crc32(chunk, state.crc);
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { transform, stats: () => state };
}

/**
 * 1 エントリを展開して `target` へ書く。ローカルヘッダと data descriptor の一致、
 * 展開結果の CRC / サイズの一致まで確認し、不一致は壊れたアーカイブとして 400 にする。
 */
export async function extractZipEntry(input: {
  archive: string;
  entry: ZipReadEntry;
  target: string;
  /** 本文が置ける終端 (中央ディレクトリの位置)。越える要求は壊れたアーカイブ */
  dataLimit: number;
}): Promise<ZipExtractedEntry> {
  const { entry } = input;
  const handle = await open(input.archive, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const local = await readExact(handle, LOCAL_FILE_HEADER_SIZE, entry.localHeaderOffset);
    if (local.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw zipReadError(`Invalid ZIP archive: the local header signature is invalid: ${entry.name}`);
    }
    const localFlags = local.readUInt16LE(6);
    const localCompression = local.readUInt16LE(8);
    const localCrc = local.readUInt32LE(14);
    const localCompressedSize = local.readUInt32LE(18);
    const localSize = local.readUInt32LE(22);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    if (localCompression !== entry.compression) {
      throw zipReadError(`Invalid ZIP archive: the compression methods do not match: ${entry.name}`);
    }
    const nameBytes = await readExact(handle, nameLength, entry.localHeaderOffset + LOCAL_FILE_HEADER_SIZE);
    if (nameBytes.toString("utf8") !== entry.name) {
      throw zipReadError(`Invalid ZIP archive: the entry names do not match: ${entry.name}`);
    }
    const extra = await readExact(handle, extraLength, entry.localHeaderOffset + LOCAL_FILE_HEADER_SIZE + nameLength);
    if (hasUnsupportedExtraField(extra)) {
      throw zipReadError("Invalid ZIP archive: Zip64 and AES entries are not supported");
    }
    const dataStart = entry.localHeaderOffset + LOCAL_FILE_HEADER_SIZE + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > input.dataLimit || dataEnd > fileSize) {
      throw zipReadError(`Invalid ZIP archive: the entry data is truncated: ${entry.name}`);
    }
    const hasDescriptor =
      (entry.flags & GENERAL_PURPOSE_DATA_DESCRIPTOR) !== 0 || (localFlags & GENERAL_PURPOSE_DATA_DESCRIPTOR) !== 0;
    if (!hasDescriptor) {
      // bit 3 が無い形式はローカルヘッダの CRC / サイズが本文の正 (中央ディレクトリと一致することを要求する)
      if (localCrc !== entry.crc32 || localCompressedSize !== entry.compressedSize || localSize !== entry.size) {
        throw zipReadError(`Invalid ZIP archive: the local header does not match: ${entry.name}`);
      }
    } else {
      await verifyDataDescriptor(handle, entry, dataEnd, fileSize);
    }

    const hash = createHash("sha256");
    if (entry.isDirectory) {
      await mkdir(input.target, { recursive: true });
      return { digest: hash.digest("hex"), size: 0 };
    }
    await mkdir(dirname(input.target), { recursive: true });
    if (entry.compressedSize > 0) {
      const source = createReadStream(input.archive, { start: dataStart, end: dataEnd - 1 });
      const { transform, stats } = inspectBytes(entry, hash);
      const body =
        entry.compression === METHOD_DEFLATE ? source.pipe(createInflateRaw()).pipe(transform) : source.pipe(transform);
      // pipe は上流の失敗を下流へ伝えない。伝えないと 'error' が未処理になってプロセスごと落ちる
      source.on("error", (error) => body.destroy(error));
      try {
        await pipeline(body, createWriteStream(input.target, { flags: "wx" }));
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 400) throw error;
        throw zipReadError(
          `Invalid ZIP archive: cannot extract ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const { size, crc } = stats();
      if (size !== entry.size) throw zipReadError(`Invalid ZIP archive: the entry size does not match: ${entry.name}`);
      if (crc !== entry.crc32) throw zipReadError(`Invalid ZIP archive: the CRC-32 does not match: ${entry.name}`);
      return { digest: hash.digest("hex"), size };
    }
    await pipeline(Readable.from([]), createWriteStream(input.target, { flags: "wx" }));
    if (entry.size !== 0) throw zipReadError(`Invalid ZIP archive: the entry size does not match: ${entry.name}`);
    if (entry.crc32 !== 0) throw zipReadError(`Invalid ZIP archive: the CRC-32 does not match: ${entry.name}`);
    return { digest: hash.digest("hex"), size: 0 };
  } finally {
    await handle.close().catch(() => {});
  }
}
