// ConfirmSheet - 取り消せない操作の確認。iOS の action sheet に倣い、破壊的な選択肢を上、
// 取り消しを独立したボタンとして下に置く
//
// 以前は対象ボタンの脇に出すポップオーバーだった。幅 272px を端末の端に寄せる作りは、
// 狭い画面で内容が窮屈になり、親指の届く位置にもない。何を止めるのかは、タイトルに
// 対象の名前を入れて示す。

import { useId } from "react";
import { Sheet } from "./Sheet";

interface ConfirmSheetProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmSheet({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  onConfirm,
  onClose,
}: ConfirmSheetProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={descriptionId}
      role="alertdialog"
    >
      <div className="flex flex-col gap-2">
        <div className="overflow-hidden rounded-card bg-sheet shadow-sheet">
          <div className="px-5 pt-5 pb-4 text-center">
            <h2
              id={titleId}
              className="text-headline font-semibold [overflow-wrap:anywhere] text-label"
            >
              {title}
            </h2>
            <p id={descriptionId} className="mt-1.5 text-footnote text-label-2">
              {description}
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="block min-h-14 w-full border-t border-separator text-title-3 text-dead transition-colors duration-150 can-hover:hover:bg-fill active:bg-fill disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>

        <button
          type="button"
          data-autofocus
          onClick={onClose}
          className="min-h-14 w-full rounded-card bg-sheet text-title-3 font-semibold text-label shadow-sheet transition-colors duration-150 can-hover:hover:bg-fill active:bg-fill-strong"
        >
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

export default ConfirmSheet;
