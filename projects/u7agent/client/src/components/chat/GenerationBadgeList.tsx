import type { ToolCard } from "../../lib/chatTypes";
import { cn } from "../../lib/cn";
import { generationBadgesOf, type GenerationInfo } from "../../lib/generationInfo";
import { ImageKindIcon, SpeechKindIcon } from "../generationKindIcons";

// 種類は結果本文に無い（ツール名から決まる）。表示名へ写すのはここ 1 箇所に閉じる
const KIND_LABEL: Record<GenerationInfo["kind"], string> = { image: "画像", speech: "音声", bgm: "BGM" };

/**
 * 生成 1 件のバッジ。省いた値の全文は title で読めるようにし、種類だけを縮まない枠にする
 * （値に min-w-0 が無いと flex item の min-width: auto が残り、狭い幅で行が横に溢れる）。
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
      {info.voice === undefined ? null : (
        <span title={`ボイス ${info.voice}`} className="min-w-0 truncate text-ink-faint">
          ボイス {info.voice}
        </span>
      )}
      {path === undefined ? null : (
        <span title={path} className="min-w-0 truncate">
          {path}
        </span>
      )}
    </li>
  );
}

/** assistant バブル上部の生成バッジ。役割の分担と出さない条件は docs/image-generation.md#チャットのバッジ が正 */
export function GenerationBadgeList({ cards, singleColumn }: { cards: readonly ToolCard[]; singleColumn: boolean }) {
  const badges = generationBadgesOf(cards);
  if (badges.length === 0) return null;
  return (
    <ul
      // 上余白はバッジ側で持つ。ツール履歴の下マージンは本文の有無で消えるため、本文を持たない
      // ターンで罫線に密着する（隣接マージンは collapse するので本文ありでも 10px のまま）
      className={cn(
        "m-0 mt-2.5 flex list-none flex-wrap items-start gap-1.5 font-mono text-2xs text-ink-muted",
        singleColumn ? "mb-1.5" : "mb-2.5",
      )}
    >
      {badges.map((badge) => (
        <GenerationBadge key={badge.key} info={badge.info} />
      ))}
    </ul>
  );
}
