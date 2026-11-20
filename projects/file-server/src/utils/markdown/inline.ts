import type { MdInline } from "./types"

/**
 * インライン記法 (強調 / コードスパン / リンク / 裸の URL) のスキャナ。
 * 例外は投げず、解釈できない記法は消さずに literal (原文) へ落とす。
 */

const ESCAPABLE = "\\`*_{}[]()#+-.!~|<>"

/** 入れ子の上限。深い入れ子は原文に落とし、再帰でスタックを食い潰さない */
const MAX_INLINE_DEPTH = 8

/** 1 段落で試す区切りの上限。`*` を大量に含む本文でも O(n^2) に落とさないための保険 */
const MAX_ATTEMPTS = 2000

/** 強調の対応を探す範囲。離れすぎた閉じは対応させない */
const MAX_EMPHASIS_SPAN = 4096

/** リンクのラベルと URL を探す範囲。閉じの無い `[` が多い本文で走査が伸びないための保険 */
const MAX_LINK_SPAN = 2048

/** コードスパンの区切りに使うバックティックの上限。これを超える run はコードにしない */
const MAX_CODE_RUN = 64

const LINK_SCHEMES = new Set(["http", "https", "mailto"])

type ScanState = { attempts: number }

export function parseInline(text: string): MdInline[] {
  return scanInline(text, { attempts: MAX_ATTEMPTS }, 0, true)
}

/**
 * 相対パスと http / https / mailto だけを通す。画像は同一オリジン (= 相対パス) のみ。
 * プレビューは `img-src 'self'` の CSP で動くので、外部画像は描画しても読み込めない。
 */
export function safeUrl(raw: string, kind: "link" | "image"): string | null {
  const value = raw.trim().replace(/&amp;/g, "&")
  if (value === "") return null
  // Why not decode other entities: ブラウザごとに URL の解釈が揺れる入力を
  // 通すより、制御文字・空白・バックスラッシュを含む URL は描画しない。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の混入を弾くのが目的
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return null
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)
  if (scheme !== null) {
    if (!LINK_SCHEMES.has(scheme[1].toLowerCase())) return null
    return kind === "image" ? null : value
  }
  // プロトコル相対 (//host) は外部オリジンになり得るため通さない
  if (value.startsWith("//")) return null
  return value
}

/** allowLinks=false はリンクのラベル内 (リンクの入れ子を作らない) */
function scanInline(
  text: string,
  state: ScanState,
  depth: number,
  allowLinks: boolean,
): MdInline[] {
  if (depth > MAX_INLINE_DEPTH) return [{ kind: "text", text }]
  const nodes: MdInline[] = []
  let buffer = ""
  const flush = () => {
    if (buffer !== "") {
      nodes.push({ kind: "text", text: buffer })
      buffer = ""
    }
  }

  let at = 0
  while (at < text.length) {
    const char = text[at]
    const next = text[at + 1]
    if (char === "\\" && next !== undefined && ESCAPABLE.includes(next)) {
      buffer += next
      at += 2
      continue
    }
    if (char === "\n") {
      // Why not treat every newline as a break: 段落内の折り返しは語間の空白として
      // 畳み、行末の空白 2 つ / バックスラッシュだけを改行として扱う。
      const hard = buffer.endsWith("  ") || buffer.endsWith("\\")
      if (hard) {
        buffer = buffer.replace(/(?:\\|[ \t]+)$/, "")
        flush()
        nodes.push({ kind: "break" })
      } else {
        buffer += " "
      }
      at += 1
      continue
    }
    if (state.attempts > 0) {
      state.attempts -= 1
      if (char === "`") {
        const span = readCodeSpan(text, at)
        if (span !== null) {
          flush()
          nodes.push({ kind: "code", text: span.text })
          at = span.end
          continue
        }
        // Why not advance by one: 閉じの無い長い run を 1 文字ずつ数え直すと
        // 走査が二乗になる。run ごと本文へ戻す。
        let run = 0
        while (text[at + run] === "`") run += 1
        buffer += text.slice(at, at + run)
        at += run
        continue
      }
      if (char === "!" && next === "[") {
        const image = readLink(text, at, true, state, depth)
        if (image !== null) {
          flush()
          nodes.push(image.node)
          at = image.end
          continue
        }
      }
      if (char === "[" && allowLinks) {
        const link = readLink(text, at, false, state, depth)
        if (link !== null) {
          flush()
          nodes.push(link.node)
          at = link.end
          continue
        }
      }
      if (char === "*" || char === "_" || char === "~") {
        const emphasis = readEmphasis(text, at, state, depth)
        if (emphasis !== null) {
          flush()
          nodes.push(emphasis.node)
          at = emphasis.end
          continue
        }
      }
      if (allowLinks && (char === "h" || char === "H")) {
        const url = readBareUrl(text, at)
        if (url !== null) {
          flush()
          nodes.push(url.node)
          at = url.end
          continue
        }
      }
    }
    buffer += char
    at += 1
  }
  flush()
  return nodes
}

