/**
 * Mermaid サブセット (flowchart / sequenceDiagram) の解析とレイアウト。
 * DOM / React に依存しない純関数で、解釈できない入力は例外を投げずに ok: false を返す
 * (呼び出し側がソース表示に落とす)。
 *
 * 座標は DOM 計測ではなく文字幅の見積もりから決める。ストリーミング中に再解析しても
 * 同じ入力からは必ず同じモデル (座標・順序まで一致) になることが要件のため。
 */

/* ===== 上限 (1 フレームの作業量を固定する) ===== */

/** フェンス本文の文字数 */
export const DIAGRAM_MAX_LENGTH = 20000;
/** ラベル 1 つの文字数。幅の上限で折り返して 6 行に収まる長さにする */
export const DIAGRAM_MAX_LABEL = 120;
/** ラベルの折り返し行数の上限。超えるラベルは文字を消さずにソース表示へ落とす */
export const DIAGRAM_MAX_LINES = 6;
/** 折り返した 1 行の高さ (px)。CSS のフォントサイズと併せて SVG 側もこの値で置く */
export const DIAGRAM_LINE_HEIGHT = 16;
/** flowchart のノード数 */
export const DIAGRAM_MAX_NODES = 60;
/** flowchart のエッジ数 */
export const DIAGRAM_MAX_EDGES = 120;
/** sequenceDiagram の参加者数 */
export const DIAGRAM_MAX_PARTICIPANTS = 20;
/** sequenceDiagram のメッセージ数 (Note を含む) */
export const DIAGRAM_MAX_MESSAGES = 60;

/* ===== モデル ===== */

export type DiagramKind = "flowchart" | "sequence";

export type DiagramShape = "rect" | "round" | "diamond" | "circle";

export type DiagramPoint = { x: number; y: number };

/** ラベルの位置。anchor は SVG の text-anchor と同じ意味 */
export type LabelPlacement = DiagramPoint & { anchor: "middle" | "start" | "end" };

/** テキストや図形の矩形 (ラベル・ノード・矢印の衝突判定に使う) */
type Rect = { x: number; y: number; w: number; h: number };

/** 軸に平行な線分 (エッジの 1 区間) */
type Segment = { x1: number; y1: number; x2: number; y2: number };

/** 図形 1 つ。x / y は左上で、circle のときは w = h = 直径 */
export type DiagramBox = {
  shape: DiagramShape;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 原文のラベル。表示は折り返し後の lines を使う */
  label: string;
  /** 折り返し後の行 (1 行以上 DIAGRAM_MAX_LINES 行以下)。箱の中央に縦に並べる */
  lines: string[];
};

/** points は直交パスの頂点列。dashed は `-.->` / `-->>` の破線 */
export type DiagramEdge = {
  points: DiagramPoint[];
  dashed: boolean;
  label: string | null;
  /** ラベルの位置と text-anchor。ラベルが無いときは null */
  labelAt: LabelPlacement | null;
};

/** Note over の枠。lines は行ごとの文字列 */
export type DiagramNote = { x: number; y: number; w: number; h: number; lines: string[] };

/** ライフライン (sequenceDiagram の縦の破線) */
export type DiagramLine = { x1: number; y1: number; x2: number; y2: number };

export type DiagramModel = {
  kind: DiagramKind;
  /** ヘッダに出す表記 (例: `mermaid · flowchart TD`) */
  title: string;
  /** 実寸。内容 + 余白で決まるので、CSS 側は max-width で縮小するだけにする */
  width: number;
  height: number;
  boxes: DiagramBox[];
  edges: DiagramEdge[];
  notes: DiagramNote[];
  lifelines: DiagramLine[];
};

export type DiagramParseResult = { ok: true; model: DiagramModel } | { ok: false };

/* ===== 解析 (flowchart) ===== */

/** 解析直後のノード。折り返し行 (lines) は形状が確定したあとの最終パスで決まる */
type ParsedNode = { id: string; label: string; shape: DiagramShape | null };

type FlowNode = ParsedNode & { lines: string[] };

type FlowEdge = { from: string; to: string; dashed: boolean; label: string | null };

/** id は ASCII だけ。日本語のラベルは `[]` `()` `{}` `(())` の中に書く */
const ID_RE = /[A-Za-z0-9_]+/y;

/**
 * mermaid の予約語。ノード名として解釈すると、未対応の記法 (`subgraph` など) が
 * 黙って 1 ノードに化けてしまうため、行ごとエラーにする。
 */
const RESERVED = new Set(["subgraph", "end", "direction", "style", "class", "classdef", "click", "linkstyle"]);

/** 開き区切り → 閉じ区切りと形状。2 文字の区切りを先に判定する */
const SHAPE_DELIMITERS: { open: string; close: string; shape: DiagramShape }[] = [
  { open: "((", close: "))", shape: "circle" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "diamond" },
];

const ARROWS: { token: string; dashed: boolean }[] = [
  { token: "-.->", dashed: true },
  { token: "-->", dashed: false },
];

function skipSpace(line: string, at: number): number {
  let cursor = at;
  while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) cursor += 1;
  return cursor;
}

/** 位置 at から id を読む。読めないときは null */
function readId(line: string, at: number): { id: string; next: number } | null {
  ID_RE.lastIndex = at;
  const match = ID_RE.exec(line);
  if (match === null || RESERVED.has(match[0].toLowerCase())) return null;
  return { id: match[0], next: at + match[0].length };
}

/**
 * `id` / `id[label]` / `id(label)` / `id((label))` / `id{label}` を読む。
 * ラベルは字面どおり (実体参照はデコードしない)。閉じ区切りが無いときは null。
 */
