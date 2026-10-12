import type { ToolCard } from "../../lib/chatTypes";
import { cn } from "../../lib/cn";
import { generationBadgesOf, type GenerationInfo } from "../../lib/generationInfo";

// 種類は結果本文に載らない（ツール名から決まる）ため、表示名へ写すのはここ 1 箇所にする
const KIND_LABEL: Record<GenerationInfo["kind"], string> = { image: "画像", speech: "音声" };

function ImageKindIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3 shrink-0 text-accent-text"
    >
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" />
      <circle cx="5.65" cy="6.4" r="1" />
      <path d="M3 11.9 6.35 8.6c.3-.3.78-.3 1.08 0L11 12.1" />
    </svg>
  );
}

function SpeechKindIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3 shrink-0 text-accent-text"
    >
      <path d="M3.25 6.25h2L8.5 3.5v9l-3.25-2.75h-2z" />
      <path d="M11 6.2c.75.9.75 2.7 0 3.6" />
    </svg>
  );
}

/**
 * 生成 1 件のバッジ。モデルと保存パスは省略記号で切るが、全文は hover で読めるようにする
 * （どちらが切れるかは幅次第で、値そのものを失わせない）。
 */
function GenerationBadge({ info }: { info: GenerationInfo }) {
  const path = info.path;
  return (
    <li
      data-generation-kind={info.kind}
      className="flex min-w-0 items-center gap-1.5 rounded-lg border border-line/70 bg-soft/20 px-2 py-0.5"
    >
      {info.kind === "image" ? <ImageKindIcon /> : <SpeechKindIcon />}
      <span className="shrink-0 font-sans text-3xs tracking-wide text-ink-faint">{KIND_LABEL[info.kind]}</span>
      <span title={info.model} className="min-w-0 truncate text-accent-text">
        {info.model}
      </span>
      {info.voice === undefined ? null : <span className="shrink-0 text-ink-faint">ボイス {info.voice}</span>}
      {path === undefined ? null : (
        <span title={path} className="min-w-0 truncate">
          {path}
        </span>
      )}
    </li>
  );
}

/**
 * assistant バブル上部の生成バッジ。ツール履歴のチップが複数ツールの切り分けを担うのに対し、
 * ここはそのターンに何を生成したかの要約を担う。件数の上限は設けず、折り返しに任せる。
 * スキル読み込みバッジと同じ行の見た目に揃え、狭い幅では行ごとに折り返す。
 */
export function GenerationBadgeList({ cards, compact }: { cards: readonly ToolCard[]; compact: boolean }) {
  const badges = generationBadgesOf(cards);
  if (badges.length === 0) return null;
  return (
    <ul
      className={cn(
        "m-0 flex list-none flex-wrap items-start gap-1.5 font-mono text-2xs text-ink-muted",
        compact ? "mb-1.5" : "mb-2.5",
      )}
    >
      {badges.map((badge) => (
        <GenerationBadge key={badge.key} info={badge.info} />
      ))}
    </ul>
  );
}