/** `` `code` `` / ``` ``code`` ```。対応するバックティックが無ければ null */
function readCodeSpan(
  text: string,
  start: number,
): { text: string; end: number } | null {
  let size = 0
  // Why not always treat a run as an opener: 閉じを探すたびに run 全体を数えると
  // 200 KiB の連続バックティックで二乗になる。長すぎる run はコードにしない。
  while (text[start + size] === "`") {
    size += 1
    if (size >= MAX_CODE_RUN) return null
  }
  const close = text.indexOf("`".repeat(size), start + size)
  if (close === -1) return null
  let content = text.slice(start + size, close).replace(/\n/g, " ")
  // 前後に空白があるときだけ 1 つずつ落とす (`` ` x ` `` の慣習)
  if (
    content.length > 2 &&
    content.startsWith(" ") &&
    content.endsWith(" ") &&
    content.trim() !== ""
  ) {
    content = content.slice(1, -1)
  }
  return { text: content, end: close + size }
}

function readLink(
  text: string,
  start: number,
  image: boolean,
  state: ScanState,
  depth: number,
): { node: MdInline; end: number } | null {
  const labelStart = image ? start + 2 : start + 1
  const labelLimit = Math.min(text.length, labelStart + MAX_LINK_SPAN)
  let at = labelStart
  let nested = 0
  let labelEnd = -1
  while (at < labelLimit) {
    const char = text[at]
    if (char === "\\") {
      at += 2
      continue
    }
    if (char === "[") {
      nested += 1
    } else if (char === "]") {
      if (nested === 0) {
        labelEnd = at
        break
      }
      nested -= 1
    }
    at += 1
  }
  if (labelEnd === -1 || text[labelEnd + 1] !== "(") return null
  const end = findDestinationEnd(text, labelEnd + 1)
  if (end === -1) return null
  const destination = parseDestination(text.slice(labelEnd + 2, end))
  if (destination === null) return null
  const raw = text.slice(start, end + 1)
  const label = text.slice(labelStart, labelEnd)

  if (image) {
    const src = safeUrl(destination.url, "image")
    // Why not drop the image silently: 原文を残せば、リンク切れの理由を
    // プレビュー上で確認できる。
    if (src === null)
      return { node: { kind: "literal", text: raw }, end: end + 1 }
    return {
      node: { kind: "image", src, alt: label.replace(/\\(.)/g, "$1") },
      end: end + 1,
    }
  }

  const href = safeUrl(destination.url, "link")
  if (href === null)
    return { node: { kind: "literal", text: raw }, end: end + 1 }
  return {
    node: {
      kind: "link",
      href,
      title: destination.title,
      children: scanInline(label, state, depth + 1, false),
    },
    end: end + 1,
  }
}

/** `(` から対応する `)` を探す。見つからなければ -1 */
function findDestinationEnd(text: string, open: number): number {
  let at = open
  let depth = 0
  const limit = Math.min(text.length, open + MAX_LINK_SPAN)
  while (at < limit) {
    const char = text[at]
    if (char === "\\") {
      at += 2
      continue
    }
    if (char === "<") {
      const gt = text.indexOf(">", at + 1)
      if (gt === -1) return -1
      at = gt + 1
      continue
    }
    if (char === "(") {
      depth += 1
    } else if (char === ")") {
      depth -= 1
      if (depth === 0) return at
    }
    at += 1
  }
  return -1
}