function readNodeRef(line: string, at: number): { node: ParsedNode; next: number } | null {
  const id = readId(line, at);
  if (id === null) return null;
  const delimiter = SHAPE_DELIMITERS.find((entry) => line.startsWith(entry.open, id.next));
  if (delimiter === undefined) return { node: { id: id.id, label: id.id, shape: null }, next: id.next };
  const start = id.next + delimiter.open.length;
  const end = line.indexOf(delimiter.close, start);
  if (end < 0) return null;
  const label = line.slice(start, end).trim();
  if (label === "" || label.length > DIAGRAM_MAX_LABEL) return null;
  return { node: { id: id.id, label, shape: delimiter.shape }, next: end + delimiter.close.length };
}

/** 位置 at から `-->` / `-.->` を読む。読めないときは null */
function readArrow(line: string, at: number): { dashed: boolean; next: number } | null {
  const arrow = ARROWS.find((entry) => line.startsWith(entry.token, at));
  return arrow === undefined ? null : { dashed: arrow.dashed, next: at + arrow.token.length };
}

/** 1 行を `A[foo] -->|label| B --> C` の形に分解する。解釈できない行は null (行を落とさない) */
function parseFlowLine(line: string): { nodes: ParsedNode[]; edges: FlowEdge[] } | null {
  const first = readNodeRef(line, 0);
  if (first === null) return null;
  const nodes: ParsedNode[] = [first.node];
  const edges: FlowEdge[] = [];
  let from = first.node.id;
  let cursor = skipSpace(line, first.next);
  while (cursor < line.length) {
    const arrow = readArrow(line, cursor);
    if (arrow === null) return null;
    cursor = skipSpace(line, arrow.next);
    let label: string | null = null;
    if (line[cursor] === "|") {
      // 引用符は解釈しないので、閉じの `|` が無い行はエラーにする
      const end = line.indexOf("|", cursor + 1);
      if (end < 0) return null;
      const text = line.slice(cursor + 1, end).trim();
      if (text.length > DIAGRAM_MAX_LABEL) return null;
      label = text === "" ? null : text;
      cursor = skipSpace(line, end + 1);
    }
    const target = readNodeRef(line, cursor);
    if (target === null) return null;
    nodes.push(target.node);
    edges.push({ from, to: target.node.id, dashed: arrow.dashed, label });
    from = target.node.id;
    cursor = skipSpace(line, target.next);
  }
  return { nodes, edges };
}

/* ===== 解析 (sequenceDiagram) ===== */

type SeqMessage = { kind: "message"; from: string; to: string; text: string; dashed: boolean };
type SeqNote = { kind: "note"; from: string; to: string; text: string };
type SeqElement = SeqMessage | SeqNote;

const PARTICIPANT_RE = /^participant\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/i;
const MESSAGE_RE = /^([A-Za-z0-9_]+)\s*(-->>|->>)\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/;
const NOTE_RE = /^note\s+over\s+([A-Za-z0-9_]+)(?:\s*,\s*([A-Za-z0-9_]+))?\s*:\s*(.+)$/i;

/* ===== 文字幅の見積もり ===== */

/** ノード / 参加者ラベルの文字サイズ。CSS (.md-diagram-label) と揃える */
const FONT_SIZE = 11.5;
/** エッジラベルの文字サイズ。CSS (.md-diagram-edge-label) と揃える */
const EDGE_FONT_SIZE = 10;
/** Note の文字サイズ。CSS (.md-diagram-note-label) と揃える */
const NOTE_FONT_SIZE = 10.5;

/** 全角文字 (CJK・ハングル・全角記号)。1 文字 = 1em として見積もる */
function isFullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** 文字幅の見積もり。DOM の measureText は使わない (Node のテストと SSR で同じ結果にするため) */
function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    units += code < 0x80 ? 0.62 : isFullWidth(code) ? 1 : 0.72;
  }
  return units * fontSize;
}

/**
 * ラベル 1 行分の幅の見積もり (px)。折り返しとボックスの寸法、および
 * 「テキストが所属ボックスに収まっているか」の検証 (テスト) に使う。
 */
export function diagramLineWidth(text: string): number {
  return textWidth(text, FONT_SIZE);
}

/** エッジラベル 1 行分の幅の見積もり (px)。ラベルの衝突判定と同じ値 */
export function diagramEdgeLabelWidth(text: string): number {
  return textWidth(text, EDGE_FONT_SIZE);
}

/**
 * ラベルを決定的に折り返す。空白があれば語の境界で折り、語が 1 行に収まらないときは
 * 1 文字単位で切る (文字幅は textWidth の見積もりだけを使う)。
 */
function wrapLabel(label: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of label.split(/\s+/)) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (textWidth(candidate, FONT_SIZE) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      lines.push(current);
      current = "";
    }
    if (textWidth(word, FONT_SIZE) <= maxWidth) {
      current = word;
      continue;
    }
    let piece = "";
    for (const char of word) {
      if (piece !== "" && textWidth(piece + char, FONT_SIZE) > maxWidth) {
        lines.push(piece);
        piece = "";
      }
      piece += char;
    }
    current = piece;
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [label] : lines;
}

/* ===== レイアウトの寸法 ===== */

/** 内容の外側に空ける余白 */
const MARGIN = 16;
/** 同じランクのノード間隔 (TD では横、LR では縦) */
const NODE_GAP = 26;
/** ランク間のすき間。エッジとそのラベルが入る */
const RANK_GAP = 38;
const NODE_H = 34;
const DIAMOND_H = 46;
const NODE_MIN_W = 90;
const NODE_MAX_W = 260;
const DIAMOND_MIN_W = 120;
const CIRCLE_MIN = 48;
const PARTICIPANT_H = 30;
const PARTICIPANT_MIN_W = 120;
const PARTICIPANT_MAX_W = 360;
const PARTICIPANT_PAD = 32;
const MESSAGE_PITCH = 34;
const SELF_LOOP_W = 58;
const SELF_LOOP_H = 18;
const NOTE_PAD_X = 10;
const NOTE_GAP = 12;
/** 戻るエッジの外側レーンの間隔。同じ側を使う 2 本目以降を 1 本ずつ外へずらす */
const LANE_PITCH = 14;
/** 戻るエッジの出発点を横へずらす幅 (同じ境界を共有する前向きエッジと線が重ならないように) */
const EXIT_SHIFT = 10;
/**
 * エッジラベルと線の間に空ける余白 (px)。候補の判定はこの分広げた矩形で行う。
 * ランク間のすき間 38px の中で「線からもノードからも離れる」ために 3px にする。
 */
