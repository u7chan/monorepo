// 図 (mermaid サブセット) の契約: 受理する記法 / 形状 / エッジ / 順序 / 決定性 / 失敗時の ok: false。
// 解析は DOM / React に依存せず例外も投げない (上限超過もソース表示に落ちる) ことを固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Diagram } from "../src/components/markdown/Diagram";
import { MarkdownBlocks } from "../src/components/markdown/MarkdownView";
import {
  DIAGRAM_MAX_EDGES,
  DIAGRAM_MAX_LABEL,
  DIAGRAM_MAX_LENGTH,
  DIAGRAM_MAX_MESSAGES,
  DIAGRAM_MAX_NODES,
  DIAGRAM_MAX_PARTICIPANTS,
  parseDiagram,
} from "../src/lib/markdown/diagram";
import type { DiagramModel } from "../src/lib/markdown/diagram";

/** 解析に成功することを確かめたうえでモデルを返す */
function model(source: string): DiagramModel {
  const result = parseDiagram(source);
  assert.ok(result.ok, `${source} を解析できる`);
  return result.model;
}

function flow(lines: string[]): DiagramModel {
  return model(["flowchart TD", ...lines].join("\n"));
}

function sequence(lines: string[]): DiagramModel {
  return model(["sequenceDiagram", ...lines].join("\n"));
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("flowchart: 4 種類の形状と裸のノードを解決する", () => {
  const diagram = flow(["a[角丸]", "b(丸め)", "c{ひし形}", "d((円))", "e"]);
  assert.deepEqual(
    diagram.boxes.map((box) => box.shape),
    ["rect", "round", "diamond", "circle", "rect"],
  );
  assert.deepEqual(
    diagram.boxes.map((box) => box.label),
    ["角丸", "丸め", "ひし形", "円", "e"],
  );
  assert.equal(diagram.kind, "flowchart");
  assert.equal(diagram.title, "mermaid · flowchart TD");
});

test("flowchart: 実線と破線のエッジを区別する", () => {
  const diagram = flow(["a --> b", "a -.-> c"]);
  assert.deepEqual(
    diagram.edges.map((edge) => edge.dashed),
    [false, true],
  );
});

test("flowchart: エッジのラベルを行間の中央に置く", () => {
  const diagram = flow(["a[始め] -->|はい| b[左]", "a -.->|いいえ| c[右]"]);
  assert.deepEqual(
    diagram.edges.map((edge) => edge.label),
    ["はい", "いいえ"],
  );
  for (const edge of diagram.edges) {
    assert.equal(edge.labelAt?.anchor, "middle");
  }
  // ラベルは折れ線の水平区間の上に来る
  const [bend, next] = [diagram.edges[0].points[1], diagram.edges[0].points[2]];
  assert.equal(diagram.edges[0].labelAt?.x, (bend.x + next.x) / 2);
  assert.ok((diagram.edges[0].labelAt?.y ?? 0) < bend.y);
});

test("flowchart: ラベル無しの縦のエッジは 2 点の直線になる", () => {
  const diagram = flow(["a --> b"]);
  const [a, b] = diagram.boxes;
  assert.deepEqual(diagram.edges[0].points, [
    { x: a.x + a.w / 2, y: a.y + a.h },
    { x: b.x + b.w / 2, y: b.y },
  ]);
  assert.equal(diagram.edges[0].labelAt, null);
});

test("flowchart: チェーンは 1 本ずつに分解する", () => {
  const diagram = flow(["a --> b --> c"]);
  assert.deepEqual(
    diagram.boxes.map((box) => box.label),
    ["a", "b", "c"],
  );
  assert.equal(diagram.edges.length, 2);
  assert.ok(diagram.boxes[0].y < diagram.boxes[1].y);
  assert.ok(diagram.boxes[1].y < diagram.boxes[2].y);
});

test("flowchart: TD は下へ、LR は右へランクを積む", () => {
  const down = flow(["a --> b"]);
  const right = model("graph LR\n a --> b");
  assert.ok(down.boxes[1].y > down.boxes[0].y);
  assert.equal(down.boxes[1].x, down.boxes[0].x);
  assert.ok(right.boxes[1].x > right.boxes[0].x);
  assert.equal(right.boxes[1].y, right.boxes[0].y);
  assert.equal(right.title, "mermaid · flowchart LR");
  // TB は TD と同じ向き (表記は書かれたまま)
  const tb = model("flowchart TB\n a --> b");
  assert.deepEqual(tb.boxes, down.boxes);
  assert.equal(tb.title, "mermaid · flowchart TB");
});

test("flowchart: %% の行コメントと空行は解析結果を変えない", () => {
  const withComments = model("%% 見出し\nflowchart TD\n\n  a --> b\n%% 補足\n");
  assert.deepEqual(withComments, flow(["a --> b"]));
});

test("flowchart: エッジはノードの境界から出て境界で止まる", () => {
  const diagram = flow(["a[始め] --> b{分岐}", "b -.-> c[終わり]"]);
  const [a, b, c] = diagram.boxes;
  const [first, second] = diagram.edges;
  assert.deepEqual(first.points[0], { x: a.x + a.w / 2, y: a.y + a.h });
  assert.deepEqual(first.points[first.points.length - 1], { x: b.x + b.w / 2, y: b.y });
  assert.deepEqual(second.points[0], { x: b.x + b.w / 2, y: b.y + b.h });
  assert.deepEqual(second.points[second.points.length - 1], { x: c.x + c.w / 2, y: c.y });
});

test("flowchart: ノードの矩形は重ならず、図は内容に合わせて広がる", () => {
  // モックと同じ 5 ランクの分岐 (ひし形から 4 方向へ分かれる)
  const diagram = flow([
    "T[メッセージ本文] --> B[ブロック解析]",
    "B --> C{フェンス種別?}",
    "C -->|ts / bash| H[ハイライト]",
    "C -->|mermaid| G[図レイアウト]",
    "C -->|$$| M[数式レイアウト]",
    "C -->|なし| I[インライン解析]",
    "H --> X[React 要素]",
    "G --> X",
    "M --> X",
    "I --> X",
  ]);
  for (const left of diagram.boxes) {
    for (const right of diagram.boxes) {
      if (left === right) continue;
      assert.ok(!overlaps(left, right), `${left.label} と ${right.label} が重なる`);
    }
  }
  const right = Math.max(...diagram.boxes.map((box) => box.x + box.w));
  assert.ok(diagram.width >= right);
  assert.ok(diagram.height >= Math.max(...diagram.boxes.map((box) => box.y + box.h)));
});

test("flowchart: 逆向きのエッジと自己ループでも落ちない", () => {
  const diagram = flow(["a --> b", "b --> a", "a -.-> a"]);
  assert.equal(diagram.edges.length, 3);
  const [a] = diagram.boxes;
  const back = diagram.edges[1].points;
  const end = back[back.length - 1];
  // 戻るエッジも相手の境界で止まる (外側のレーンから横に入る)
  assert.equal(end.y, a.y + a.h / 2);
  assert.equal(end.x, a.x + a.w);
  assert.equal(diagram.edges[2].points.length, 4);
  assert.equal(diagram.edges[2].dashed, true);
});

/** 軸に平行な線分が矩形の内側を通るか (境界に触れるだけは交差とみなさない) */
function crosses(a: { x: number; y: number; w: number; h: number }, start: { x: number; y: number }, end: { x: number; y: number }) {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const across = left < a.x + a.w && a.x < right;
  const down = top < a.y + a.h && a.y < bottom;
  if (start.x === end.x) return start.x > a.x && start.x < a.x + a.w && down;
  return start.y > a.y && start.y < a.y + a.h && across;
}

test("flowchart: 戻るエッジは中間のノードを横切らない", () => {
  // E → A が 3 ランクを戻る (外側のレーンへ回る)
  const diagram = model([
    "flowchart LR",
    "  A[角丸のノード] --> B(丸めのノード)",
    "  B --> C{ひし形の分岐}",
    "  B -.-> D((円のノード))",
    "  C -->|はい| E[長いラベルを持つノード]",
    "  D --> E",
    "  E --> A",
  ].join("\n"));
  for (const edge of diagram.edges) {
    for (let index = 0; index < edge.points.length - 1; index += 1) {
      for (const box of diagram.boxes) {
        assert.ok(!crosses(box, edge.points[index], edge.points[index + 1]), `${box.label} を線が横切る`);
      }
    }
  }
});

test("flowchart: 裸の参照は形状つきの宣言を上書きしない", () => {
  // 1 行目で裸の `b` が出ても、あとから来た `b[あとから]` のラベルを採る
  const revised = flow(["a[最初] --> b", "a", "b[あとから]", "b --> c[終わり]"]);
  assert.deepEqual(
    revised.boxes.map((box) => box.label),
    ["最初", "あとから", "終わり"],
  );
  // 宣言済みのノードを裸で参照してもラベルは消えない
  const kept = flow(["a[ラベル] --> b[相手]", "a --> b"]);
  assert.deepEqual(
    kept.boxes.map((box) => box.label),
    ["ラベル", "相手"],
  );
});

test("sequenceDiagram: participant の宣言と自動参加", () => {
  const diagram = sequence(["participant C as client", "participant B", "C->>B: POST", "B->>D: 未宣言"]);
  assert.equal(diagram.kind, "sequence");
  assert.equal(diagram.title, "mermaid · sequenceDiagram");
  assert.deepEqual(
    diagram.boxes.map((box) => box.label),
    ["client", "B", "D"],
  );
  // ライフラインは参加者ボックスの中心を縦に通る
  assert.deepEqual(
    diagram.lifelines.map((line) => line.x1),
    diagram.boxes.map((box) => box.x + box.w / 2),
  );
  for (const line of diagram.lifelines) {
    assert.equal(line.x1, line.x2);
    assert.ok(line.y1 < line.y2);
  }
});

test("sequenceDiagram: 実線 / 破線 / 自己メッセージを区別する", () => {
  const diagram = sequence(["a->>b: 送る", "b-->>a: 返す", "a->>a: 再描画"]);
  assert.deepEqual(
    diagram.edges.map((edge) => edge.dashed),
    [false, true, false],
  );
  assert.deepEqual(
    diagram.edges.map((edge) => edge.label),
    ["送る", "返す", "再描画"],
  );
  const self = diagram.edges[2];
  assert.equal(self.points.length, 4);
  assert.equal(self.labelAt?.anchor, "start");
});

test("sequenceDiagram: メッセージは入力順に上から下へ並ぶ", () => {
  const diagram = sequence(["a->>b: 1", "b-->>a: 2", "a->>a: 3"]);
  const ys = diagram.edges.map((edge) => edge.points[0].y);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2], `y が入力順でない: ${ys.join(",")}`);
  // 相手のライフラインで止まる
  assert.deepEqual(diagram.edges[0].points[1], { x: diagram.lifelines[1].x1, y: diagram.edges[0].points[0].y });
});

