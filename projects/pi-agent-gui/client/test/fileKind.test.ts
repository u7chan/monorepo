// ファイルツリーの行に出すアイコンの模様: 拡張子と慣用名から種類を引く (ドットファイルと未知の拡張子は既定)。
import assert from "node:assert/strict";
import test from "node:test";
import { fileKind, type FileKind } from "../src/lib/fileKind";

test("拡張子から種類を決める", () => {
  const cases: [string, FileKind][] = [
    ["App.tsx", "code"],
    ["main.TS", "code"],
    ["index.html", "markup"],
    ["icon.svg", "markup"],
    ["index.css", "style"],
    ["package.json", "data"],
    ["config.toml", "data"],
    ["logo.png", "image"],
    ["photo.JPEG", "image"],
    ["run.sh", "shell"],
    ["Dockerfile", "shell"],
    ["README.md", "text"],
    ["notes.txt", "text"],
    ["LICENSE", "text"],
    [".gitignore", "text"],
    ["archive.tar", "text"],
    ["a.constructor", "text"],
    ["a.toString", "text"],
  ];
  for (const [name, kind] of cases) {
    assert.equal(fileKind(name), kind, name);
  }
});

test("拡張子を持たないファイルは Dockerfile だけ種類を付ける", () => {
  // 名前ごとに KINDS を引くと、go / sh のような拡張子と同じ名前のファイルまで種類付きになる
  const cases: [string, FileKind][] = [
    ["Dockerfile", "shell"],
    ["dockerfile", "shell"],
    ["go", "text"],
    ["ys", "text"],
    ["c", "text"],
    ["sh", "text"],
    ["json", "text"],
    ["Makefile", "text"],
    ["a.", "text"],
    ["Dockerfile.dev", "text"],
  ];
  for (const [name, kind] of cases) {
    assert.equal(fileKind(name), kind, name);
  }
});

test("ロックファイルは拡張子よりロックを優先する", () => {
  const cases = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "Cargo.lock",
    "poetry.lock",
    "flake.lock",
    "Gemfile.LOCK",
  ];
  for (const name of cases) {
    assert.equal(fileKind(name), "lock", name);
  }
});