const LABEL_CLEARANCE = 3;
/** 判定に足す余裕 (px)。座標が小数のときに CLEARANCE ちょうどの接触が誤差で交差に見えるのを避ける */
const LABEL_EPSILON = 0.5;
/** ラベルのベースラインを線から離す距離 (px)。行の高さと CLEARANCE を足しても線に届かない値にする */
const LABEL_OFFSET = 7;
/** ラベルを衝突から逃がすときの刻み幅と候補数 */
const LABEL_STEP = 12;
const LABEL_STEPS = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 1 行に使える最大幅。折り返しの幅とボックス幅の上限をこの値から決める */
function contentWidth(shape: DiagramShape | null): number {
  switch (shape) {
    case "diamond":
      // ひし形は頂点に向けて細くなるため、中央でも使える幅は半分ほどになる
      return Math.floor((NODE_MAX_W - 24) / 1.5);
    case "circle":
      // 円は内接する弦の長さが直径なので、さらに狭くする
      return Math.floor((NODE_MAX_W - 16) * 0.66);
    default:
      return NODE_MAX_W - 28;
  }
}

/** 形状に合わせて折り返す。上限行数を超えるラベルは解析失敗にして文字を消さない */
function wrapForShape(label: string, shape: DiagramShape | null): string[] | null {
  const lines = wrapLabel(label, contentWidth(shape));
  return lines.length > DIAGRAM_MAX_LINES ? null : lines;
}

/** ノードの寸法。折り返し後の各行から決まるので、同じラベルからは同じ寸法になる */
function nodeSize(node: FlowNode): { w: number; h: number } {
  const text = Math.max(0, ...node.lines.map((line) => Math.ceil(textWidth(line, FONT_SIZE))));
  const grow = (node.lines.length - 1) * DIAGRAM_LINE_HEIGHT;
  switch (node.shape) {
    case "diamond": {
      // ひし形は頂点に向けて細くなるため、文字の 1.5 倍の幅を確保する
      return { w: clamp(Math.ceil(text * 1.5) + 24, DIAMOND_MIN_W, NODE_MAX_W), h: DIAMOND_H + grow };
    }
    case "circle": {
      // 円は内接する弦の長さが直径なので、さらに広めに取る
      const diameter = clamp(Math.ceil(text / 0.66) + 16, CIRCLE_MIN, NODE_MAX_W) + grow;
      return { w: diameter, h: diameter };
    }
    default:
      return { w: clamp(text + 28, NODE_MIN_W, NODE_MAX_W), h: NODE_H + grow };
  }
}

/* ===== ランク割り当て ===== */

/**
 * 閉路を作るエッジ (後退エッジ) を探す。逆向きのエッジをそのままランク計算に使うと
 * ランクが際限なく伸びるため、DFS で取り除いてから最長路を取る。
 */
function findBackEdges(indexOf: Map<string, number>, edges: FlowEdge[]): boolean[] {
  const outgoing: number[][] = Array.from({ length: indexOf.size }, () => []);
  edges.forEach((edge, index) => {
    outgoing[indexOf.get(edge.from) ?? 0].push(index);
  });
  // 0 = 未訪問 / 1 = 訪問中 / 2 = 完了。訪問中のノードへ戻るエッジが閉路を作る
  const state = Array.from({ length: indexOf.size }, () => 0);
  const back = Array.from({ length: edges.length }, () => false);
  const visit = (node: number): void => {
    state[node] = 1;
    for (const index of outgoing[node]) {
      const next = indexOf.get(edges[index].to) ?? 0;
      if (state[next] === 1) back[index] = true;
      else if (state[next] === 0) visit(next);
    }
    state[node] = 2;
  };
  for (let node = 0; node < indexOf.size; node += 1) if (state[node] === 0) visit(node);
  return back;
}

