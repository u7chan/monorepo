// CopyButton Component - アイコンボタン1つでコピーし、完了をチェックマークで返す

/** ホバーできる端末だけホバー / フォーカスで出し、タッチ端末は常に表示する。group 名は使う側と対にする */
export const REVEAL_CARD =
  "can-hover:opacity-0 can-hover:group-hover/card:opacity-100 focus-visible:opacity-100";

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
      <path d="M3.5 8.5 6.75 11.5 12.5 4.75" />
    </svg>
  );
}

/**
 * コピーボタン。copied が true の間はチェックマークに切り替える。
 */
export function CopyButton({
  copied,
  onClick,
  label,
  revealClass,
}: {
  copied: boolean;
  onClick: () => void;
  label: string;
  revealClass: string;
}) {
  return (
    <button
      type="button"
      aria-label={copied ? "コピーしました" : label}
      title={copied ? "コピーしました" : label}
      onClick={onClick}
      className={[
        "grid size-6 shrink-0 place-items-center rounded-md transition-[opacity,color] duration-200",
        copied
          ? "text-emerald-400 opacity-100"
          : ["text-slate-500 hover:text-cyan-400", revealClass].join(" "),
      ].join(" ")}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export default CopyButton;