test("sequenceDiagram: Note over は対象の参加者を覆う", () => {
  const diagram = sequence([
    "participant A as クライアント",
    "participant B as BFF",
    "A->>B: リクエスト",
    "Note over A: 一方だけ",
    "Note over A,B: 両方",
  ]);
  assert.deepEqual(
    diagram.notes.map((note) => note.lines),
    [["一方だけ"], ["両方"]],
  );
  const [one, both] = diagram.notes;
  const [a, b] = diagram.boxes;
  assert.ok(one.x <= a.x && one.x + one.w >= a.x + a.w);
  assert.ok(both.x <= a.x && both.x + both.w >= b.x + b.w);
  // ノートはメッセージの下に置く
  assert.ok(one.y > diagram.edges[0].points[0].y);
  assert.ok(one.y < both.y);
});

test("決定性: 同じ入力からは座標まで一致するモデルになる", () => {
  const source = [
    "flowchart TD",
    "  A[本文] --> B{種別?}",
    "  B -->|code| C[コード]",
    "  B -.->|math| D((数式))",
    "  C --> E[React]",
    "  D --> E",
  ].join("\n");
  assert.deepEqual(parseDiagram(source), parseDiagram(source));
  // CRLF でも同じモデルになる
  assert.deepEqual(model(source.replace(/\n/g, "\r\n")), model(source));
});

