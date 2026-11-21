// CopyButton Component - アイコンボタン1つでコピーし、完了をチェックマークで返す

import { CheckIcon, CopyIcon } from "./icons";

/** ホバーできる端末だけホバー / フォーカスで出し、タッチ端末は常に表示する。group 名は使う側と対にする */
export const REVEAL_CARD =
  "can-hover:opacity-0 can-hover:group-hover/card:opacity-100 focus-visible:opacity-100";

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
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={onClick}
      className={[
        "hit-area grid size-8 shrink-0 place-items-center rounded-full",
        "transition-[opacity,color,background-color] duration-200 can-hover:hover:bg-fill active:bg-fill",
        copied
          ? "text-label opacity-100"
          : ["text-label-2 can-hover:hover:text-label", revealClass].join(" "),
      ].join(" ")}
    >
      {copied ? <CheckIcon className="size-[18px]" /> : <CopyIcon className="size-[18px]" />}
    </button>
  );
}

export default CopyButton;
