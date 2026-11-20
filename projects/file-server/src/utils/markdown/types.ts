/**
 * Markdown プレビューの解析結果。DOM / JSX に依存しない値だけを持ち、
 * レンダリング側 (components/markdown) が同じ木を HTML へ写す。
 */

export type MdAlign = "left" | "center" | "right"

export type MdHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export type MdListItem = {
  /** タスクリストのチェック状態 (`- [x]` / `- [ ]`)。通常の項目は null */
  task: boolean | null
  blocks: MdBlock[]
}

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "del"; children: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; title: string | null; children: MdInline[] }
  /** src は同一オリジン (= 相対パス) だけ。それ以外は literal に落ちる */
  | { kind: "image"; src: string; alt: string }
  | { kind: "break" }
  /** 解釈できなかった記法 (不正な URL のリンクなど)。原文をそのまま見せる */
  | { kind: "literal"; text: string }

export type MdBlock =
  | { kind: "heading"; level: MdHeadingLevel; inline: MdInline[] }
  | { kind: "paragraph"; inline: MdInline[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { kind: "quote"; blocks: MdBlock[] }
  | {
      kind: "table"
      align: MdAlign[]
      header: MdInline[][]
      rows: MdInline[][][]
    }
  | { kind: "hr" }