test("未対応の種別・方向は ok: false", () => {
  const sources = [
    "gantt\n title x",
    'pie\n "a": 1',
    "classDiagram\n A --> B",
    "stateDiagram\n [*] --> A",
    "erDiagram\n A ||--o{ B",
    "mindmap\n root((pi))",
    "journey\n title x",
    "flowchart BT\n a --> b",
    "flowchart RL\n a --> b",
    "graph RL\n a --> b",
    "flowchart\n a --> b",
    "flowchart TDX\n a --> b",
    "flowchart\n",
  ];
  for (const source of sources) {
    assert.deepEqual(parseDiagram(source), { ok: false }, `${source} は ok: false`);
  }
});

test("解釈できない非空行が 1 つでもあれば図全体が ok: false", () => {
  const sources = [
    "flowchart TD\n a --> b\n これは行ではない",
    "flowchart TD\n a -->",
    "flowchart TD\n a --> b -->",
    "flowchart TD\n a[閉じない --> b",
    "flowchart TD\n a --> |引用符なし b",
    "flowchart TD\n a --x b",
    "flowchart TD\n a ==> b",
    "flowchart TD\n a[ラベル] --> b\n subgraph x",
    "flowchart TD\n a --> b\n end",
    "flowchart TD\n direction LR",
    "sequenceDiagram\n participant A as",
    "sequenceDiagram\n A->>B 本文なし",
    "sequenceDiagram\n A->>B: ",
    "sequenceDiagram\n A->>B\n",
    "sequenceDiagram\n A->B: 未対応の矢印",
    "sequenceDiagram\n Note over A,B,C: 参加者が多い",
    "sequenceDiagram\n Note left of A: 未対応",
    "sequenceDiagram\n activate B",
    "",
    "   ",
    "%% コメントだけ",
    "sequenceDiagram",
  ];
  for (const source of sources) {
    assert.deepEqual(parseDiagram(source), { ok: false }, JSON.stringify(source));
  }
});

