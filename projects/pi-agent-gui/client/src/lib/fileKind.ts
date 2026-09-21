/**
 * ファイルツリーの行に出すアイコンの模様の種類。拡張子 (一部は慣用のファイル名) からこの 8 種へ畳む。
 * プレビューの言語判定 (previewLang) より粗いのは、行のアイコンが 12px の文字の隣で 16px で描かれ、
 * 言語ごとに増やしても模様が潰れて見分けられなくなるため。列挙した拡張子以外は既定 (text) にする。
 */
export type FileKind = "code" | "markup" | "style" | "data" | "image" | "shell" | "lock" | "text";

const KINDS: Record<string, FileKind> = {
  // ソースコード (言語ごとに増やさず 1 つの模様へ)
  ts: "code",
  tsx: "code",
  mts: "code",
  cts: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  kts: "code",
  c: "code",
  h: "code",
  cc: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  swift: "code",
  php: "code",
  lua: "code",
  ex: "code",
  exs: "code",
  hs: "code",
  clj: "code",
  scala: "code",
  dart: "code",
  zig: "code",
  sql: "code",
  vue: "code",
  svelte: "code",
  astro: "code",
  // タグ・マークアップ (svg はサンドボックスが本文として返すため、画像ではなくテキスト扱い)
  html: "markup",
  htm: "markup",
  xml: "markup",
  xhtml: "markup",
  xsl: "markup",
  svg: "markup",
  // スタイルシート
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  // 構造化データ・設定
  json: "data",
  jsonc: "data",
  json5: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  ini: "data",
  cfg: "data",
  conf: "data",
  properties: "data",
  csv: "data",
  tsv: "data",
  graphql: "data",
  gql: "data",
  // 画像 (プレビューが画像として配信する拡張子に合わせる)
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  // シェルスクリプト (Dockerfile は previewLang が bash として扱うのに合わせる)
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  psm1: "shell",
  bat: "shell",
  cmd: "shell",
  dockerfile: "shell",
};

/** 拡張子を持たないロックファイル。`.lock` だけでは拾えないものを名前で列挙する */
const LOCK_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

/**
 * ファイル名から模様の種類を決める。判定できないファイルとドットファイル (.gitignore) は既定の
 * text にする (ドットファイルを拡張子と見なさない規則は previewLang と同じ)。
 */
export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase();
  if (LOCK_NAMES.has(lower) || lower.endsWith(".lock")) return "lock";
  const dot = lower.lastIndexOf(".");
  // 拡張子を持たないファイルは名前ごと引く (Dockerfile だけ shell。previewLang が bash として扱うのに合わせる)
  const key = dot > 0 ? lower.slice(dot + 1) : lower;
  // 名前は本文由来なので、own プロパティだけを見る (constructor / __proto__ を種類として拾わない)
  return Object.hasOwn(KINDS, key) ? KINDS[key] : "text";
}
