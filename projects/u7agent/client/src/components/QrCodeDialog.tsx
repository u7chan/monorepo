import { useEffect, useRef } from "react";
import type { SharedContentResponse } from "../types";
import { ModalDialog, type ModalDialogHandle } from "./ModalDialog";
import { QrCodeView } from "./QrCodeView";

export type QrCodeDialogProps = {
  /** 表示対象。開いた後に null になったら（一覧の更新で条件から外れた）閉じる */
  item: SharedContentResponse | null;
  onClose: () => void;
};

/** 共有物の公開 URL を QR で見せるモーダル。QR・URL・開く・コピーの併置は `QrCodeView` が持つ */
export function QrCodeDialog({ item, onClose }: QrCodeDialogProps) {
  const shellRef = useRef<ModalDialogHandle | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 一覧の更新で対象が消えたとき、退場の間は最後の対象を描く。null を描くと
  // 「QR コードを作れませんでした」に変わり、閉じる直前に別の面が見える
  const lastItemRef = useRef<SharedContentResponse | null>(item);
  if (item !== null) lastItemRef.current = item;
  const shown = item ?? lastItemRef.current;

  useEffect(() => {
    if (item === null) shellRef.current?.requestClose();
  }, [item]);

  // 主操作は閉じるだけなので、開いたら「閉じる」に置く（破壊的な操作を Enter で確定させない）
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const url = shown?.publicUrl ?? null;

  return (
    <ModalDialog
      frame="narrow"
      handleRef={shellRef}
      onClosed={onClose}
      label={shown === null ? "QR コード" : `${shown.name} の QR コード`}
    >
      <div className="flex max-h-[min(88dvh,760px)] flex-col">
        <header className="shrink-0 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-strong">QR コード</h2>
          {shown === null ? null : (
            <p className="line-clamp-2 min-w-0 text-2xs break-words text-ink-muted" title={shown.name}>
              {shown.name}
            </p>
          )}
        </header>

        <div className="grid min-h-0 content-start gap-3 overflow-y-auto px-4 py-3.5">
          {url === null ? null : <QrCodeView url={url} />}
        </div>

        <footer className="flex shrink-0 items-center justify-end border-t border-line px-4 py-3">
          <button
            ref={closeRef}
            type="button"
            onClick={() => shellRef.current?.requestClose()}
            className="btn-quiet singleColumn:min-h-11"
          >
            閉じる
          </button>
        </footer>
      </div>
    </ModalDialog>
  );
}
