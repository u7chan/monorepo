// React の state updater は遅延評価されるため、その中で event.currentTarget を読むと
// 入力のたびに null 参照でツリーが落ちる (白画面)。型では防げないのでソース上で禁じる。
// コメントと文字列を伏せて括弧の対応だけを辿り、「state setter に渡した関数の中」で
// イベントを読んでいる箇所を探す (行番号を保つため改行はそのまま残す)。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** コメント・文字列・テンプレートを空白へ置き換える (括弧を数えるときの誤検出を避ける) */
function blankTrivia(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let j = i; j < stop; j++) out += source[j] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      out += " ";
      i++;
      while (i < source.length && source[i] !== char) {
        // エスケープは 2 文字まとめて飛ばす (バックスラッシュ自体は括弧ではない)
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** state setter に渡した updater の中身 (括弧の対応で切り出す) と、その位置 */
function updaters(source: string): { body: string; index: number }[] {
  const found: { body: string; index: number }[] = [];
  for (const match of source.matchAll(/set[A-Z]\w*\s*\(/g)) {
    const open = source.indexOf("(", match.index);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "(") depth++;
      if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          const body = source.slice(open, i + 1);
          // setValue(e.currentTarget.value) のような直接の値渡しは updater ではない
          if (IS_UPDATER.test(body.replace(/^\(/, ""))) found.push({ body, index: open });
          break;
        }
      }
    }
  }
  return found;
}

/** 第 1 引数が関数 (updater) か。戻り値の型注釈付きの arrow も受ける */
const IS_UPDATER = /^\s*(\([^)]*\)|\w+)\s*(?::[^=]*)?=>/;

/** updater の中でイベントを読むと、遅延評価の時点で currentTarget が null になる */
const EVENT_READ = /currentTarget|\b(event|e)\.target\b/;

test("state updater の中で event を読んでいない (遅延評価で null になるため)", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const raw = readFileSync(file, "utf8");
    const blanked = blankTrivia(raw);
    for (const { body, index } of updaters(blanked)) {
      if (!EVENT_READ.test(body)) continue;
      const line = blanked.slice(0, index).split("\n").length;
      const firstLine = raw.split("\n")[line - 1]?.trim() ?? "";
      offenders.push(`${file.replace(SRC_DIR, "src")}:${line} ${firstLine}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "イベントの値は updater の外で読んでから渡してください (例: const name = e.currentTarget.value; setForm((p) => ({ ...p, name })))",
  );
});
