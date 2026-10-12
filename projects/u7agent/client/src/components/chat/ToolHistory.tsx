import { useEffect, useRef, useState } from "react";
import type { ToolCard } from "../../hooks/chatReducer";
import { cn } from "../../lib/cn";
import { selectCopyTarget } from "../../lib/copyToClipboard";
import { generationBadgesOf, generationInfoOf, type GenerationBadge } from "../../lib/generationInfo";
import { abbreviatedToolSummary, completedToolCards, historyPreview } from "../../lib/toolSummary";
import { toolDurationMs, toolTimeTotalMs } from "../../lib/toolTiming";
import { formatDurationMs } from "../../lib/usageFormat";
import { DisclosureChevronIcon } from "../icons";
import { CopyButton } from "./CopyButton";

// 位相ラベルの幅を固定する。位相で文字幅が変わると (実測 実行中 27 / エラー 25.3px) 右隣の実行時間と
// サマリーの truncate 境界が動く。幅を rem にすると既定フォント 14px で折り返すため 3.25em + nowrap で固定する
const PHASE_LABEL_CLASS = cn("w-[3.25em] shrink-0 text-right font-sans text-3xs whitespace-nowrap");

// 実行時間の列。値が無い行でもスロットを残し、行の右端とサマリーの truncate 境界を動かさない
// (計測前 / 停止で終了イベントが来なかったカードは空になる)。幅は位相ラベルと同じ桁に揃える
const DURATION_CLASS = cn(
  "w-[3.25em] shrink-0 text-right font-sans text-3xs whitespace-nowrap text-ink-faint tabular-nums",
);

/** 履歴へ 1 件差し込まれた合図を光らせている時間。CSS (index.css) の長さと揃える */
const SLOT_FLASH_MS = 520;

/**
 * 生成に使ったモデルのチップ。位相ラベルと同じく縮まない枠にし、モデルが長くても 1 行に収める
 * (切れた全文は hover で読める)。省略記号の位置は幅で決まるが、id 自身は失わせない。
 */
function ModelChip({ marker, text, title }: { marker: string; text: string; title: string }) {
  return (
    <span
      data-generation-chip={marker}
      title={title}
      className="max-w-40 shrink-0 truncate rounded-sm border border-accent/40 bg-accent-wash px-1.5 py-px font-sans text-3xs text-accent-text"
    >
      {text}
    </span>
  );
}

/**
 * ヘッダに出すモデル。生成ツールの行が 1 つも無ければ出さず、混在は片方だけを見せずに内訳を title へ置く
 * (どの行がどのモデルかは行のチップが担う)。
 */
function historyModelChip(
  badges: readonly GenerationBadge[],
): { marker: string; text: string; title: string } | undefined {
  const models = [...new Set(badges.map((badge) => badge.info.model))];
  if (models.length === 0) return undefined;
  if (models.length === 1) return { marker: models[0], text: models[0], title: models[0] };
  return { marker: "mixed", text: "複数モデル", title: models.join(" / ") };
}

/** 完了は既定なので出さず、スロットだけ残して行の右端が動かないようにする (位相の規則は docs/frontend.md) */
function PhaseLabel({ phase }: { phase: ToolCard["phase"] }) {
  if (phase === "done") return <span className={PHASE_LABEL_CLASS} />;
  return (
    <span className={cn(PHASE_LABEL_CLASS, phase === "failed" ? "text-danger-text" : "text-accent-text")}>
      {phase === "failed" ? "エラー" : "実行中"}
    </span>
  );
}

function ToolCallRow({
  card,
  index,
  copied,
  failure,
  compact,
  onCopy,
}: {
  card: ToolCard;
  index: number;
  copied: boolean;
  failure?: string;
  compact: boolean;
  onCopy: () => void;
}) {
  const durationMs = toolDurationMs(card);
  const generation = generationInfoOf(card);
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <li className="min-w-0">
      <details
        className={cn(
          "rounded-lg border bg-soft/20 transition-colors",
          card.phase === "failed" ? "border-danger/50" : "border-line/70",
        )}
      >
        <summary className="disclosure-summary flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
          <DisclosureChevronIcon />
          <span className="w-6 shrink-0 font-sans text-3xs text-ink-ghost tabular-nums">
            {String(index + 1).padStart(2, "0")}
          </span>
          {generation === undefined ? null : (
            <ModelChip marker={generation.model} text={generation.model} title={generation.model} />
          )}
          <span className="min-w-0 flex-1 truncate">{abbreviatedToolSummary(card)}</span>
          <PhaseLabel phase={card.phase} />
          <span className={DURATION_CLASS}>{durationMs === undefined ? "" : formatDurationMs(durationMs)}</span>
        </summary>
        {/* コピーは行に常時出すと実行時間の列と競合するため、展開した本文の右上に置く (行の hover では出さない) */}
        <div className={cn("border-t border-line/70 py-2 pr-2 text-ink-muted", compact ? "pl-3" : "pl-6")}>
          <div className="flex items-start gap-2">
            <div ref={bodyRef} className="grid min-w-0 flex-1 gap-1.5">
              {card.args ? (
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">引数</span>
                  {/* min-w-0 が無いと Grid item の min-width: auto が残り、break-words では折り返さずにカードの外へ広がる */}
                  <code className="min-w-0 break-words whitespace-pre-wrap">{card.args}</code>
                </div>
              ) : null}
              {card.phase === "running" ? (
                <div className="text-accent-text">実行中…</div>
              ) : card.output ? (
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">出力</span>
                  <pre className="m-0 min-w-0 font-mono break-words whitespace-pre-wrap">{card.output}</pre>
                </div>
              ) : null}
            </div>
            <CopyButton
              copied={copied}
              failure={failure}
              onClick={onCopy}
              onSelect={() => selectCopyTarget(bodyRef.current)}
              label="ツールコールをコピー"
            />
          </div>
        </div>
      </details>
    </li>
  );
}