test("上限を超えた入力は ok: false (例外は投げない)", () => {
  const chain = Array.from({ length: DIAGRAM_MAX_NODES + 2 }, (_, index) => `n${index}`).join(" --> ");
  const edgeLines = Array.from({ length: DIAGRAM_MAX_EDGES + 1 }, () => "a --> b");
  const participants = Array.from({ length: DIAGRAM_MAX_PARTICIPANTS + 1 }, (_, index) => `participant p${index}`);
  const messages = Array.from({ length: DIAGRAM_MAX_MESSAGES + 1 }, (_, index) => `a->>b: ${index}`);
  const sources = [
    `flowchart TD\n ${chain}`,
    ["flowchart TD", ...edgeLines].join("\n"),
    ["sequenceDiagram", ...participants].join("\n"),
    ["sequenceDiagram", ...messages].join("\n"),
    `flowchart TD\n A[${"あ".repeat(DIAGRAM_MAX_LABEL + 1)}] --> B`,
    `sequenceDiagram\n A->>B: ${"あ".repeat(DIAGRAM_MAX_LABEL + 1)}`,
    `sequenceDiagram\n Note over A: ${"あ".repeat(DIAGRAM_MAX_LABEL + 1)}`,
    "flowchart TD\n a --> b\n" + "%%".repeat(DIAGRAM_MAX_LENGTH),
  ];
  for (const source of sources) {
    assert.deepEqual(parseDiagram(source), { ok: false });
  }
  // 上限ちょうどは通る (境界を 1 つずらしていない)
  assert.equal(parseDiagram(["sequenceDiagram", ...participants.slice(0, DIAGRAM_MAX_PARTICIPANTS)].join("\n")).ok, true);
  assert.equal(parseDiagram(["flowchart TD", ...edgeLines.slice(0, DIAGRAM_MAX_EDGES)].join("\n")).ok, true);
});

test("壊れた入力でも例外を投げない", () => {
  const sources = [
    "flowchart",
    "flowchart TD\n-->",
    "flowchart TD\n[]",
    "flowchart TD\nA[[]]",
    "flowchart TD\nA(((",
    "flowchart TD\n --> --> -->",
    "sequenceDiagram\n-->>",
    "sequenceDiagram\nNote over :",
    "sequenceDiagram\n: x",
    "```",
    "\u0000",
    "flowchart LR\n A((x)) --> B{y}\n B --> A\n A --> A",
    "%%",
    "%% comment\nflowchart TD\n%%\n A --> B\n%%",
  ];
  for (const source of sources) {
    assert.doesNotThrow(() => parseDiagram(source), JSON.stringify(source));
  }
});

