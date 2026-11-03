/**
 * 単一の `Range`（`bytes=`）の解釈。試行の成果物配信とサンドボックスの raw 配信で同じ規則を使い、
 * 206 / 416 / 200 の判定を 1 箇所に閉じる（契約は docs/api-files.md の raw 配信）。
 */
/**
 * `Range` ヘッダの解釈結果。`none` はレンジ指定なしとして扱う (応答は 200)。構文的に不正な値と
 * `bytes` 以外の単位、複数レンジは解釈しない (RFC 9110 はレンジを無視した 200 を許す)。
 */
export type ByteRange =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "satisfiable"; start: number; end: number };

/** 先頭の 0 を落とした桁だけの数字。10 進の大小は桁数 → 辞書順で size に依らず比較できる。 */
function normalizeDigits(text: string): string {
  return text.replace(/^0+/, "");
}

/** 正規化した数字の 10 進の大小。桁数が違えば長い方が大きく、同じ桁数なら辞書順で決まる。 */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 正規化した数字を size (100 MiB 以下) と比較できる整数へ読む。16 桁以上は size より必ず大きいので
 * 飽和させてよい (大小の比較は compareDigits で先に行う)。
 */
function byteIndex(digits: string): number {
  return digits.length > 15 ? Number.MAX_SAFE_INTEGER : Number(digits);
}

/**
 * 単一の `bytes=` レンジだけを解釈する (マルチパート / 複数レンジは対象外)。416 は「範囲として
 * 解釈できて満たせない」ときだけ返すため、先頭 > 末尾などの構文不正は none に倒す。end は inclusive。
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "none" };
  const [, firstText, lastText] = match;
  if (firstText === "" && lastText === "") return { kind: "none" };
  if (firstText === "") {
    // `bytes=-N` は末尾 N バイト。表現より長い要求は全体を使い、空の範囲 (N = 0) と 0 バイトは満たせない
    const suffix = byteIndex(normalizeDigits(lastText));
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "satisfiable", start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = byteIndex(normalizeDigits(firstText));
  if (lastText === "") {
    if (start >= size) return { kind: "unsatisfiable" };
    return { kind: "satisfiable", start, end: size - 1 };
  }
  // 先頭 > 末尾の byte-range-spec は不正なので Range ごと無視する。桁を丸める前に 10 進で比べる
  // (丸めると大小が潰れ、不正な範囲が 416 になってしまう)
  if (compareDigits(normalizeDigits(firstText), normalizeDigits(lastText)) > 0) return { kind: "none" };
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "satisfiable", start, end: Math.min(byteIndex(normalizeDigits(lastText)), size - 1) };
}
