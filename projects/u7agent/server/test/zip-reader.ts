/**
 * テスト用の最小 ZIP パーサ。`unzip` は dev ホストにも CI の test stage にも無いため、
 * 中央ディレクトリを読んでローカルヘッダ・data descriptor・本文（inflateRaw）を突き合わせる。
 * CRC は Node 同梱の `zlib.crc32` と比べる。ステージングの検証だけを担い、`server/src/sandbox/zip.ts` の代わりにはならない。
 */
import assert from "node:assert/strict";
import { crc32 as nodeCrc32, inflateRawSync } from "node:zlib";

export interface ParsedZipEntry {
  name: string;
  /** 8 = deflate, 0 = store */
  method: number;
  /** 中央ディレクトリの general purpose bit flag */
  flags: number;
  /** ローカルヘッダの general purpose bit flag */
  localFlags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** ローカルヘッダと data descriptor の CRC / サイズが一致したか */
  descriptorMatches: boolean;
  /** 中央ディレクトリの CRC が展開後の本文と一致したか */
  crcMatches: boolean;
  /** 中央ディレクトリの DOS 時刻 / 日付をローカル時刻へ戻した値 (秒は 2 秒粒度) */
  mtime: Date;
  /** 展開後の本文 */
  data: Buffer;
}

/**
 * DOS の時刻 / 日付をローカル時刻の Date へ戻す。ZIP にタイムゾーンは無いため、書く側と同じローカル解釈にする。
 * 秒は 2 秒単位でしか持てないため、下位ビットは切り捨てる。
 */
function dosDateTimeToDate(time: number, date: number): Date {
  return new Date(
    1980 + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

/** コメントなしの ZIP を想定して EOCD から中央ディレクトリを辿る。壊れていれば assert で落ちる */
export function parseZip(buffer: Buffer): ParsedZipEntry[] {
  const eocdOffset = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocdOffset), 0x06054b50, "EOCD が末尾にない");
  assert.equal(buffer.readUInt16LE(eocdOffset + 20), 0, "コメント付きの zip は想定しない");
  const count = buffer.readUInt16LE(eocdOffset + 10);
  assert.equal(buffer.readUInt16LE(eocdOffset + 8), count, "ディスクごとの件数が一致しない");
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  assert.equal(centralOffset + centralSize, eocdOffset, "中央ディレクトリの範囲が EOCD と繋がっていない");

  const entries: ParsedZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "中央ディレクトリの署名が違う");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const mtime = dosDateTimeToDate(buffer.readUInt16LE(offset + 12), buffer.readUInt16LE(offset + 14));
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `${name}: ローカルヘッダの署名が違う`);
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    assert.equal(buffer.readUInt16LE(localOffset + 8), method, `${name}: ローカルと中央で method が違う`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    assert.equal(
      buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8"),
      name,
      "ローカルと中央で名前が違う",
    );

    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    // bit 3 のときは本文の後ろに data descriptor が続く
    const descriptorOffset = dataStart + compressedSize;
    assert.equal(buffer.readUInt32LE(descriptorOffset), 0x08074b50, `${name}: data descriptor が無い`);
    const descriptorMatches =
      buffer.readUInt32LE(descriptorOffset + 4) === crc32 &&
      buffer.readUInt32LE(descriptorOffset + 8) === compressedSize &&
      buffer.readUInt32LE(descriptorOffset + 12) === size;

    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    entries.push({
      name,
      method,
      flags,
      localFlags,
      crc32,
      compressedSize,
      size,
      descriptorMatches,
      crcMatches: crc32 === nodeCrc32(data) && size === data.length,
      mtime,
      data,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
