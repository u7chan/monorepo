/**
 * ストリーミング ZIP ライタ。外部ライブラリも `zip` バイナリも使わない（info-zip は dev / CI の test stage に無く、
 * エントリ名のエンコーディングがロケール依存のため日本語名を保証できない）。
 * サイズを事前に確定できないため data descriptor（general purpose bit 3）で書い、
 * 名前は UTF-8 で書いて bit 11 を立てる。Zip64 は書かない（上限の検査は呼び出し側 = archive.ts の責務）。
 */
import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { createDeflateRaw } from "node:zlib";

/** store = 無圧縮。既に圧縮済みの拡張子を再度 deflate しても縮まない */
export type ZipCompression = "store" | "deflate";

export interface ZipEntry {
  /** ZIP 内のパス。ディレクトリは末尾が `/`。区切りは `/` で、UTF-8 のバイト列として書く */
  name: string;
  /** 内容を読む絶対パス。ディレクトリエントリは undefined */
  source?: string;
  /** DOS 時刻の元にする更新時刻。省略時は現在時刻 */
  mtime?: Date;
}

/** data descriptor (bit 3) と UTF-8 の名前 (bit 11) */
const GENERAL_PURPOSE_FLAGS = 0x0008 | 0x0800;

/** 最小の "version needed to extract"。deflate と data descriptor は 2.0 以上で読める */
const VERSION_NEEDED = 20;

/** version made by の上位バイト。3 = UNIX で、外部属性をパーミッションとして読ませる */
const VERSION_MADE_BY = 0x0314;

/** DOS の年月日は 1980 年起点の 7bit。表現できない値は端へ丸める */
const DOS_EPOCH_YEAR = 1980;
const DOS_MAX_YEAR = 2107;

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const DIRECTORY_ATTRIBUTES = ((0o40755 << 16) | 0x10) >>> 0;
const FILE_ATTRIBUTES = (0o644 << 16) >>> 0;

/** 名前の長さは ZIP の 16bit フィールド。溢れる前に例外にして、壊れたアーカイブを配らない */
const MAX_NAME_BYTES = 0xffff;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE)。前回の戻り値を seed に渡すと分割したバイト列へ継続できる
 * （内部で前後を反転しているため、途中経過をそのまま次の入力に使える）。
 */