/** 後退エッジを取り除いた DAG の最長路でランク (TD は行、LR は列) を決める */
function assignRanks(nodeIds: string[], edges: FlowEdge[], back: boolean[]): Map<string, number> {
  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const forward: FlowEdge[] = [];
  const pending = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  edges.forEach((edge, index) => {
    if (back[index] || edge.from === edge.to) return;
    forward.push(edge);
    pending.set(edge.to, (pending.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  });
  // 初出順のトポロジカル順に処理する (同じ入力なら必ず同じランクになる)
  const queue = nodeIds.filter((id) => pending.get(id) === 0);
  const visited = new Set<string>();
  for (let at = 0; at < queue.length; at += 1) {
    const id = queue[at];
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      const remaining = (pending.get(next) ?? 0) - 1;
      pending.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  // 取りこぼしがあっても rank は確定させる (閉路が残っていても有限で止まる)
  for (const edge of forward) {
    if (visited.has(edge.to)) continue;
    rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, (rank.get(edge.from) ?? 0) + 1));
  }
  return rank;
}

/* ===== レイアウト ===== */

type Placed = { node: FlowNode; box: DiagramBox; rank: number };

/** ランク (TD は行、LR は列) ごとの帯に並べる */
function placeNodes(order: FlowNode[], rank: Map<string, number>, horizontal: boolean): Placed[] {
  const bands: FlowNode[][] = [];
  for (const node of order) {
    const at = rank.get(node.id) ?? 0;
    bands[at] = [...(bands[at] ?? []), node];
  }
  const placed = new Map<string, Placed>();
  if (horizontal) {
    // LR: 同じランクを縦に積み、列の高さを中央揃えする
    const sizes = bands.map((band) => band.map(nodeSize));
    const widths = sizes.map((band) => Math.max(...band.map((size) => size.w)));
    const heights = sizes.map((band) => band.reduce((sum, size) => sum + size.h, 0) + NODE_GAP * (band.length - 1));
    const contentH = Math.max(...heights);
    let left = 0;
    bands.forEach((band, index) => {
      let top = (contentH - heights[index]) / 2;
      band.forEach((node, at) => {
        const size = sizes[index][at];
        const box = {
          ...size,
          x: left + (widths[index] - size.w) / 2,
          y: top,
          label: node.label,
          lines: node.lines,
          shape: node.shape ?? ("rect" as const),
        };
        placed.set(node.id, { node, box, rank: index });
        top += size.h + NODE_GAP;
      });
      left += widths[index] + RANK_GAP;
    });
  } else {
    // TD: 同じランクを横に並べ、行の幅を中央揃えする
    const sizes = bands.map((band) => band.map(nodeSize));
    const widths = sizes.map((band) => band.reduce((sum, size) => sum + size.w, 0) + NODE_GAP * (band.length - 1));
    const heights = sizes.map((band) => Math.max(...band.map((size) => size.h)));
    const contentW = Math.max(...widths);
    let top = 0;
    bands.forEach((band, index) => {
      let left = (contentW - widths[index]) / 2;
      band.forEach((node, at) => {
        const size = sizes[index][at];
        const box = {
          ...size,
          x: left,
          y: top + (heights[index] - size.h) / 2,
          label: node.label,
          lines: node.lines,
          shape: node.shape ?? ("rect" as const),
        };
        placed.set(node.id, { node, box, rank: index });
        left += size.w + NODE_GAP;
      });
      top += heights[index] + RANK_GAP;
    });
  }
  return order.map((node) => placed.get(node.id)).filter((entry): entry is Placed => entry !== undefined);
}

type Band = { start: number; end: number };

/** 図全体の外接矩形。逆向きのエッジを外側へ回すレーンを決めるのに使う */
type Frame = { minX: number; maxX: number; minY: number; maxY: number };

/** ランクごとの帯 (TD は上下端、LR は左右端) を求める。エッジの折れ線をその間に置く */
function bandsOf(placed: Placed[], horizontal: boolean): Band[] {
  const bands: Band[] = [];
  for (const entry of placed) {
    const current = bands[entry.rank];
    const start = horizontal ? entry.box.x : entry.box.y;
    const end = horizontal ? entry.box.x + entry.box.w : entry.box.y + entry.box.h;
    if (current === undefined) bands[entry.rank] = { start, end };
    else bands[entry.rank] = { start: Math.min(current.start, start), end: Math.max(current.end, end) };
  }
  return bands;
}

function frameOf(placed: Placed[]): Frame {
  return frameOfBoxes(placed.map((entry) => entry.box));
}

function frameOfBoxes(boxes: DiagramBox[]): Frame {
  const frame: Frame = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const box of boxes) {
    frame.minX = Math.min(frame.minX, box.x);
    frame.maxX = Math.max(frame.maxX, box.x + box.w);
    frame.minY = Math.min(frame.minY, box.y);
    frame.maxY = Math.max(frame.maxY, box.y + box.h);
  }
  return frame;
}

/**
 * 外側レーンを使うエッジ (戻るエッジと、2 ランク以上先へ進むエッジ) のレーンを決める。
 * レーンは全ノードの外側 (ランク軸に直交する向き) に取り、同じ側を使う 2 本目以降は
 * 1 本ずつ外へずらす。入力順に決まるので同じ図からは同じレーンになる。
 */
function planLanes(
  edges: FlowEdge[],
  placed: Map<string, Placed>,
  frame: Frame,
  horizontal: boolean,
): (number | null)[] {
  let usedBefore = 0;
  let usedAfter = 0;
  return edges.map((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    // 隣のランクへのエッジはすき間だけで折れ、自己ループは別に描く
    if (from === undefined || to === undefined || edge.from === edge.to || to.rank - from.rank === 1) return null;
    // レーンの側は、行き先の中心に近い方 (ランク軸に直交する座標で決まる) を使う
    const before =
      (horizontal ? to.box.y + to.box.h / 2 : to.box.x + to.box.w / 2) <
      (horizontal ? from.box.y + from.box.h / 2 : from.box.x + from.box.w / 2);
    if (before) {
      usedBefore += 1;
      const base = horizontal ? frame.minY - RANK_GAP / 2 : frame.minX - RANK_GAP / 2;
      return base - (usedBefore - 1) * LANE_PITCH;
    }
    usedAfter += 1;
    const base = horizontal ? frame.maxY + RANK_GAP / 2 : frame.maxX + RANK_GAP / 2;
    return base + (usedAfter - 1) * LANE_PITCH;
  });
}

/**
 * エッジを直交 (縦 → 横 → 縦) でノードの境界から境界へ引く。
 * 水平に動くのはノードの無い帯 (ランク間のすき間か、外側に確保したレーン) だけにする。
 */
