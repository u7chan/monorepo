import type { ToolCard } from "../../hooks/chatReducer";
import { DisclosureChevronIcon } from "../icons";
import { CopyButton } from "./CopyButton";

const TOOL_SUMMARY_MAX_LENGTH = 96;

// 位相で文字幅が変わると (実測 実行中 27 / エラー 27.42px) 右隣のコピーボタンとサマリーの
// truncate 境界が動く。幅を rem にすると既定フォント 14px で折り返すため 3.25em + nowrap で固定する
const PHASE_LABEL_CLASS = "w-[3.25em] shrink-0 text-right whitespace-nowrap font-sans text-3xs";

function abbreviatedToolSummary(card: ToolCard): string {
  const summary = `${card.name}${card.args ? ` — ${card.args}` : ""}`.replace(/\s+/g, " ").trim();
  if (summary.length <= TOOL_SUMMARY_MAX_LENGTH) return summary || "ツール";
  return `${summary.slice(0, TOOL_SUMMARY_MAX_LENGTH - 1)}…`;
}

/** 完了は既定なので出さず、スロットだけ残して行の右端が動かないようにする */
function PhaseLabel({ phase }: { phase: ToolCard["phase"] }) {
  if (phase === "done") return <span className={PHASE_LABEL_CLASS} />;
  return (
    <span className={`${PHASE_LABEL_CLASS} ${phase === "failed" ? "text-danger-text" : "text-accent-text"}`}>
      {phase === "failed" ? "エラー" : "実行中"}
    </span>
  );
}

function historyPreview(cards: ToolCard[]): string {
  if (cards.length === 1) return abbreviatedToolSummary(cards[0]);
  const names = cards.slice(0, 3).map((card) => card.name || "ツール");
  const remainder = cards.length > names.length ? ` ほか${cards.length - names.length}件` : "";
  return `${names.join(" / ")}${remainder}`;
}

function ToolCallRow({
  card,
  index,
  copied,
  compact,
  onCopy,
}: {
  card: ToolCard;
  index: number;
  copied: boolean;
  compact: boolean;
  onCopy: () => void;
}) {
  return (
    <li className="group/row min-w-0">
      <details
        className={[
          "rounded-lg border bg-soft/20 transition-colors",
          card.phase === "failed" ? "border-danger/50" : "border-line/70",
        ].join(" ")}
      >
        <summary className="tool-summary flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
          <DisclosureChevronIcon />
          <span className="w-6 shrink-0 font-sans text-3xs text-ink-ghost tabular-nums">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="min-w-0 flex-1 truncate">{abbreviatedToolSummary(card)}</span>
          <PhaseLabel phase={card.phase} />
          <CopyButton copied={copied} onClick={onCopy} label="ツールコールをコピー" reveal="tool" />
        </summary>
        <div
          className={["grid gap-1.5 border-t border-line/70 py-2 pr-2 text-ink-muted", compact ? "pl-3" : "pl-6"].join(
            " ",
          )}
        >
          {card.args ? (
            <div className="grid min-w-0 gap-0.5">
              <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">引数</span>
              <code className="break-words whitespace-pre-wrap">{card.args}</code>
            </div>
          ) : null}
          {card.phase === "running" ? (
            <div className="text-accent-text">実行中…</div>
          ) : card.output ? (
            <div className="grid min-w-0 gap-0.5">
              <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">出力</span>
              <pre className="m-0 font-mono break-words whitespace-pre-wrap">{card.output}</pre>
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export function ToolHistoryView({
  cards,
  hasResponse,
  copiedId,
  copiedAll,
  onCopyAll,
  compact,
  onCopyTool,
}: {
  cards: ToolCard[];
  hasResponse: boolean;
  copiedId: string;
  copiedAll: boolean;
  onCopyAll: () => void;
  compact: boolean;
  onCopyTool: (card: ToolCard) => void;
}) {
  // 畳んでいても進行が分かるよう、サマリーには実行中だけを出す (完了 / エラーは各コールが見せる)
  const running = cards.some((card) => card.phase === "running");
  return (
    <details
      className={[
        "min-w-0 border-y border-line bg-soft/20 font-mono text-2xs text-ink-muted",
        hasResponse ? "mb-2.5" : "",
      ].join(" ")}
    >
      <summary className="tool-summary flex min-w-0 cursor-pointer items-center gap-2 px-2 py-2 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
        <DisclosureChevronIcon />
        <span className="shrink-0 font-sans text-2xs text-ink-soft">ツール履歴</span>
        <span className="shrink-0 font-sans text-3xs text-ink-faint">{cards.length}件</span>
        <span className="min-w-0 flex-1 truncate">{historyPreview(cards)}</span>
        {running ? <PhaseLabel phase="running" /> : null}
        <CopyButton copied={copiedAll} onClick={onCopyAll} label="ツール履歴をすべてコピー" />
      </summary>
      <ol className="m-0 grid list-none gap-1.5 border-t border-line px-2 py-2">
        {cards.map((card, index) => (
          <ToolCallRow
            key={card.id}
            card={card}
            index={index}
            copied={copiedId === `tool_${card.id}`}
            compact={compact}
            onCopy={() => onCopyTool(card)}
          />
        ))}
      </ol>
    </details>
  );
}
