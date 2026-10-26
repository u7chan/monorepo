import { useEffect, useRef } from "react";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { qrCodeModules, qrCodePath, qrCodeViewSize } from "../lib/qrCode";
import type { SharedContentResponse } from "../types";
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const open = item !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      // 対象が消えた / 状態が変わった。条件付き描画で消さず、close() で焦点を戻す
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, [open]);

  // 主操作は閉じるだけなので、開いたら「閉じる」に置く（破壊的な操作を Enter で確定させない）
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const url = item?.publicUrl ?? null;
  const itemId = item?.id ?? "";
  const qr = url === null ? null : qrCodeModules(url);
  const viewSize = qr === null ? 0 : qrCodeViewSize(qr.size);
  const copied = item !== null && copiedId === item.id;
  const failure = item === null ? undefined : copyFailure(item.id);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label={item === null ? "QR コード" : `${item.name} の QR コード`}
      tabIndex={-1}
      // Escape はダイアログだけを閉じる。設定ページの「戻る」など背面の keydown へ届かせない
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className="m-auto max-h-[min(88dvh,760px)] w-[min(420px,92vw)] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-panel"
    >
      <div className="flex max-h-[min(88dvh,760px)] flex-col">
        <header className="shrink-0 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-strong">QR コード</h2>
          {item === null ? null : (
            <p className="line-clamp-2 min-w-0 text-2xs break-words text-ink-muted" title={item.name}>
              {item.name}
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
            onClick={() => dialogRef.current?.close()}
            className="btn-quiet singleColumn:min-h-11"
          >
            閉じる
          </button>
        </footer>
      </div>
    </dialog>
  );
}