/**
 * ツール履歴。進行中のターンでは実行中のカードを出さず (ライブ表示が受け持つ)、「すべてコピー」も
 * 出さない (伸びている途中の断片をコピらせない)。表示条件の根拠は docs/frontend.md が正。
 */
export function ToolHistoryView({
  cards,
  hasResponse,
  live,
  copiedId,
  copyFailure,
  failureAll,
  copiedAll,
  onCopyAll,
  compact,
  onCopyTool,
}: {
  cards: ToolCard[];
  hasResponse: boolean;
  /** 進行中のターンか (完了までコピーを出さない根拠) */
  live: boolean;
  copiedId: string;
  /** 失敗の内訳 (行の id で引く) */
  copyFailure: (id: string) => string | undefined;
  /** 「すべてコピー」の失敗の内訳。id は呼び出し側 (バブル) が決める */
  failureAll?: string;
  copiedAll: boolean;
  onCopyAll: () => void;
  compact: boolean;
  onCopyTool: (card: ToolCard) => void;
}) {
  const shown = live ? completedToolCards(cards) : cards;
  const running = shown.some((card) => card.phase === "running");
  const listRef = useRef<HTMLOListElement>(null);
  // 並列実行の重なりを 1 回だけ数えた合計。区間が閉じたカードが揃わないときは出さない
  const totalMs = toolTimeTotalMs(shown);
  const modelChip = historyModelChip(generationBadgesOf(shown));

  // 1 件増えた瞬間だけ見出しを光らせる。key を変えて要素ごと作り直すので、連続で差し込まれても
  // 毎回最初から光る
  const [flashKey, setFlashKey] = useState(0);
  const previousCount = useRef(shown.length);
  useEffect(() => {
    if (shown.length <= previousCount.current) {
      previousCount.current = shown.length;
      return;
    }
    previousCount.current = shown.length;
    setFlashKey(shown.length);
    const timer = setTimeout(() => setFlashKey(0), SLOT_FLASH_MS);
    return () => clearTimeout(timer);
  }, [shown.length]);

  // ライブ側が同内容を出している間は、空の見出し (「ツール履歴 0件」) を残さない
  if (shown.length === 0) return null;

  return (
    <details
      className={cn(
        "min-w-0 border-y border-line bg-soft/20 font-mono text-2xs text-ink-muted",
        hasResponse ? "mb-2.5" : "",
      )}
    >
      <summary className="disclosure-summary relative flex min-w-0 cursor-pointer items-center gap-2 px-2 py-2 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
        <DisclosureChevronIcon />
        <span className="shrink-0 font-sans text-2xs text-ink-soft">ツール履歴</span>
        <span className="shrink-0 font-sans text-3xs text-ink-faint">{shown.length}件</span>
        {totalMs === undefined ? null : (
          <span
            title="ツール実行時間の合計（並列に走った分の重なりは 1 回だけ数えます）"
            className="shrink-0 font-sans text-3xs whitespace-nowrap text-ink-faint tabular-nums"
          >
            計 {formatDurationMs(totalMs)}
          </span>
        )}
        {modelChip === undefined ? null : <ModelChip {...modelChip} />}
        <span className="min-w-0 flex-1 truncate">{historyPreview(shown)}</span>
        {flashKey === 0 ? null : <span key={flashKey} aria-hidden="true" className="tool-history-flash" />}
        {running ? <PhaseLabel phase="running" /> : null}
        {live ? null : (
          <CopyButton
            copied={copiedAll}
            failure={failureAll}
            onClick={onCopyAll}
            onSelect={() => selectCopyTarget(listRef.current)}
            label="ツール履歴をすべてコピー"
          />
        )}
      </summary>
      <ol ref={listRef} className="m-0 grid list-none gap-1.5 border-t border-line px-2 py-2">
        {shown.map((card, index) => (
          <ToolCallRow
            key={card.id}
            card={card}
            index={index}
            copied={copiedId === `tool_${card.id}`}
            failure={copyFailure(`tool_${card.id}`)}
            compact={compact}
            onCopy={() => onCopyTool(card)}
          />
        ))}
      </ol>
    </details>
  );
}