test("lib/markdown/diagram.ts は DOM / React に依存しない", () => {
  const source = readFileSync(new URL("../src/lib/markdown/diagram.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const token of ["react", "document.", "window.", "measureText", "innerHTML", "dangerouslySetInnerHTML"]) {
    assert.ok(!code.includes(token), `diagram.ts に ${token} がある`);
  }
  assert.deepEqual([...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]), []);
});

/* ===== 描画 (react-dom/server) ===== */

function render(source: string): string {
  return renderToStaticMarkup(createElement(Diagram, { text: source }));
}

function renderBlocks(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownBlocks, { text }));
}

test("描画: SVG にインライン style を出さず、role と aria-label を持つ", () => {
  const html = render(["flowchart TD", "  a[本文] --> b{分岐}", "  b -->|yes| c((円))", "  b -.-> d(丸め)"].join("\n"));
  assert.ok(html.includes('class="md-diagram group/code"'));
  assert.ok(html.includes('class="md-diagram-head"'));
  assert.ok(html.includes("mermaid · flowchart TD"));
  assert.ok(html.includes('role="img"'));
  assert.ok(html.includes('aria-label="mermaid · flowchart TD"'));
  assert.ok(html.includes("<rect"));
  assert.ok(html.includes("<circle"));
  assert.ok(html.includes('class="md-diagram-edge md-diagram-dashed"'));
  assert.ok(!html.includes("style="), "インライン style が出ている");
  assert.ok(!html.includes("dangerouslySetInnerHTML"));
});

test("描画: marker の id は図ごとに一意になる", () => {
  const html = renderBlocks(
    ["```mermaid", "flowchart TD", " a --> b", "```", "```mermaid", "sequenceDiagram", " a->>b: x", "```"].join("\n"),
  );
  const ids = [...html.matchAll(/id="(md-diagram-arrow-[^"]*)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) {
    assert.ok(html.includes(`marker-end="url(#${id})"`), `${id} を参照するエッジが無い`);
  }
  assert.ok(!html.includes("style="));
});

test("描画: sequenceDiagram のライフラインとノートを出す", () => {
  const html = render(["sequenceDiagram", "  participant A as client", "  participant B as BFF", "  A->>B: 送る", "  B-->>A: 返す", "  A->>A: 再描画", "  Note over A: メモ"].join("\n"));
  assert.ok(html.includes('class="md-diagram-lifeline"'));
  assert.ok(html.includes('class="md-diagram-note"'));
  assert.ok(html.includes('class="md-diagram-note-label"'));
  assert.ok(html.includes("mermaid · sequenceDiagram"));
  assert.ok(!html.includes("style="));
});

test("描画: mermaid の閉じたフェンスだけを図にする", () => {
  const diagram = renderBlocks(["```mermaid", "flowchart TD", " a --> b", "```"].join("\n"));
  assert.ok(diagram.includes("md-diagram"));
  // 未終端のフェンスは従来どおり生成中
  const streaming = renderBlocks(["```mermaid", "flowchart TD", " a --> b"].join("\n"));
  assert.ok(!streaming.includes("md-diagram"));
  assert.ok(streaming.includes("生成中…"));
  // 他の言語は注記なしのコードブロック
  const plantuml = renderBlocks(["```plantuml", "@startuml", "A -> B", "@enduml", "```"].join("\n"));
  assert.ok(!plantuml.includes("md-diagram"));
  assert.ok(!plantuml.includes("未対応の記法"));
  assert.ok(plantuml.includes("plantuml"));
});

test("描画: 解析できない図はソースと理由を出す", () => {
  const html = renderBlocks(["```mermaid", "gantt", " title x", "```"].join("\n"));
  assert.ok(html.includes("未対応の記法のためソースを表示しています"));
  assert.ok(html.includes("md-code"));
  assert.ok(!html.includes("md-diagram"));
  assert.ok(!html.includes("style="));
});
