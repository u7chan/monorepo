// ADR が番号ではなくトピック名で並び、削除した判断への番号参照が残らないことを固定する。
// 番号は並列ブランチで重複し、付け直すとコードコメントが黙って別の判断を指すため。
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const adrDir = join(root, "docs/adr");
const adrNames = readdirSync(adrDir).filter((name) => name.endsWith(".md"));

const ROOT_FILES = ["AGENTS.md", "README.md", "DESIGN.md"];
const SCAN_DIRS = ["src", "test", "scripts", "docs", ".agents"];
const SCAN_EXTENSIONS = [".ts", ".tsx", ".mjs", ".css", ".md"];

function walk(dir: string): string[] {
  const path = join(root, dir);

  if (!existsSync(path)) {
    return [];
  }

  if (statSync(path).isFile()) {
    return [path];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);

    return entry.isDirectory() ? walk(join(dir, entry.name)) : [child];
  });
}

const scannedFiles = [
  ...ROOT_FILES.map((file) => join(root, file)).filter((file) => existsSync(file)),
  ...SCAN_DIRS.flatMap(walk),
].filter((file) => SCAN_EXTENSIONS.some((extension) => file.endsWith(extension)));

/** フェンス付きコードブロックの中は、例示として番号を書いてよい。リスト内のインデントも受ける。 */
function withoutFencedCode(text: string): string {
  return text.replace(/^([ \t]*)```[^\n]*\n[\s\S]*?^\1```[^\n]*$/gm, "");
}

describe("ADR", () => {
  test("ファイル名は番号を持たない小文字 kebab-case にする", () => {
    expect(adrNames.length).toBeGreaterThan(0);

    for (const name of adrNames) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*\.md$/);
    }
  });

  test("見出しと accepted / proposed の Status を持つ", () => {
    for (const name of adrNames) {
      const text = readFileSync(join(adrDir, name), "utf8");

      expect(text, name).toMatch(/^# \S/m);
      expect(text, name).toMatch(/^- Status: (accepted|proposed)$/m);
    }
  });

  test("番号で ADR を参照しない", () => {
    const offenders = scannedFiles.flatMap((file) => {
      const text = withoutFencedCode(readFileSync(file, "utf8"));

      return /ADR\s*-?\s*\d{3,4}/.test(text) ? [file.slice(root.length + 1)] : [];
    });

    expect(offenders).toEqual([]);
  });

  test("参照する docs/adr/ のパスは実在する", () => {
    const missing = scannedFiles.flatMap((file) => {
      const text = readFileSync(file, "utf8");

      return [...text.matchAll(/docs\/adr\/([a-z0-9-]+\.md)/g)]
        .map((match) => match[1])
        .filter((name) => name !== undefined && !existsSync(join(adrDir, name)))
        .map((name) => `${file.slice(root.length + 1)}: 存在しない ADR: ${name}`);
    });

    expect(missing).toEqual([]);
  });
});
