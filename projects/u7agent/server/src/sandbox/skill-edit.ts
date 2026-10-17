/**
 * 共通スキル (SKILL.md) の決定的なテキスト編集。frontmatter の境界と description の値の source range
 * だけを差し替え、YAML 全体は再生成しない。境界と改行の正規化は SDK の parseFrontmatter と同じ規則に
 * 合わせ、スキルとしての意味の検証はサンドボックス側の SDK 走査へ委ねる (docs/sandbox-api.md)。
 */
import { createHash } from "node:crypto";
import { isMap, isScalar, parseDocument, type Document, type Pair, type YAMLMap } from "yaml";

/** SDK の validateDescription と同じ上限。変更する説明の生の長さにだけ適用する */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** frontmatter が無い / 閉じていないファイル。SDK もスキルとして読み込まない */
export const SKILL_EDIT_NO_FRONTMATTER = "frontmatter (---) が無い SKILL.md は保存できません";
/** YAML として解釈できない frontmatter。SDK もスキルとして読み込まない */
export const SKILL_EDIT_BROKEN_YAML = "frontmatter を YAML として解釈できません";
/** ルートがマップでない frontmatter (シーケンス / スカラー)。キーを特定できないため保存しない */
export const SKILL_EDIT_NOT_MAP = "frontmatter がキーと値の組ではないため保存できません";
/** description がスカラーでない (マップ / シーケンス)。値の範囲を特定できないため保存しない */
export const SKILL_EDIT_DESCRIPTION_UNSUPPORTED = "description の値を安全に差し替えられません";
/** description に anchor が付いている。差し替えると別の値を指す alias を壊し得る */
export const SKILL_EDIT_DESCRIPTION_ANCHORED = "description に anchor が付いているため保存できません";

export interface SkillTextInfo {
  /** frontmatter の name (文字列のときだけ)。親ディレクトリ名へのフォールバックは SDK の役割 */
  name: string | undefined;
  /** frontmatter の description (文字列のときだけ) */
  description: string | undefined;
  /** frontmatter を除いた本文 (trim しない) */
  body: string;
  /** 保存を受け付けない理由。undefined なら保存できる */
  reason: string | undefined;
}

export type SkillTextEdit = { ok: true; changed: boolean; text: string } | { ok: false; reason: string };

export interface SkillTextEditInput {
  original: string;
  /** 保存後の説明。値は trim しない */
  description: string;
  /** 保存後の本文。値は trim しない */
  body: string;
}

/** BOM と改行を、SDK の extractFrontmatter と同じ座標へ写す元テキストの見え方 */
interface SkillSource {
  /** 元のテキスト (BOM を含む)。差し替えはこの文字列へ行う */
  original: string;
  bom: string;
  /** 改行を LF へ正規化したテキスト */
  normalized: string;
  /** normalized の index → 元テキストの index */
  toOriginal(index: number): number;
  /** 元テキストの改行 (本文の差し替えだけに使う) */
  eol: string;
}

interface FrontmatterRange {
  /** `---` の次の文字から閉じ行の手前まで */
  yamlStart: number;
  yamlEnd: number;
  /** 本文の開始位置 (閉じ `---` の直後。先頭の改行を含む) */
  bodyStart: number;
}

interface ParsedFrontmatter {
  doc: Document;
  map: YAMLMap | undefined;
  description: Pair | undefined;
  name: string | undefined;
  descriptionValue: string | undefined;
  reason: string | undefined;
  /** frontmatter の slice の開始位置 (yaml package の range は slice 相対なので足して使う) */
  yamlStart: number;
}

/** 改行だけを LF へ寄せる。本文の no-op 判定と新規作成の本文に使う (値そのものは変えない)。 */
export function normalizeSkillEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 元ファイルのバイト列の SHA-256。版の比較は mtime ではなくこの値で行う */
export function skillFileVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * frontmatter と本文の境界。SDK の extractFrontmatter と同じ判定 (BOM 除去後に先頭 `---` と
 * 最初の `\n---`) をそのまま写し、末尾の閉じ行は検証しない (SDK と同じ範囲を見る)。
 */
function frontmatterRange(normalized: string): FrontmatterRange | undefined {
  if (!normalized.startsWith("---")) return undefined;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return undefined;
  return { yamlStart: 4, yamlEnd: endIndex, bodyStart: endIndex + 4 };
}

