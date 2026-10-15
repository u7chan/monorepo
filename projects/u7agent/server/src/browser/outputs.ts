/**
 * 成果物の保存と出力の切り詰め。既存のファイルは上書きせず、`name-1.png` のような一意な名前で cwd へ保存し、
 * **実際に保存した cwd 相対パス**を返す (要求されたパスを返すと `read` と Markdown で二重に解決される)。
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";

/** 保存できる形式。`shot` が返すのは PNG だけなので、拡張子と中身を一致させる */
export const OUTPUT_EXTENSION = ".png";

/** 連番で空きが見つからないときの上限。超えたらランダムな suffix へ切り替える */
const MAX_NUMBERED_ATTEMPTS = 100;

export interface SavedOutput {
  /** 呼び出し元が `read` と Markdown にそのまま使う cwd 相対パス */
  path: string;
  absolutePath: string;
  bytes: number;
}

/** 保存名として受け付けない形を実行前に落とす。絶対パスと cwd の外は保存先にしない */
export function validateOutputName(name: string): string {
  if (name.length === 0) throw new Error("保存先のファイル名が空です");
  if (isAbsolute(name)) throw new Error(`絶対パスへは保存できません: ${name}`);
  // 区切りは `/` だけにする (バックスラッシュは Linux では名前の一部になり、返すパスが読みにくくなる)
  if (name.includes("\\")) throw new Error(`保存先に \\ は使えません: ${name}`);
  if (name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`保存先に . と .. と空の要素は使えません: ${name}`);
  }
  if (extname(name).toLowerCase() !== OUTPUT_EXTENSION) {
    throw new Error(`保存できるのは ${OUTPUT_EXTENSION} だけです: ${name}`);
  }
  return name;
}

/**
 * 空いている保存名の候補。連番を振り切ったらランダム suffix にする (上限で永久に失敗させない)。
 * 候補を進める判定は書き込みの `EEXIST` で行うので、並行する呼び出し同士でも上書きしない。
 */
export function* outputCandidateNames(name: string): Generator<string> {
  yield name;
  const extension = extname(name);
  const base = name.slice(0, name.length - extension.length);
  for (let index = 1; index <= MAX_NUMBERED_ATTEMPTS; index += 1) yield `${base}-${index}${extension}`;
  for (;;) yield `${base}-${randomUUID().slice(0, 8)}${extension}`;
}

/** cwd 配下へ排他作成する。親ディレクトリは作る (成果物をサブディレクトリへ分けられるようにする) */
export async function saveOutput(cwd: string, name: string, data: Uint8Array): Promise<SavedOutput> {
  validateOutputName(name);
  const absolutePath = join(cwd, name);
  await mkdir(dirname(absolutePath), { recursive: true });
  for (const candidate of outputCandidateNames(name)) {
    const target = join(cwd, candidate);
    try {
      // "wx" は O_EXCL。既存があれば EEXIST になるので、連番の候補を次へ進めるだけで上書きしない
      await writeFile(target, data, { flag: "wx" });
      return { path: relative(cwd, target).split(sep).join("/"), absolutePath: target, bytes: data.byteLength };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`保存名を決められませんでした: ${name}`);
}

/**
 * バイト数の上限で切り詰める。切れ目が UTF-8 の途中なら先頭バイトまで戻す (壊れた文字を出さない)。
 */
export function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

/** 本文の行を上限まで残し、最後に `tail` (要約行) を必ず残す */
export function capLines(lines: readonly string[], tail: string, maxBytes: number): string {
  const notice = "... 出力の上限に達したため残りを省略しました";
  const kept: string[] = [];
  const size = (entries: readonly string[]) => Buffer.byteLength([...entries, tail, ""].join("\n"), "utf8");
  for (const line of lines) {
    if (size([...kept, line, notice]) > maxBytes) {
      kept.push(notice);
      break;
    }
    kept.push(line);
  }
  return [...kept, tail].join("\n");
}
