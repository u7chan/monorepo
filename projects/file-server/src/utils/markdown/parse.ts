import { parseInline } from "./inline"
import type {
  MdAlign,
  MdBlock,
  MdHeadingLevel,
  MdInline,
  MdListItem,
} from "./types"

/**
 * ブロック (見出し / 段落 / リスト / 引用 / 表 / コードフェンス) の行スキャナ。
 * 例外は投げず、解釈できない行は段落 (原文) として扱う。
 */

/** これを超えるファイルは解析しない (プレビューは原文表示に落ちる) */
export const MARKDOWN_MAX_LENGTH = 200 * 1024

/** 入れ子の上限。深い引用・リストは再帰でスタックを食い潰さないよう原文のまま扱う */
const MAX_BLOCK_DEPTH = 8

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/
const QUOTE = /^ {0,3}> ?(.*)$/
const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/
const TASK = /^\[([ xX])\][ \t]+(.*)$/
const DELIMITER_CELL = /^:?-+:?$/

export function parseMarkdown(text: string): MdBlock[] {
  // CRLF / CR のみの改行も行境界として扱う
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"), 0)
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at]
    if (isBlank(line)) {
      at += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const result = readFence(lines, at, fence)
      blocks.push(result.block)
      at = result.next
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as MdHeadingLevel,
        // `## Title ##` の閉じ記号は本文ではない
        inline: parseInline((heading[2] ?? "").replace(/[ \t]+#+$/, "")),
      })
      at += 1
      continue
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" })
      at += 1
      continue
    }

    if (QUOTE.test(line)) {
      const result = readQuote(lines, at, depth)
      blocks.push(result.block)
      at = result.next
      continue
    }

    const list = LIST_MARKER.exec(line)
    if (list !== null) {
      const result = readList(lines, at, list, depth)
      blocks.push(result.block)
      at = result.next
      continue
    }

    const table = readTable(lines, at)
    if (table !== null) {
      blocks.push(table.block)
      at = table.next
      continue
    }

    const result = readParagraph(lines, at)
    blocks.push(result.block)
    at = result.next
  }
  return blocks
}

function isBlank(line: string): boolean {
  return line.trim() === ""
}

function nextNonBlank(lines: string[], from: number): number {
  for (let at = from; at < lines.length; at += 1) {
    if (!isBlank(lines[at])) return at
  }
  return -1
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** 段落を中断する行。これ以外の行は段落の続きとして連結する */
function startsBlock(lines: string[], at: number): boolean {
  const line = lines[at]
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_MARKER.test(line) ||
    isTableStart(lines, at)
  )
}

function readParagraph(
  lines: string[],
  start: number,
): { block: MdBlock; next: number } {
  const parts = [lines[start].replace(/^[ \t]+/, "")]
  let at = start + 1
  while (at < lines.length && !isBlank(lines[at]) && !startsBlock(lines, at)) {
    // Why not trimEnd: 行末の空白 2 つは改行 (ハードブレーク) の合図なので残す
    parts.push(lines[at].replace(/^[ \t]+/, ""))
    at += 1
  }
  return {
    block: { kind: "paragraph", inline: parseInline(parts.join("\n")) },
    next: at,
  }
}

function readQuote(
  lines: string[],
  start: number,
  depth: number,
): { block: MdBlock; next: number } {
  const parts: string[] = []
  let at = start
  while (at < lines.length) {
    const match = QUOTE.exec(lines[at])
    if (match === null) break
    parts.push(match[1])
    at += 1
  }
  return {
    block: { kind: "quote", blocks: parseNested(parts, depth) },
    next: at,
  }
}

function readFence(
  lines: string[],
  start: number,
  fence: RegExpExecArray,
): { block: MdBlock; next: number } {
  const marker = fence[1]
  const info = fence[2].trim()
  const lang = info === "" ? null : info.split(/[ \t]+/)[0]
  const content: string[] = []
  let at = start + 1
  // Why not fail on an unclosed fence: ファイルの途中で切れたフェンスも
  // コードとして表示したほうが、原文をそのまま段落として崩すより読みやすい。
  while (at < lines.length) {
    const close = FENCE_CLOSE.exec(lines[at])
    if (
      close !== null &&
      close[1][0] === marker[0] &&
      close[1].length >= marker.length
    ) {
      at += 1
      break
    }
    content.push(lines[at])
    at += 1
  }
  return { block: { kind: "code", lang, text: content.join("\n") }, next: at }
}