function buildSkillSource(text: string): SkillSource {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const rest = bom ? text.slice(1) : text;
  const eol = rest.includes("\r\n") ? "\r\n" : rest.includes("\r") ? "\r" : "\n";
  if (!rest.includes("\r")) {
    return { original: text, bom, normalized: rest, toOriginal: (index) => index + bom.length, eol };
  }
  // CRLF / CR は 1 文字の LF へ畳むため、正規化後の index を元の index へ戻す対応表を作る
  const map: number[] = [];
  let normalized = "";
  for (let i = 0; i < rest.length;) {
    if (rest[i] === "\r") {
      map.push(i);
      normalized += "\n";
      i += rest[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    map.push(i);
    normalized += rest[i];
    i += 1;
  }
  map.push(rest.length);
  return { original: text, bom, normalized, toOriginal: (index) => bom.length + map[index], eol };
}

function parseFrontmatter(normalized: string, range: FrontmatterRange): ParsedFrontmatter {
  const doc = parseDocument(normalized.slice(range.yamlStart, range.yamlEnd));
  const root = doc.contents;
  const base = { doc, yamlStart: range.yamlStart } as const;
  if (doc.errors.length > 0) {
    return {
      ...base,
      map: undefined,
      description: undefined,
      name: undefined,
      descriptionValue: undefined,
      reason: SKILL_EDIT_BROKEN_YAML,
    };
  }
  if (!root || !isMap(root)) {
    return {
      ...base,
      map: undefined,
      description: undefined,
      name: undefined,
      descriptionValue: undefined,
      reason: SKILL_EDIT_NOT_MAP,
    };
  }
  const description = root.items.find((pair) => isScalar(pair.key) && pair.key.value === "description");
  const namePair = root.items.find((pair) => isScalar(pair.key) && pair.key.value === "name");
  const name =
    namePair && isScalar(namePair.value) && typeof namePair.value.value === "string" ? namePair.value.value : undefined;
  let descriptionValue: string | undefined;
  let reason: string | undefined;
  // 文字列以外のスカラー (null / 数値 / 真偽値) は SDK も説明として読まないが、値の範囲は差し替えられる
  if (description && isScalar(description.value)) {
    if (typeof description.value.value === "string") descriptionValue = description.value.value;
    if (description.value.anchor !== undefined) reason = SKILL_EDIT_DESCRIPTION_ANCHORED;
  } else if (description) {
    reason = SKILL_EDIT_DESCRIPTION_UNSUPPORTED;
  }
  return { ...base, map: root, description, name, descriptionValue, reason };
}

/**
 * description 以外の値を比較するための正規化 JSON (キー順も含めて比べる)。循環 alias など JSON へ
 * 落とせない値は同じ印に畳む (差し替えで他の値を壊したときに検出できることを優先する)。
 */
function otherFrontmatterValues(parsed: ParsedFrontmatter): string {
  if (!parsed.map) return "";
  return JSON.stringify(
    parsed.map.items
      .filter((pair) => !(isScalar(pair.key) && pair.key.value === "description"))
      .map((pair) => [String(isScalar(pair.key) ? pair.key.value : "?"), valueJson(pair)]),
  );
}

function valueJson(pair: Pair): string {
  try {
    const node = pair.value as { toJSON?: () => unknown } | null | undefined;
    return JSON.stringify(node?.toJSON?.());
  } catch {
    return "!unserializable";
  }
}

/** 元テキストの見え方と frontmatter の解釈。保存可否は reason にだけ入れる (本文は常に返す)。 */
export function inspectSkillText(text: string): SkillTextInfo {
  const source = buildSkillSource(text);
  const range = frontmatterRange(source.normalized);
  const body = range ? source.normalized.slice(range.bodyStart) : source.normalized;
  if (!range) return { name: undefined, description: undefined, body, reason: SKILL_EDIT_NO_FRONTMATTER };
  const parsed = parseFrontmatter(source.normalized, range);
  return {
    name: parsed.name,
    description: parsed.descriptionValue,
    body,
    reason: parsed.reason,
  };
}

/** YAML の二重引用符スカラー。JSON 文字列は YAML 1.2 の flow スカラーとしてそのまま読める */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 新規 SKILL.md の固定の生成規則 (name / description の順、LF、本文を切り詰めない)。本文の先頭の改行は
 * 閉じ行の終端として 1 つだけ捨てる (本文は frontmatter の直後から始まるため、受け取った本文の
 * 先頭が改行でも 1 つに畳んで往復で増えないようにする)。
 */
export function createSkillText(input: { name: string; description: string; body: string }): string {
  const body = normalizeSkillEol(input.body).replace(/^\n/, "");
  return `---\nname: ${yamlString(input.name)}\ndescription: ${yamlString(input.description)}\n---\n${body}`;
}

/** 元テキストへ差し替えを適用する。start の大きい順に splice する (位置がずれない) */
function spliceOriginal(source: SkillSource, splices: { start: number; end: number; text: string }[]): string {
  const ordered = [...splices].sort((a, b) => b.start - a.start);
  let text = source.original;
  for (const splice of ordered) {
    // normalized の座標を元テキスト (BOM を含む) へ戻す
    const start = source.toOriginal(splice.start);
    const end = source.toOriginal(splice.end);
    text = text.slice(0, start) + splice.text + text.slice(end);
  }
  return text;
}

/**
 * description の値と本文だけを差し替える。変更が無ければ元テキストをそのまま返し、書き込みを起こさせない。
 * 差し替え後は解釈し直して、他の値・キー順が変わっていないことと、説明と本文が送った値になったことを確認する。
 */
export function editSkillText(input: SkillTextEditInput): SkillTextEdit {
  const source = buildSkillSource(input.original);
  const range = frontmatterRange(source.normalized);
  if (!range) return { ok: false, reason: SKILL_EDIT_NO_FRONTMATTER };
  const parsed = parseFrontmatter(source.normalized, range);
  if (parsed.reason) return { ok: false, reason: parsed.reason };
  if (!parsed.map) return { ok: false, reason: SKILL_EDIT_NOT_MAP };

  const currentBody = source.normalized.slice(range.bodyStart);
  const bodyChanged = normalizeSkillEol(input.body) !== normalizeSkillEol(currentBody);
  const descriptionChanged = input.description !== parsed.descriptionValue;
  if (!bodyChanged && !descriptionChanged) return { ok: true, changed: false, text: input.original };

  if (descriptionChanged) {
    if (input.description.trim() === "") return { ok: false, reason: "説明を空にはできません" };
    if (input.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      return { ok: false, reason: `説明は ${SKILL_DESCRIPTION_MAX_LENGTH} 文字以内にしてください` };
    }
  }

  const splices: { start: number; end: number; text: string }[] = [];
  if (descriptionChanged) {
    if (parsed.description && isScalar(parsed.description.value)) {
      const { range: valueRange } = parsed.description.value;
      const start = (valueRange?.[0] ?? range.yamlEnd - range.yamlStart) + parsed.yamlStart;
      const end = (valueRange?.[1] ?? valueRange?.[0] ?? range.yamlEnd - range.yamlStart) + parsed.yamlStart;
      // 値の直前 / 直後に区切りが無いとき (未記入の値・ブロックスカラーの後ろの行内コメント
      // など) は空白を足して、前後のトークンへ吸着させない
      const lead = start > 0 && !/[\s,}[\]]/.test(source.normalized[start - 1]) ? " " : "";
      const trail = end < source.normalized.length && !/[\s,}\]]/.test(source.normalized[end]) ? " " : "";
      splices.push({ start, end, text: `${lead}${yamlString(input.description)}${trail}` });
    } else {
      // 既存のキーが無いときは frontmatter の末尾行として足す (他のキーと本文は動かさない)
      splices.push({
        start: range.yamlEnd,
        end: range.yamlEnd,
        text: `${source.eol}description: ${yamlString(input.description)}`,
      });
    }
  }
  if (bodyChanged) {
    splices.push({
      start: range.bodyStart,
      end: source.normalized.length,
      text: source.eol === "\n" ? normalizeSkillEol(input.body) : toEol(input.body, source.eol),
    });
  }

  const text = spliceOriginal(source, splices);
  const candidateSource = buildSkillSource(text);
  const candidateRange = frontmatterRange(candidateSource.normalized);
  if (!candidateRange) return { ok: false, reason: "差し替え結果を frontmatter として確認できませんでした" };
  const candidate = parseFrontmatter(candidateSource.normalized, candidateRange);
  if (candidate.reason || candidate.descriptionValue !== input.description) {
    return { ok: false, reason: "差し替え結果を frontmatter として確認できませんでした" };
  }
  if (otherFrontmatterValues(candidate) !== otherFrontmatterValues(parsed)) {
    return { ok: false, reason: "description 以外の値を保持できることを確認できませんでした" };
  }
  const candidateBody = candidateSource.normalized.slice(candidateRange.bodyStart);
  if (normalizeSkillEol(candidateBody) !== normalizeSkillEol(input.body)) {
    return { ok: false, reason: "本文の差し替え結果を確認できませんでした" };
  }
  return { ok: true, changed: true, text };
}

/** 送信された本文の改行を元ファイルの改行へ寄せる (未編集部分の見た目を揃える) */
function toEol(text: string, eol: string): string {
  return normalizeSkillEol(text).split("\n").join(eol);
}
