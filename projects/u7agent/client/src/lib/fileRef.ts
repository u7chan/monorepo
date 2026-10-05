/**
 * assistant 本文のインラインコードが指すファイル参照を、プレビューのタブのキーへ解決する。
 * 存在確認はしない字句判定で、採用の条件は docs/file-preview.md の採否表を正とする。
 */

/** 拡張子に使える文字 (ASCII 英数字だけ)。記号やマルチバイトが混じったら拡張子として扱わない */
const EXTENSION = /^[0-9A-Za-z]+$/;
const DIGITS_ONLY = /^[0-9]+$/;
/** scheme 付きは URL として扱い、パスにしない */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WHITE_SPACE = /^\p{White_Space}$/u;
/** 共通スキルの置き場 (ワークスペース root 相対)。ファイルスキルの実体と同じ座標 */
const COMMON_SKILLS_ROOT = ".agents/skills";

/**
 * インラインコードの字面を正規化したパスへ写す。ファイル扱いしない字面は null。
 * 絶対パスは先頭の `/` を保ったまま返し、cwd への解決は resolveFileRef が行う。
 */
export function matchFileRef(raw: string): string | null {
  if (raw === "") return null;
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    // ASCII の空白と制御文字、バックスラッシュは区切りとして扱わない (Windows の区切りを推測しない)
    if (code <= 0x20 || code === 0x7f || char === "\\") return null;
    // Unicode 空白 (U+00A0 / U+3000 など) も本文の区切りとして拒否する
    if (WHITE_SPACE.test(char)) return null;
  }
  if (raw.startsWith("//")) return null;
  if (SCHEME.test(raw)) return null;
  // 末尾の形は正規化の前に見る (a.png/. を a.png へ畳むとディレクトリ表記の拒否理由が消える)
  if (raw.endsWith("/") || raw.slice(raw.lastIndexOf("/") + 1).endsWith(".")) return null;
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  // .. は畳まずに拒否する (親参照で cwd の外を開かせない)
  if (segments.includes("..")) return null;
  const last = segments[segments.length - 1];
  // 最終セグメントの dotfile は拡張子を持たない (.env / .gitignore)。親ディレクトリの dot は見ない
  if (last === undefined || last.startsWith(".")) return null;
  const dot = last.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = last.slice(dot + 1);
  if (!EXTENSION.test(extension) || DIGITS_ONLY.test(extension)) return null;
  return `${raw.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

/**
 * 参照を cwd 相対のパスへ解決する。rootCwd 前置きの絶対パスだけを剥がし、cwd 配下のときだけ返す。
 * 保証するのは字句的な包含だけで、symlink の実体 (cwd の外を指し得る) までは見ない。
 */
export function resolveFileRef(raw: string, rootCwd: string, cwd: string): string | null {
  const path = matchFileRef(raw);
  if (path === null) return null;
  // セッションの作業フォルダが未確定 (未作成チャット) の間は対象外
  if (cwd === "") return null;
  if (!path.startsWith("/")) {
    // 明示的な相対は常に cwd 相対。cwd の前置きは剥がさない (projects/x は <cwd>/projects/x を意味する)
    return path;
  }
  if (rootCwd === "") return null;
  const rootRelative = stripPrefix(path, rootCwd);
  if (rootRelative === null) return null;
  const scope = relativeSegments(cwd);
  return scope === "" ? rootRelative : stripPrefix(rootRelative, scope);
}

/** 参照の解決先。面ごとに座標が違う (作業フォルダ面は cwd 相対、スキル面は skill root 相対) */
export type FileRefTarget = { kind: "work"; path: string } | { kind: "skill"; root: string; path: string };

/**
 * 参照を面の種別つきで解決する。作業フォルダ面 (cwd 相対) を先に見て、cwd 外の絶対パスが
 * `<rootCwd>/.agents/skills/<name>/<file>` のときだけスキル面 (root 固定) へ回す。共通スキル以外の
 * root 外パスは開かない (存在確認はしない字句判定のまま)。
 */
export function resolveFileRefTarget(raw: string, rootCwd: string, cwd: string): FileRefTarget | null {
  // セッションの作業フォルダが未確定 (未作成チャット) の間は対象外 (resolveFileRef と同じ前提)
  if (cwd === "") return null;
  const work = resolveFileRef(raw, rootCwd, cwd);
  if (work !== null) return { kind: "work", path: work };
  if (rootCwd === "") return null;
  const rootRelative = commonSkillRelativePath(raw, rootCwd);
  return rootRelative === null ? null : skillRefTarget(rootRelative);
}

/** 絶対パスが共通スキル配下のときだけ、ワークスペース root 相対へ写す */
function commonSkillRelativePath(raw: string, rootCwd: string): string | null {
  const path = matchFileRef(raw);
  if (path === null || !path.startsWith("/")) return null;
  const rootRelative = stripPrefix(path, rootCwd);
  if (rootRelative === null || !rootRelative.startsWith(`${COMMON_SKILLS_ROOT}/`)) return null;
  return rootRelative;
}

/**
 * `.agents/skills/<name>/<file>` をスキル面の座標へ分ける。名前が取れない階層 (`.agents/skills` 直下) と
 * ファイルが無い階層 (`<name>` だけ) は root を作れないため不採用。補助ファイル (assets/... など) も
 * SKILL.md と同じ扱いで、skill dir を root にした 1 つのツリーへ載せる。
 */
function skillRefTarget(rootRelative: string): FileRefTarget | null {
  const segments = rootRelative.slice(COMMON_SKILLS_ROOT.length + 1).split("/");
  const name = segments[0];
  if (name === undefined || segments.length < 2) return null;
  return { kind: "skill", root: `${COMMON_SKILLS_ROOT}/${name}`, path: segments.slice(1).join("/") };
}

/** 区切りを含めて一致する接頭辞だけを剥がす。剥がせない / 接頭辞そのものなら null */
function stripPrefix(path: string, prefix: string): string | null {
  const base = prefix.replace(/\/+$/, "");
  if (path === base || !path.startsWith(`${base}/`)) return null;
  return path.slice(base.length + 1);
}

/** cwd を字句的に正規化する ("" と "." はワークスペース root を意味する) */
function relativeSegments(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}
