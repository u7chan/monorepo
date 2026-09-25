/**
 * ファイルツリーの行のドラッグを、入力欄へ挿す参照 (`@<作業フォルダ相対のパス>`) に変換する純関数。
 * 添付 (アップロード) とは別経路で、本文の展開はしない (モデルが必要なときに `read` で開く)。
 */

/** ツリーの行が積むドラッグの型。OS からのファイル (`Files`) と区別する */
export const FILE_MENTION_MIME = "application/x-u7agent-file-mention";

/** 入力欄が受けたドロップの種類。対象外のドラッグは null (何もしない) */
export type ComposerDropKind = "mention" | "files";

/** ドラッグの型から入力欄の扱いを決める。参照は添付より優先する (参照のドラッグに `Files` は入らない) */
export function composerDropKind(types: readonly string[]): ComposerDropKind | null {
  if (types.includes(FILE_MENTION_MIME)) return "mention";
  if (types.includes("Files")) return "files";
  return null;
}

/** 本文へ挿す参照の字面。区切りの空白は insertFileMention が入れる */
export function mentionText(path: string): string {
  return `@${path}`;
}

export type MentionInsertion = {
  value: string;
  /** 挿入後のカーソル位置 (参照の直後) */
  caret: number;
};

/**
 * 選択範囲 (`start`–`end`) を参照で置き換える。前後が非空白なら区切りの空白を足し、カーソルは参照の直後へ。
 * 末尾の空白は続きを書けるようにするためで、送信時に trim される。
 */
export function insertFileMention(value: string, path: string, start: number, end: number): MentionInsertion {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = before !== "" && !/\s$/.test(before) ? " " : "";
  const suffix = /^\s/.test(after) ? "" : " ";
  const text = `${prefix}${mentionText(path)}${suffix}`;
  return { value: `${before}${text}${after}`, caret: before.length + text.length };
}