const DESTINATION =
  /^\s*(?:<([^<>]*)>|(\S+?))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/

function parseDestination(
  inner: string,
): { url: string; title: string | null } | null {
  const match = DESTINATION.exec(inner)
  if (match === null) return null
  const url = match[1] ?? match[2] ?? ""
  if (url === "") return null
  return { url, title: match[3] ?? match[4] ?? match[5] ?? null }
}

function readEmphasis(
  text: string,
  start: number,
  state: ScanState,
  depth: number,
): { node: MdInline; end: number } | null {
  const char = text[start]
  const runLimit = Math.min(text.length, start + MAX_EMPHASIS_SPAN)
  let run = 0
  while (start + run < runLimit && text[start + run] === char) run += 1
  if (char === "~" && run < 2) return null
  const del = char === "~"
  const strong = !del && run >= 2
  const size = strong || del ? 2 : 1
  const after = text[start + size]
  // 開きの直後が空白なら強調にしない (`2 * 3 * 4` を強調にしない)
  if (after === undefined || /\s/.test(after)) return null
  const strict = char === "_"
  // 語中の _ は対象外 (snake_case を壊さない)
  if (strict && /[0-9A-Za-z]/.test(text[start - 1] ?? "")) return null
  const close = findClose(text, start + size, char, size, !strict)
  if (close === -1) return null
  const children = scanInline(
    text.slice(start + size, close),
    state,
    depth + 1,
    true,
  )
  const node: MdInline = del
    ? { kind: "del", children }
    : strong
      ? { kind: "strong", children }
      : { kind: "em", children }
  return { node, end: close + size }
}

/** 対応する閉じの位置。単独の `*` を数えて `**bold *em* bold**` の入れ子に対応する */
function findClose(
  text: string,
  from: number,
  char: string,
  size: number,
  allowIntraword: boolean,
): number {
  const limit = Math.min(text.length, from + MAX_EMPHASIS_SPAN)
  let depth = 0
  let at = from
  while (at < limit) {
    const current = text[at]
    if (current === "\\") {
      at += 2
      continue
    }
    if (current === "`") {
      const span = readCodeSpan(text, at)
      if (span !== null) {
        at = span.end
        continue
      }
      // 閉じの無い run は丸ごと飛ばす (1 文字ずつ数え直さない)
      let run = 0
      while (at + run < limit && text[at + run] === "`") run += 1
      at += Math.max(run, 1)
      continue
    }
    if (current !== char) {
      at += 1
      continue
    }
    let run = 0
    while (at + run < limit && text[at + run] === char) run += 1
    const before = text[at - 1]
    const after = text[at + run]
    const closable =
      before !== undefined &&
      !/\s/.test(before) &&
      (allowIntraword || !/[0-9A-Za-z]/.test(after ?? ""))
    if (size === 1) {
      if (run === 1 && closable) return at
      at += run
      continue
    }
    if (depth === 0) {
      if (run >= 2 && closable) return at
      if (run === 1) depth = 1
      at += run
      continue
    }
    // 内側の `*` が開いているときは 1 つを内側の閉じに、残り 2 つを外側の閉じに使う (`***x***`)
    if (run >= 3) return at + 1
    if (run === 2) return at
    depth = 0
    at += run
  }
  return -1
}

/** 裸の URL。直前が語の続きでないときだけリンクにする (文末の句読点は含めない) */
function readBareUrl(
  text: string,
  start: number,
): { node: MdInline; end: number } | null {
  const before = text[start - 1]
  // ASCII の語中に紛れた URL は対象外 (日本語の直後の URL はリンクにする)
  if (before !== undefined && /[0-9A-Za-z_]/.test(before)) return null
  const match =
    /^https?:\/\/[^\s<>"'`）］｝＞」』】》〉〕〗〙〛｣。、！？]+/i.exec(
      text.slice(start),
    )
  if (match === null) return null
  let url = match[0].replace(/[.,;:!?]+$/, "")
  while (
    url.endsWith(")") &&
    (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)
  ) {
    url = url.slice(0, -1)
  }
  if (url.length < 9) return null
  return {
    node: {
      kind: "link",
      href: url,
      title: null,
      children: [{ kind: "text", text: url }],
    },
    end: start + url.length,
  }
}
