import { useEffect, useRef } from "react";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { qrCodeModules, qrCodePath, qrCodeViewSize } from "../lib/qrCode";
import type { SharedContentResponse } from "../types";
import { ModalDialog, type ModalDialogHandle } from "./ModalDialog";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "./icons";

export type QrCodeDialogProps = {
  /** 表示対象。開いた後に null になったら（一覧の更新で条件から外れた）閉じる */
  item: SharedContentResponse | null;
  onClose: () => void;
};

/**
 * 共有物の公開 URL を QR で見せるモーダル。QR を唯一の経路にしないため、URL のテキストと
 * 開く / コピーを併置する（読み取れない端末・スクリーンリーダーでも渡せるように）。
 */
export function QrCodeDialog({ item, onClose }: QrCodeDialogProps) {
  const shellRef = useRef<ModalDialogHandle | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  // 一覧の更新で対象が消えたとき、退場の間は最後の対象を描く。null を描くと
  // 「QR コードを作れませんでした」に変わり、閉じる直前に別の面が見える
  const lastItemRef = useRef<SharedContentResponse | null>(item);
  if (item !== null) lastItemRef.current = item;
  const shown = item ?? lastItemRef.current;

  // 対象が失効したら閉じる (古い QR を開いたまま残さない)
  useEffect(() => {
    if (item === null) shellRef.current?.requestClose();
  }, [item]);

  // 主操作は閉じるだけなので、開いたら「閉じる」に置く（破壊的な操作を Enter で確定させない）
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const url = shown?.publicUrl ?? null;
  const itemId = shown?.id ?? "";
  const qr = url === null ? null : qrCodeModules(url);
  const viewSize = qr === null ? 0 : qrCodeViewSize(qr.size);
  const copied = shown !== null && copiedId === shown.id;
  const failure = shown === null ? undefined : copyFailure(shown.id);

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
          {qr === null ? (
            <p className="text-xs break-words text-warn-text">
              QR コードを作れませんでした。下の URL をコピーして渡してください。
            </p>
          ) : (
            <svg
              role="img"
              aria-label="公開 URL の QR コード"
              viewBox={`0 0 ${viewSize} ${viewSize}`}
              shapeRendering="crispEdges"
              className="mx-auto size-40 shrink-0"
            >
              {/* 白地 + 黒の固定配色。テーマのトークンだとダークテーマで反転し、カメラが読めない */}
              {/* oxlint-disable-next-line shadcn/no-raw-colors -- QR の読み取りには固定色が要る */}
              <rect width={viewSize} height={viewSize} fill="#ffffff" />
              {/* oxlint-disable-next-line shadcn/no-raw-colors -- QR の読み取りには固定色が要る */}
              <path d={qrCodePath(qr.modules)} fill="#000000" />
            </svg>
          )}

          {url === null ? null : (
            <>
              <code className="block rounded-lg border border-line bg-raised px-2.5 py-1.5 font-mono text-2xs break-all text-ink-soft select-all">
                {url}
              </code>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <a href={url} target="_blank" rel="noreferrer noopener" className="btn-quiet singleColumn:min-h-11">
                  <ExternalLinkIcon />
                  開く
                </a>
                <button
                  type="button"
                  onClick={() => {
                    void copyMessage(url, itemId);
                  }}
                  className="btn-quiet singleColumn:min-h-11"
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "コピーしました" : "URL をコピー"}
                </button>
              </div>
            </>
          )}

          {failure === undefined ? null : (
            <p role="alert" className="text-2xs break-words text-danger-text">
              コピーできませんでした。URL を選択してコピーしてください。
            </p>
          )}
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