export function crc32(chunk: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let index = 0; index < chunk.length; index += 1) {
    crc = (CRC32_TABLE[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 再圧縮しても縮まない拡張子。ZIP の中で無圧縮のまま置く */
const STORE_EXTENSIONS = new Set([
  // 画像
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  // 既に圧縮されたアーカイブ / 文書
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "7z",
  "rar",
  "jar",
  "pdf",
  // メディア
  "mp3",
  "mp4",
  "m4a",
  "m4v",
  "mov",
  "webm",
  "ogg",
  "opus",
  "aac",
  "flac",
  // Web フォント (woff / woff2 は内部が圧縮済み)
  "woff",
  "woff2",
]);

/** 拡張子から圧縮方法を選ぶ。拡張子なしと dotfile は deflate */
export function zipCompressionFor(name: string): ZipCompression {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "deflate";
  return STORE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase()) ? "store" : "deflate";
}

function zipMethod(compression: ZipCompression): number {
  return compression === "deflate" ? 8 : 0;
}
/** DOS の時刻 / 日付。ZIP にタイムゾーンは無いためローカル時刻で書く */
function dosDateTime(mtime: Date | undefined): { time: number; date: number } {
  const at = mtime && !Number.isNaN(mtime.getTime()) ? mtime : new Date();
  const year = Math.min(Math.max(at.getFullYear(), DOS_EPOCH_YEAR), DOS_MAX_YEAR);
  const date = ((year - DOS_EPOCH_YEAR) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  return { time, date };
}

function localFileHeader(entry: ZipEntry, fileName: Buffer, compression: ZipCompression): Buffer {
  const header = Buffer.alloc(30 + fileName.length);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(GENERAL_PURPOSE_FLAGS, 6);
  header.writeUInt16LE(zipMethod(compression), 8);
  const { time, date } = dosDateTime(entry.mtime);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  // CRC とサイズは data descriptor が持つ (bit 3)
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(0, 28);
  fileName.copy(header, 30);
  return header;
}

function dataDescriptor(crc: number, compressedSize: number, size: number): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralDirectoryHeader(input: {
  entry: ZipEntry;
  fileName: Buffer;
  isDirectory: boolean;
  compression: ZipCompression;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}): Buffer {
  const { entry, fileName, isDirectory, compression, crc, compressedSize, size, offset } = input;
  const header = Buffer.alloc(46 + fileName.length);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_MADE_BY, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(GENERAL_PURPOSE_FLAGS, 8);
  header.writeUInt16LE(zipMethod(compression), 10);
  const { time, date } = dosDateTime(entry.mtime);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(fileName.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(isDirectory ? DIRECTORY_ATTRIBUTES : FILE_ATTRIBUTES, 38);
  header.writeUInt32LE(offset, 42);
  fileName.copy(header, 46);
  return header;
}

function endOfCentralDirectory(entryCount: number, size: number, offset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(size, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

/** エントリ名は末尾 `/` をディレクトリの印にする (呼び出し側が付ける) */
function isDirectoryName(name: string): boolean {
  return name.endsWith("/");
}

/** 非圧縮のバイト数を数え、CRC を入力側で取る。deflate の前段に置くと圧縮後のバイトを CRC に使う事故を防げる */
function statBytes(stats: { size: number; crc: number }): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      stats.size += chunk.length;
      stats.crc = crc32(chunk, stats.crc);
      callback(null, chunk);
    },
  });
}

/**
 * エントリを順に書く。ファイルは `createReadStream` から流し、deflate のときだけ `createDeflateRaw` を通す。
 * 例外（読み取り失敗・切断）では途中まで書いたストリームを閉じ、ブラウザに壊れた zip として失敗させる
 * （Content-Length を確定できないため、切れた zip は異常終了として扱う）。
 */
async function* writeZip(entries: readonly ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let position = 0;

  for (const entry of entries) {
    const isDirectory = isDirectoryName(entry.name);
    const compression: ZipCompression = isDirectory ? "store" : zipCompressionFor(entry.name);
    const fileName = Buffer.from(entry.name, "utf8");
    if (fileName.length > MAX_NAME_BYTES) {
      throw new Error(`ZIP entry name is too long: ${entry.name}`);
    }

    const offset = position;
    const header = localFileHeader(entry, fileName, compression);
    position += header.length;
    yield header;

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    if (!isDirectory && entry.source) {
      const stats = { size: 0, crc: 0 };
      const source = createReadStream(entry.source);
      const statsStream = statBytes(stats);
      const body =
        compression === "deflate" ? source.pipe(statsStream).pipe(createDeflateRaw()) : source.pipe(statsStream);
      // pipe は上流の失敗を下流へ伝えない。伝えないと 'error' が未処理になってプロセスごと落ちる
      source.on("error", (error) => body.destroy(error));
      try {
        for await (const chunk of body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          compressedSize += buffer.length;
          position += buffer.length;
          yield buffer;
        }
      } finally {
        // 消費側が途中でやめた場合もファイルディスクリプタを残さない
        body.destroy();
      }
      size = stats.size;
      crc = stats.crc;
    }

    const descriptor = dataDescriptor(crc, compressedSize, size);
    position += descriptor.length;
    yield descriptor;
    central.push(
      centralDirectoryHeader({ entry, fileName, isDirectory, compression, crc, compressedSize, size, offset }),
    );
  }

  const centralOffset = position;
  let centralSize = 0;
  for (const record of central) {
    centralSize += record.length;
    yield record;
  }
  yield endOfCentralDirectory(central.length, centralSize, centralOffset);
}

/** ZIP のバイト列をストリームで返す。`Readable.from` は消費側の速度に合わせて次のエントリを読む */
export function createZipStream(entries: readonly ZipEntry[]): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(writeZip(entries), { objectMode: false })) as ReadableStream<Uint8Array>;
}