function routeEdge(
  edge: FlowEdge,
  placed: Map<string, Placed>,
  bands: Band[],
  lane: number | null,
  horizontal: boolean,
): DiagramEdge {
  const from = placed.get(edge.from);
  const to = placed.get(edge.to);
  if (from === undefined || to === undefined) {
    return { points: [], dashed: edge.dashed, label: edge.label, labelAt: null };
  }
  if (edge.from === edge.to) {
    // 自己ループはランクのすき間へ落として描く (隣のノードを横切らないように)
    const gap = bands[from.rank].end + RANK_GAP / 2;
    const center = horizontal ? from.box.y + from.box.h / 2 : from.box.x + from.box.w / 2;
    const edgeAt = horizontal ? from.box.x + from.box.w : from.box.y + from.box.h;
    const shift = Math.min(SELF_LOOP_W / 2, Math.max(2, (horizontal ? from.box.h : from.box.w) / 2 - 4));
    const points: DiagramPoint[] = horizontal
      ? [
          { x: edgeAt, y: center - shift },
          { x: gap, y: center - shift },
          { x: gap, y: center + shift },
          { x: edgeAt, y: center + shift },
        ]
      : [
          { x: center - shift, y: edgeAt },
          { x: center - shift, y: gap },
          { x: center + shift, y: gap },
          { x: center + shift, y: edgeAt },
        ];
    // ラベルは周回の横 (線と交差しない位置) に仮置きし、衝突するときは配置パスが動かす
    const labelAt: LabelPlacement | null =
      edge.label === null
        ? null
        : horizontal
          ? { x: gap + LABEL_OFFSET, y: center + 3.5, anchor: "start" }
          : { x: center + shift + LABEL_OFFSET, y: gap - LABEL_OFFSET, anchor: "start" };
    return { points, dashed: edge.dashed, label: edge.label, labelAt };
  }
  const points =
    lane === null ? forwardPoints(from, to, bands, horizontal) : detourPoints(from, to, bands, lane, horizontal);
  return { points, dashed: edge.dashed, label: edge.label, labelAt: labelPosition(points, edge.label) };
}

/** 進む向き: 出た側の次のすき間で折れ、行き先の列 (行) に沿って入る */
function forwardPoints(from: Placed, to: Placed, bands: Band[], horizontal: boolean): DiagramPoint[] {
  const middle = bands[from.rank].end + RANK_GAP / 2;
  const start: DiagramPoint = horizontal
    ? { x: from.box.x + from.box.w, y: from.box.y + from.box.h / 2 }
    : { x: from.box.x + from.box.w / 2, y: from.box.y + from.box.h };
  const end: DiagramPoint = horizontal
    ? { x: to.box.x, y: to.box.y + to.box.h / 2 }
    : { x: to.box.x + to.box.w / 2, y: to.box.y };
  if (horizontal ? start.y === end.y : start.x === end.x) return [start, end];
  return horizontal
    ? [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end]
    : [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end];
}

/**
 * 外側レーンを使う向き (戻るエッジと 2 ランク以上先へ進むエッジ): 出発ノードの下端から
 * ランクの下のすき間へ抜け、全ノードの外側のレーンを通って、行き先ランクの上のすき間から入る。
 * 水平移動はノードの矩形が無い帯だけで行うため、どのノードの矩形も横切らない
 * (行き先が最上段のときは図の上端に専用の帯を取る)。
 */
function detourPoints(from: Placed, to: Placed, bands: Band[], lane: number, horizontal: boolean): DiagramPoint[] {
  const after = bands[from.rank].end + RANK_GAP / 2;
  const before = bands[to.rank].start - RANK_GAP / 2;
  const fromCenter = horizontal ? from.box.y + from.box.h / 2 : from.box.x + from.box.w / 2;
  const toCenter = horizontal ? to.box.y + to.box.h / 2 : to.box.x + to.box.w / 2;
  // 出発点はレーンの側へずらし、同じ境界を使う前向きエッジと重ならないようにする
  const shift = Math.min(EXIT_SHIFT, Math.max(2, (horizontal ? from.box.h : from.box.w) / 2 - 4));
  const exit = fromCenter + (lane < fromCenter ? -shift : shift);
  return horizontal
    ? [
        { x: from.box.x + from.box.w, y: exit },
        { x: after, y: exit },
        { x: after, y: lane },
        { x: before, y: lane },
        { x: before, y: toCenter },
        { x: to.box.x, y: toCenter },
      ]
    : [
        { x: exit, y: from.box.y + from.box.h },
        { x: exit, y: after },
        { x: lane, y: after },
        { x: lane, y: before },
        { x: toCenter, y: before },
        { x: toCenter, y: to.box.y },
      ];
}

/** ラベルは折れ線の後ろから 2 番目の区間 (ノードの無い帯) の外側に置く */
function labelPosition(points: DiagramPoint[], label: string | null): LabelPlacement | null {
  if (label === null || points.length === 0) return null;
  if (points.length === 2) {
    const [start, end] = points;
    if (start.x === end.x) return { x: start.x + LABEL_OFFSET, y: (start.y + end.y) / 2 + 3.5, anchor: "start" };
    return { x: (start.x + end.x) / 2, y: start.y - LABEL_OFFSET, anchor: "middle" };
  }
  const bend = points[points.length - 3];
  const next = points[points.length - 2];
  if (bend.y === next.y) return { x: (bend.x + next.x) / 2, y: bend.y - LABEL_OFFSET, anchor: "middle" };
  return { x: bend.x + LABEL_OFFSET, y: (bend.y + next.y) / 2 + 3.5, anchor: "start" };
}

/* ===== エッジラベルの配置 ===== */

/** ラベル 1 行の実寸の矩形。行の高さは文字サイズの見積もりから決める */
function labelRect(label: string, at: LabelPlacement): Rect {
  const width = textWidth(label, EDGE_FONT_SIZE);
  const left = at.anchor === "middle" ? at.x - width / 2 : at.anchor === "end" ? at.x - width : at.x;
  return { x: left, y: at.y - EDGE_FONT_SIZE * 0.8, w: width, h: EDGE_FONT_SIZE * 1.1 };
}

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

/** 境界に触れるだけは交差とみなさない (線がノードの境界で止まるのを許すため) */
function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function segmentHits(segment: Segment, rect: Rect): boolean {
  const left = Math.min(segment.x1, segment.x2);
  const right = Math.max(segment.x1, segment.x2);
  const top = Math.min(segment.y1, segment.y2);
  const bottom = Math.max(segment.y1, segment.y2);
  if (segment.x1 === segment.x2) {
    return segment.x1 > rect.x && segment.x1 < rect.x + rect.w && bottom > rect.y && top < rect.y + rect.h;
  }
  return segment.y1 > rect.y && segment.y1 < rect.y + rect.h && right > rect.x && left < rect.x + rect.w;
}

