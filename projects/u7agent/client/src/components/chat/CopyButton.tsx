import type { MouseEvent } from "react";
import { cn } from "../../lib/cn";

const COPY_DONE_TEXT = "コピーしました";
/** 失敗の文言。パスをコピー (FileBrowser の行) も同じ字面を出す */
export const COPY_FAILED_TEXT = "コピーできませんでした";

/** コピーボタンの出し方。group 名は使う側の親要素と対にする */
export type CopyReveal = "message" | "code";

/** ホバーできる端末だけホバー / フォーカスで出し、タッチ端末は常に表示する */
const REVEAL_CLASS: Record<CopyReveal, string> = {
  message: cn("focus-visible:opacity-100 can-hover:opacity-0 can-hover:group-hover/bubble:opacity-100"),
  code: cn("focus-visible:opacity-100 can-hover:opacity-0 can-hover:group-hover/code:opacity-100"),
};

// 2 枚の紙を閉じた矩形で重ねると 14px では交差線が潰れるため、後ろの紙は開いたパスで描く
function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="M12 9.75H13A1.25 1.25 0 0 1 14.25 8.5V3.5A1.25 1.25 0 0 0 13 2.25H8A1.25 1.25 0 0 0 6.75 3.5v1" />
      <path d="M3.5 6.75h5A1.25 1.25 0 0 1 9.75 8v5A1.25 1.25 0 0 1 8.5 14.25h-5A1.25 1.25 0 0 1 2.25 13V8A1.25 1.25 0 0 1 3.5 6.75Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      {/* 経路の長さを知らずに CSS の dash で書き出せるよう、pathLength を 1 に固定する */}
      <path className="copy-check-mark" pathLength={1} d="M3.5 8.5 6.75 11.5 12.5 4.75" />
    </svg>
  );
}

export function CopyButton({
  copied,
  failure,
  onSelect,
  onClick,
  label,
  reveal,
  compact = false,
}: {
  copied: boolean;
  /** 失敗の内訳。未指定は「失敗していない」(通知を出すかどうかの根拠) */
  failure?: string;
  /** 失敗時にコピー対象を選択状態にする導線。対象が画面に出ていないコピーでは渡さない */
  onSelect?: () => void;
  onClick: () => void;
  label: string;
  /** 省略すると常に表示する */
  reveal?: CopyReveal;
  /** メタ行のような小さい字の中に置くときの小さい寸法 (アイコンはそのまま) */
  compact?: boolean;
}) {
  const failed = failure !== undefined;
  // summary の中に置くため、クリックを既定動作 (details の開閉) と親へ伝えない
  const handleClick = (handler: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    handler();
  };
  const stateLabel = failed ? COPY_FAILED_TEXT : copied ? COPY_DONE_TEXT : label;
  return (
    <>
      <button
        type="button"
        aria-label={stateLabel}
        title={stateLabel}
        onClick={handleClick(onClick)}
        className={cn(
          "grid shrink-0 place-items-center rounded-md transition-[opacity,color] duration-200",
          compact ? "size-5" : "size-6",
          copied
            ? "text-ok opacity-100"
            : failed
              ? "text-danger-text opacity-100"
              : cn("text-ink-faint hover:text-accent-text", reveal ? REVEAL_CLASS[reveal] : ""),
        )}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {/* 失敗の理由は実機 (iOS) でも読めるように画面へ出す (専用のデバッグ表示は作らない。docs/file-preview.md#コピー) */}
      {failed ? (
        <span role="alert" className="min-w-0 text-2xs leading-relaxed text-danger-text">
          <span className="block">{COPY_FAILED_TEXT}</span>
          <span className="block break-words text-ink-faint">{failure}</span>
          {onSelect === undefined ? null : (
            <button
              type="button"
              onClick={handleClick(onSelect)}
              title="コピーする対象を選択する"
              className="mt-0.5 rounded-sm border border-danger/40 px-1 text-3xs transition-colors hover:bg-danger/10"
            >
              選択
            </button>
          )}
        </span>
      ) : null}
    </>
  );
}