function readList(
  lines: string[],
  start: number,
  first: RegExpExecArray,
  depth: number,
): { block: MdBlock; next: number } {
  const baseIndent = first[1].length
  const ordered = /^\d/.test(first[2])
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1
  const items: MdListItem[] = []
  let at = start

  while (at < lines.length) {
    // 項目間の空行は同じリストの続きとして読み飛ばす
    if (isBlank(lines[at])) {
      const next = nextNonBlank(lines, at)
      if (next === -1 || !isSiblingMarker(lines[next], baseIndent, ordered)) {
        break
      }
      at = next
      continue
    }
    const marker = LIST_MARKER.exec(lines[at])
    if (
      marker === null ||
      marker[1].length !== baseIndent ||
      /^\d/.test(marker[2]) !== ordered
    ) {
      break
    }
    const contentIndent =
      baseIndent + marker[2].length + Math.max(1, marker[3].length)
    const raw = [
      lines[at].slice(baseIndent + marker[2].length).replace(/^[ \t]+/, ""),
    ]
    let scan = at + 1
    while (scan < lines.length) {
      if (isBlank(lines[scan])) {
        const next = nextNonBlank(lines, scan)
        if (next === -1 || indentOf(lines[next]) <= baseIndent) break
        // フェンス前後の空行を落とさないよう、詰めずに残す
        for (let blank = scan; blank < next; blank += 1) raw.push("")
        scan = next
        continue
      }
      const indent = indentOf(lines[scan])
      // インデントされていない行は項目の外 (遅延継続は対象外)
      if (indent <= baseIndent) break
      raw.push(lines[scan].slice(Math.min(contentIndent, indent)))
      scan += 1
    }
    const task = TASK.exec(raw[0])
    const body = task === null ? raw : [task[2], ...raw.slice(1)]
    items.push({
      task: task === null ? null : task[1].toLowerCase() === "x",
      blocks: parseNested(body, depth),
    })
    at = scan
  }

  return {
    block: { kind: "list", ordered, start: startNumber, items },
    next: at,
  }
}

function isSiblingMarker(
  line: string,
  baseIndent: number,
  ordered: boolean,
): boolean {
  const marker = LIST_MARKER.exec(line)
  return (
    marker !== null &&
    marker[1].length === baseIndent &&
    /^\d/.test(marker[2]) === ordered
  )
}

function parseNested(lines: string[], depth: number): MdBlock[] {
  if (depth >= MAX_BLOCK_DEPTH) {
    const text = lines.join("\n").trim()
    return text === ""
      ? []
      : [{ kind: "paragraph", inline: [{ kind: "text", text }] }]
  }
  return parseBlocks(lines, depth + 1)
}

function isTableStart(lines: string[], at: number): boolean {
  if (at + 1 >= lines.length) return false
  // Why require a pipe on both rows: 見出し行 + `---` は setext 見出しや hr の
  // 書き方でもあるため、表はパイプがあるときだけ成立させる。
  if (!lines[at].includes("|") || !lines[at + 1].includes("|")) return false
  const header = splitRow(lines[at])
  const delimiter = splitRow(lines[at + 1])
  return (
    header.length > 0 &&
    delimiter.length === header.length &&
    delimiter.every((cell) => DELIMITER_CELL.test(cell))
  )
}

function readTable(
  lines: string[],
  start: number,
): { block: MdBlock; next: number } | null {
  if (!isTableStart(lines, start)) return null
  const header = splitRow(lines[start])
  const delimiter = splitRow(lines[start + 1])
  const align: MdAlign[] = delimiter.map((cell) => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    if (left && right) return "center"
    if (right) return "right"
    return "left"
  })
  const rows: MdInline[][][] = []
  let at = start + 2
  while (at < lines.length && !isBlank(lines[at]) && lines[at].includes("|")) {
    const cells = splitRow(lines[at])
    rows.push(header.map((_, index) => parseInline(cells[index] ?? "")))
    at += 1
  }
  return {
    block: {
      kind: "table",
      align,
      header: header.map((cell) => parseInline(cell)),
      rows,
    },
    next: at,
  }
}

function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith("|")) body = body.slice(1)
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1)
  const cells: string[] = []
  let cell = ""
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]
    if (char === "\\" && body[at + 1] === "|") {
      cell += "|"
      at += 1
      continue
    }
    if (char === "|") {
      cells.push(cell.trim())
      cell = ""
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  return cells
}