/** 矢印の先 (終点の手前 8px・幅 8px の三角形) の外接矩形 */
function headRect(edge: DiagramEdge): Rect | null {
  const last = edge.points[edge.points.length - 1];
  const before = edge.points[edge.points.length - 2];
  if (last === undefined || before === undefined) return null;
  const back = 8;
  const side = 4;
  if (last.y === before.y) {
    return { x: last.x - Math.sign(last.x - before.x) * back, y: last.y - side, w: back, h: side * 2 };
  }
  return { x: last.x - side, y: last.y - Math.sign(last.y - before.y) * back, w: side * 2, h: back };
}

/** 図形の外側 (ノード列の外のマージン) の範囲。ラベルの逃げ場として使う */
type FarBounds = { left: number; right: number };

/**
 * ラベルの候補位置。暫定位置 → ノードの無い帯の中で左右 → 上下 → 図形の外側のマージンの
 * 順に試すので、同じ入力からは必ず同じ位置になる。
 */
function labelCandidates(base: LabelPlacement, far: FarBounds, width: number): LabelPlacement[] {
  const candidates: LabelPlacement[] = [base];
  for (let step = 1; step <= LABEL_STEPS; step += 1) candidates.push({ ...base, x: base.x + step * LABEL_STEP });
  for (let step = 1; step <= LABEL_STEPS; step += 1) candidates.push({ ...base, x: base.x - step * LABEL_STEP });
  for (let step = 1; step <= LABEL_STEPS; step += 1) candidates.push({ ...base, y: base.y - step * LABEL_STEP });
  for (let step = 1; step <= LABEL_STEPS; step += 1) candidates.push({ ...base, y: base.y + step * LABEL_STEP });
  // 最後は図形の外側へ退避する。線も図形も無いので、同じ場所に別のラベルが来たときだけ
  // 次の段へ進む。広いラベルが後続を塞がないよう、間隔は自分の幅から決める
  // (キャンバスは normalize が広げる)
  const stride = Math.max(LABEL_STEP, width + LABEL_STEP);
  for (let step = 0; step < LABEL_STEPS; step += 1) {
    for (const shift of [0, LABEL_STEP, -LABEL_STEP]) {
      candidates.push({ x: far.right + step * stride, y: base.y + shift, anchor: "start" });
      candidates.push({ x: far.left - step * stride, y: base.y + shift, anchor: "end" });
    }
  }
  return candidates;
}

/**
 * ラベルを線 (矢印の先を含む)・他のラベル・ノード・Note から CLEARANCE 以上离し、
 * 置ける位置を 1 つ返す。どこにも置けないときは null (呼び出し側がソース表示にする)。
 */
function placeLabel(
  label: string,
  base: LabelPlacement,
  far: FarBounds,
  obstacles: { segments: Segment[]; rects: Rect[] },
): LabelPlacement | null {
  for (const candidate of labelCandidates(base, far, textWidth(label, EDGE_FONT_SIZE))) {
    const test = inflate(labelRect(label, candidate), LABEL_CLEARANCE + LABEL_EPSILON);
    if (obstacles.segments.some((segment) => segmentHits(segment, test))) continue;
    if (obstacles.rects.some((rect) => overlap(rect, test))) continue;
    return candidate;
  }
  return null;
}

/**
 * 全エッジラベルを衝突の無い位置へ置く。先に決めたラベルを優先するので入力順に決まる。
 * 置けないラベルが 1 つでもあれば null を返し、図全体をソース表示に落とす。
 */
function placeEdgeLabels(model: Omit<DiagramModel, "width" | "height">) {
  const segments: Segment[] = [];
  const rects: Rect[] = model.boxes.map((box) => ({ x: box.x, y: box.y, w: box.w, h: box.h }));
  rects.push(...model.notes.map((note) => ({ x: note.x, y: note.y, w: note.w, h: note.h })));
  // 逃げ場は図形 (ノード・Note・エッジ) の外側に取る
  const far: FarBounds = { left: Infinity, right: -Infinity };
  for (const box of model.boxes) {
    far.left = Math.min(far.left, box.x);
    far.right = Math.max(far.right, box.x + box.w);
  }
  for (const note of model.notes) {
    far.left = Math.min(far.left, note.x);
    far.right = Math.max(far.right, note.x + note.w);
  }
  for (const edge of model.edges) {
    for (const point of edge.points) {
      far.left = Math.min(far.left, point.x);
      far.right = Math.max(far.right, point.x);
    }
  }
  for (const edge of model.edges) {
    for (let index = 0; index + 1 < edge.points.length; index += 1) {
      const from = edge.points[index];
      const to = edge.points[index + 1];
      segments.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
    }
    const head = headRect(edge);
    if (head !== null) rects.push(head);
  }
  const placed: Rect[] = [];
  const edges: DiagramEdge[] = [];
  for (const edge of model.edges) {
    if (edge.label === null || edge.labelAt === null) {
      edges.push(edge);
      continue;
    }
    const at = placeLabel(edge.label, edge.labelAt, far, { segments, rects: [...rects, ...placed] });
    if (at === null) return null;
    placed.push(labelRect(edge.label, at));
    edges.push({ ...edge, labelAt: at });
  }
  return { ...model, edges };
}

