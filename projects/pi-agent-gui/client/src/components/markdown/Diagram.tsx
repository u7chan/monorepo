import { memo, useId, useMemo } from "react";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import { parseDiagram } from "../../lib/markdown/diagram";
import { DIAGRAM_LINE_HEIGHT } from "../../lib/markdown/diagram";
import type { DiagramBox, DiagramModel } from "../../lib/markdown/diagram";
import { CopyButton, REVEAL_CODE } from "../chat/CopyButton";
import { CodeBlock } from "./CodeBlock";

const FALLBACK_NOTE = "未対応の記法のためソースを表示しています（対応: flowchart / sequenceDiagram）";

/**
 * 図 (mermaid サブセット) の描画。座標は lib 側のモデルが持ち、ここは SVG 要素へ写すだけにする。
 * 本番の CSP は style-src 'self' のため、インライン style は使わない (色は CSS 変数)。
 */
export const Diagram = memo(function Diagram({ text }: { text: string }) {
  const parsed = useMemo(() => parseDiagram(text), [text]);
  const { copiedId, copyMessage } = useMessageCopy();
  if (!parsed.ok) {
    // 解析できなかった図は原文を出し、対応している記法を 1 行だけ添える
    return <CodeBlock lang="mermaid" text={text} closed note={FALLBACK_NOTE} />;
  }
  return (
    <figure className="md-diagram group/code">
      <figcaption className="md-diagram-head">
        <span className="md-diagram-kind">{parsed.model.title}</span>
        <span className="md-diagram-grow" />
        <CopyButton
          copied={copiedId === "diagram"}
          onClick={() => void copyMessage(text, "diagram")}
          label="図のソースをコピー"
          revealClass={REVEAL_CODE}
        />
      </figcaption>
      <div className="md-diagram-body scrollbar-thin">
        <DiagramSvg model={parsed.model} />
      </div>
    </figure>
  );
});

function DiagramSvg({ model }: { model: DiagramModel }) {
  // 1 ページに複数の図があっても marker の id が衝突しないようにする。
  // id は url(#…) の断片になるため、記号を落として安全な文字だけにする
  const markerId = `md-diagram-arrow-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox={`0 0 ${model.width} ${model.height}`}
      width={model.width}
      height={model.height}
      role="img"
      aria-label={model.title}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path className="md-diagram-arrow" d="M0,0 L10,5 L0,10 z" />
        </marker>
      </defs>
      {model.lifelines.map((line, index) => (
        <line key={index} className="md-diagram-lifeline" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
      ))}
      {model.edges.map((edge, index) => (
        <path
          key={index}
          className={edge.dashed ? "md-diagram-edge md-diagram-dashed" : "md-diagram-edge"}
          markerEnd={`url(#${markerId})`}
          d={pathData(edge.points)}
        />
      ))}
      {model.boxes.map((box, index) => (
        <DiagramShape key={index} box={box} />
      ))}
      {model.notes.map((note, index) => (
        <g key={index}>
          <rect className="md-diagram-note" x={note.x} y={note.y} width={note.w} height={note.h} rx="6" />
          {note.lines.map((line, lineIndex) => (
            <text
              key={lineIndex}
              className="md-diagram-note-label"
              x={note.x + note.w / 2}
              y={note.y + 6 + lineIndex * DIAGRAM_LINE_HEIGHT + 11}
              textAnchor="middle"
            >
              {line}
            </text>
          ))}
        </g>
      ))}
      {model.boxes.map((box, index) =>
        box.lines.map((line, lineIndex) => (
          <text
            key={`${index}-${lineIndex}`}
            className="md-diagram-label"
            x={box.x + box.w / 2}
            y={box.y + box.h / 2 + 4 + (lineIndex - (box.lines.length - 1) / 2) * DIAGRAM_LINE_HEIGHT}
            textAnchor="middle"
          >
            {line}
          </text>
        )),
      )}
      {model.edges.map((edge, index) =>
        edge.label === null || edge.labelAt === null ? null : (
          <text
            key={index}
            className="md-diagram-edge-label"
            x={edge.labelAt.x}
            y={edge.labelAt.y}
            textAnchor={edge.labelAt.anchor}
          >
            {edge.label}
          </text>
        ),
      )}
    </svg>
  );
}

function DiagramShape({ box }: { box: DiagramBox }) {
  switch (box.shape) {
    case "round":
      return <rect className="md-diagram-node" x={box.x} y={box.y} width={box.w} height={box.h} rx={box.h / 2} />;
    case "circle":
      return <circle className="md-diagram-node" cx={box.x + box.w / 2} cy={box.y + box.h / 2} r={box.w / 2} />;
    case "diamond":
      // ひし形は分岐を表すのでアクセント色にする
      return (
        <path
          className="md-diagram-node md-diagram-accent"
          d={`M ${box.x + box.w / 2},${box.y} L ${box.x + box.w},${box.y + box.h / 2} L ${box.x + box.w / 2},${box.y + box.h} L ${box.x},${box.y + box.h / 2} Z`}
        />
      );
    default:
      return <rect className="md-diagram-node" x={box.x} y={box.y} width={box.w} height={box.h} rx="8" />;
  }
}

/** 頂点列を直交パスの `d` にする (曲線は使わない) */
function pathData(points: DiagramModel["edges"][number]["points"]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return [`M${first.x},${first.y}`, ...rest.map((point) => `L${point.x},${point.y}`)].join(" ");
}
