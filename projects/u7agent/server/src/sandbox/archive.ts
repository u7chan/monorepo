/**
 * ダウンロードの事前走査（walk）と ZIP の組み立て。除外（ベース名の完全一致・全階層）と symlink の除外、
 * 上限の検査を 1 つの走査に閉じ、事前チェック（check）と本文送出（download）で同じ結果を使う。
 * ヘッダを送る前にここで例外にすることで、上限超過を「切れた zip」ではなく 413 で返せる。
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_MAX_ARCHIVE_BYTES, SANDBOX_MAX_ARCHIVE_ENTRIES } from "./protocol";
import { zipCompressionFor, type ZipCompression, type ZipEntry } from "./zip";

/** 上限の判定に使う値。テストで小さくできるよう引数で受ける */
export interface ArchiveLimits {
  maxBytes: number;
  maxEntries: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxBytes: SANDBOX_MAX_ARCHIVE_BYTES,
  maxEntries: SANDBOX_MAX_ARCHIVE_ENTRIES,
};

export interface ArchiveFileEntry extends ZipEntry {
  /** 非圧縮のサイズ。`ZipEntry` には持たせない（書き出しは実測値を使う） */
  size: number;
  compression: ZipCompression;
}

export interface ArchivePlan {
  /** ZIP に入れるエントリ（ディレクトリは末尾 `/`、親が先） */
  entries: ArchiveFileEntry[];
  /** ZIP のエントリ数（EOCD の件数は 16bit のため上限で抑える） */
  entryCount: number;
  /** 含めるファイルの合計サイズ */
  bytes: number;
  /** 除外規則で落とした名前（重複なし・規則の順） */
  skipped: string[];
}

function archiveError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** 単体ファイルと ZIP で同じ文言を使う（利用者にとっては「大きすぎて持ち出せない」の 1 種類） */
export function archiveTooLargeError(maxBytes: number): Error & { statusCode: number } {
  return archiveError(413, `Download is too large (max ${maxBytes} bytes)`);
}

export function archiveTooManyEntriesError(maxEntries: number): Error & { statusCode: number } {
  return archiveError(413, `Download has too many entries (max ${maxEntries})`);
}

export function archiveExcludedDirectoryError(name: string): Error & { statusCode: number } {
  return archiveError(400, `Directory is excluded from archives: ${name}`);
}

/** ディレクトリの走査順。readdir の順序は環境依存なので、ディレクトリ先 → 大文字小文字を無視した名前順に固定する */
function compareDirents(
  a: { name: string; isDirectory(): boolean },
  b: { name: string; isDirectory(): boolean },
): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  const ignoringCase = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (ignoringCase !== 0) return ignoringCase;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * `dir` 配下を走査して ZIP のエントリ一覧を作る。除外名は全階層で落とし、symlink は辿らずエントリにも入れない
 * （root 外を指すリンクを埋め込むと、root 内に閉じる検証を迂回する）。空ディレクトリは末尾 `/` のエントリとして残す。
 */
export async function walkArchive(input: {
  /** アーカイブ対象の実ディレクトリ（realpath 済みで root 内） */
  dir: string;
  /** 実効の除外名 */
  excludeNames: readonly string[];
  limits?: ArchiveLimits;
}): Promise<ArchivePlan> {
  const { dir, excludeNames } = input;
  const limits = input.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const exclude = new Set(excludeNames);
  const seen = new Set<string>();
  const plan: ArchivePlan = { entries: [], entryCount: 0, bytes: 0, skipped: [] };

  const addEntry = (entry: ArchiveFileEntry, size: number): void => {
    plan.entryCount += 1;
    if (plan.entryCount > limits.maxEntries) throw archiveTooManyEntriesError(limits.maxEntries);
    plan.bytes += size;
    if (plan.bytes > limits.maxBytes) throw archiveTooLargeError(limits.maxBytes);
    plan.entries.push(entry);
  };

  const visit = async (current: string, prefix: string): Promise<void> => {
    const dirents = await readdir(current, { withFileTypes: true }).catch((error: unknown) => {
      throw archiveError(400, `Cannot read directory: ${error instanceof Error ? error.message : String(error)}`);
    });
    for (const dirent of [...dirents].sort(compareDirents)) {
      const name = dirent.name;
      if (exclude.has(name)) {
        seen.add(name);
        continue;
      }
      const target = join(current, name);
      const zipName = prefix ? `${prefix}/${name}` : name;
      if (dirent.isDirectory()) {
        // 親を先に置き、空ディレクトリは末尾 `/` のエントリとして残す（入れないと展開後に消える）
        addEntry({ name: `${zipName}/`, size: 0, compression: "store" }, 0);
        await visit(target, zipName);
        continue;
      }
      // symlink と特殊ファイル（socket / fifo / device）はエントリに入れない
      if (!dirent.isFile()) continue;
      const stats = await lstat(target).catch((error: unknown) => {
        throw archiveError(400, `Cannot read file: ${error instanceof Error ? error.message : String(error)}`);
      });
      addEntry(
        {
          name: zipName,
          source: target,
          // 展開後に mtime で増分を判断するツール (make など) が使えるよう、元ファイルの更新時刻を書く
          mtime: stats.mtime,
          size: stats.size,
          compression: zipCompressionFor(zipName),
        },
        stats.size,
      );
    }
  };

  await visit(dir, "");
  // 除外名は規則の順で返す（確認ダイアログの文言を走査順に依存させない）
  plan.skipped = excludeNames.filter((name) => seen.has(name));
  return plan;
}

/** RFC 5987 の attr-char 以外を落とす。`encodeURIComponent` は `'` `(` `)` `*` を素通しするため個別に潰す */
function encodeFileNameStar(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `Content-Disposition: attachment`。日本語名は filename* で UTF-8 のまま渡す（`filename=` は付けない） */
export function archiveContentDisposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeFileNameStar(name)}`;
}

/** ディレクトリのダウンロード名。`<フォルダ名>.zip` で、root のときは解決後の実ディレクトリ名を使う */
export function archiveDownloadName(folderName: string): string {
  return `${folderName}.zip`;
}