function layoutFlowchart(order: FlowNode[], edges: FlowEdge[], direction: string): DiagramModel | null {
  const horizontal = direction === "LR";
  const indexOf = new Map(order.map((node, index) => [node.id, index]));
  const back = findBackEdges(indexOf, edges);
  const rank = assignRanks(
    order.map((node) => node.id),
    edges,
    back,
  );
  const placed = placeNodes(order, rank, horizontal);
  const byId = new Map(placed.map((entry) => [entry.node.id, entry]));
  const bands = bandsOf(placed, horizontal);
  const frame = frameOf(placed);
  const lanes = planLanes(edges, byId, frame, horizontal);
  const withEdges = {
    kind: "flowchart" as const,
    title: `mermaid · flowchart ${direction}`,
    boxes: placed.map((entry) => entry.box),
    edges: edges.map((edge, index) => routeEdge(edge, byId, bands, lanes[index], horizontal)),
    notes: [],
    lifelines: [],
  };
  const labeled = placeEdgeLabels(withEdges);
  return labeled === null ? null : normalize(labeled);
}

type SeqParticipant = { id: string; label: string; lines: string[] };

function layoutSequence(participants: SeqParticipant[], elements: SeqElement[]): DiagramModel | null {
  // 参加者ボックスは等幅・等間隔にする (ライフラインを縦に通すため)
  const boxW = clamp(
    Math.max(
      ...participants.map(
        (entry) => Math.max(0, ...entry.lines.map((line) => Math.ceil(textWidth(line, FONT_SIZE)))) + PARTICIPANT_PAD,
      ),
    ),
    PARTICIPANT_MIN_W,
    PARTICIPANT_MAX_W,
  );
  // 行数が違っても高さは揃える (ライフラインの開始位置を 1 本に合わせるため)
  const rows = Math.max(...participants.map((entry) => entry.lines.length));
  const boxH = PARTICIPANT_H + (rows - 1) * DIAGRAM_LINE_HEIGHT;
  // 間隔は「行間のラベル」と「自己メッセージのループ + ラベル」が収まる幅にする
  const needed = elements.map((element) => {
    if (element.kind === "note") return 0;
    const text = Math.ceil(textWidth(element.text, EDGE_FONT_SIZE));
    return element.from === element.to ? SELF_LOOP_W + text + 24 : text + 20;
  });
  const pitch = boxW + Math.max(64, ...needed);
  const at = new Map(participants.map((entry, index) => [entry.id, index]));
  const lifelineX = (index: number): number => index * pitch + boxW / 2;

  const boxes: DiagramBox[] = participants.map((entry, index) => ({
    shape: "rect",
    x: index * pitch,
    y: 0,
    w: boxW,
    h: boxH,
    label: entry.label,
    lines: entry.lines,
  }));
  const edges: DiagramEdge[] = [];
  const notes: DiagramNote[] = [];
  let cursor = boxH + 26;
  for (const element of elements) {
    const from = lifelineX(at.get(element.from) ?? 0);
    const to = lifelineX(at.get(element.to) ?? 0);
    if (element.kind === "note") {
      // 対象の参加者の幅に広げる。ラベルが収まらないときは中心を保ったまま広げる
      const left = Math.min(from, to) - boxW / 2 - 8;
      const right = Math.max(from, to) + boxW / 2 + 8;
      const width = Math.max(right - left, Math.ceil(textWidth(element.text, NOTE_FONT_SIZE)) + NOTE_PAD_X * 2);
      const height = DIAGRAM_LINE_HEIGHT + 12;
      const center = (left + right) / 2;
      notes.push({ x: center - width / 2, y: cursor + 6, w: width, h: height, lines: [element.text] });
      cursor += height + NOTE_GAP;
      continue;
    }
    const y = cursor + 14;
    if (element.from === element.to) {
      edges.push({
        points: [
          { x: from, y },
          { x: from + SELF_LOOP_W, y },
          { x: from + SELF_LOOP_W, y: y + SELF_LOOP_H },
          { x: from, y: y + SELF_LOOP_H },
        ],
        dashed: element.dashed,
        label: element.text,
        labelAt: { x: from + SELF_LOOP_W + LABEL_OFFSET, y: y + SELF_LOOP_H - 4, anchor: "start" },
      });
    } else {
      edges.push({
        points: [
          { x: from, y },
          { x: to, y },
        ],
        dashed: element.dashed,
        label: element.text,
        labelAt: { x: (from + to) / 2, y: y - LABEL_OFFSET, anchor: "middle" },
      });
    }
    cursor += MESSAGE_PITCH;
  }
  const lifelineTop = boxH + 8;
  const lifelineBottom = cursor + 6;
  const lifelines = participants.map((_, index) => ({
    x1: lifelineX(index),
    y1: lifelineTop,
    x2: lifelineX(index),
    y2: lifelineBottom,
  }));
  const withEdges = { kind: "sequence" as const, title: "mermaid · sequenceDiagram", boxes, edges, notes, lifelines };
  const labeled = placeEdgeLabels(withEdges);
  return labeled === null ? null : normalize(labeled);
}

/** 内容の外側に余白を付ける。Note のはみ出しなどで負になった座標はここで吸収する */
function normalize(model: Omit<DiagramModel, "width" | "height">): DiagramModel {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  const grow = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const box of model.boxes) {
    grow(box.x, box.y);
    grow(box.x + box.w, box.y + box.h);
    // 折り返した各行の矩形も含める (テキストがキャンバスの外へ出ないことを保証する)
    const halfWidth = Math.max(0, ...box.lines.map((line) => textWidth(line, FONT_SIZE))) / 2;
    const halfHeight = (box.lines.length * DIAGRAM_LINE_HEIGHT) / 2;
    const centerX = box.x + box.w / 2;
    const centerY = box.y + box.h / 2;
    grow(centerX - halfWidth, centerY - halfHeight);
    grow(centerX + halfWidth, centerY + halfHeight);
  }
  for (const lifeline of model.lifelines) {
    grow(lifeline.x1, lifeline.y1);
    grow(lifeline.x2, lifeline.y2);
  }
  for (const note of model.notes) {
    grow(note.x, note.y);
    grow(note.x + note.w, note.y + note.h);
  }
  for (const edge of model.edges) {
    for (const point of edge.points) grow(point.x, point.y);
    if (edge.label === null || edge.labelAt === null) continue;
    const rect = labelRect(edge.label, edge.labelAt);
    grow(rect.x, rect.y);
    grow(rect.x + rect.w, rect.y + rect.h);
  }
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  const point = (value: DiagramPoint): DiagramPoint => ({ x: value.x + dx, y: value.y + dy });
  return {
    ...model,
    width: Math.ceil(maxX - minX + MARGIN * 2),
    height: Math.ceil(maxY - minY + MARGIN * 2),
    boxes: model.boxes.map((box) => ({ ...box, x: box.x + dx, y: box.y + dy })),
    edges: model.edges.map((edge) => ({
      ...edge,
      points: edge.points.map(point),
      labelAt:
        edge.labelAt === null ? null : { x: edge.labelAt.x + dx, y: edge.labelAt.y + dy, anchor: edge.labelAt.anchor },
    })),
    notes: model.notes.map((note) => ({ ...note, x: note.x + dx, y: note.y + dy })),
    lifelines: model.lifelines.map((line) => ({
      x1: line.x1 + dx,
      y1: line.y1 + dy,
      x2: line.x2 + dx,
      y2: line.y2 + dy,
    })),
  };
}

/* ===== 入口 ===== */

/**
 * フェンス本文を図のモデルへ写す。`flowchart TD/TB/LR` (`graph` も同じ) と
 * `sequenceDiagram` だけを扱い、解釈できない非空行が 1 つでもあれば ok: false にする。
 */
export function parseDiagram(source: string): DiagramParseResult {
  if (source.length > DIAGRAM_MAX_LENGTH) return { ok: false };
  // %% の行コメントと空行は無視する。CRLF も同じ扱いにする
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("%%"));
  if (lines.length === 0) return { ok: false };
  const head = /^(flowchart|graph)\s+(TD|TB|LR)$/i.exec(lines[0]);
  if (head !== null) return parseFlow(lines.slice(1), head[2].toUpperCase());
  if (!/^sequenceDiagram$/i.test(lines[0])) return { ok: false };
  return parseSequence(lines.slice(1));
}

function parseFlow(lines: string[], direction: string): DiagramParseResult {
  const order: string[] = [];
  const known = new Map<string, ParsedNode>();
  const edges: FlowEdge[] = [];
  for (const line of lines) {
    const parsed = parseFlowLine(line);
    if (parsed === null) return { ok: false };
    for (const node of parsed.nodes) {
      const previous = known.get(node.id);
      // 裸の `A` は既存の宣言を上書きしない。形状つきの宣言が後から来たらそちらを採る
      if (previous === undefined) {
        known.set(node.id, node);
        order.push(node.id);
      } else if (previous.shape === null && node.shape !== null) {
        known.set(node.id, node);
      }
    }
    edges.push(...parsed.edges);
  }
  if (order.length === 0 || order.length > DIAGRAM_MAX_NODES || edges.length > DIAGRAM_MAX_EDGES) return { ok: false };
  const nodes: FlowNode[] = [];
  for (const id of order) {
    const node = known.get(id);
    if (node === undefined) continue;
    const lines = wrapForShape(node.label, node.shape);
    // 上限行数に収まらないラベルは、文字を消さずに図全体をソース表示へ落とす
    if (lines === null) return { ok: false };
    nodes.push({ ...node, lines });
  }
  // ラベルを線から離せないときは、重ねて描かずに図全体をソース表示へ落とす
  const model = layoutFlowchart(nodes, edges, direction);
  return model === null ? { ok: false } : { ok: true, model };
}

function parseSequence(lines: string[]): DiagramParseResult {
  const order: SeqParticipant[] = [];
  const known = new Map<string, SeqParticipant>();
  const elements: SeqElement[] = [];
  const add = (id: string, label: string | null): string => {
    const previous = known.get(id);
    if (previous === undefined) {
      const entry = { id, label: label ?? id, lines: [] };
      known.set(id, entry);
      order.push(entry);
      return id;
    }
    // 宣言が後から来たらラベルだけ差し替える (並び順は初出のまま)
    if (label !== null) previous.label = label;
    return id;
  };
  for (const line of lines) {
    const participant = PARTICIPANT_RE.exec(line);
    if (participant !== null) {
      const label = participant[2]?.trim() ?? null;
      if (label !== null && (label === "" || label.length > DIAGRAM_MAX_LABEL)) return { ok: false };
      add(participant[1], label);
      continue;
    }
    const note = NOTE_RE.exec(line);
    if (note !== null) {
      if (note[3].length > DIAGRAM_MAX_LABEL) return { ok: false };
      const from = add(note[1], null);
      const to = note[2] === undefined ? from : add(note[2], null);
      elements.push({ kind: "note", from, to, text: note[3].trim() });
      continue;
    }
    const message = MESSAGE_RE.exec(line);
    if (message !== null) {
      if (message[4].length > DIAGRAM_MAX_LABEL) return { ok: false };
      const from = add(message[1], null);
      const to = add(message[3], null);
      elements.push({ kind: "message", from, to, text: message[4].trim(), dashed: message[2] === "-->>" });
      continue;
    }
    return { ok: false };
  }
  if (order.length === 0 || order.length > DIAGRAM_MAX_PARTICIPANTS || elements.length > DIAGRAM_MAX_MESSAGES) {
    return { ok: false };
  }
  const participants: SeqParticipant[] = [];
  for (const entry of order) {
    const lines = wrapLabel(entry.label, PARTICIPANT_MAX_W - PARTICIPANT_PAD);
    // 上限行数に収まらないラベルは、文字を消さずに図全体をソース表示へ落とす
    if (lines.length > DIAGRAM_MAX_LINES) return { ok: false };
    participants.push({ ...entry, lines });
  }
  // ラベルを線から離せないときは、重ねて描かずに図全体をソース表示へ落とす
  const model = layoutSequence(participants, elements);
  return model === null ? { ok: false } : { ok: true, model };
}
