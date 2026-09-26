import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { CloseIcon } from "./icons";

/** 画像の出どころ。サムネイルの枠・角丸・高さは部品が持ち、呼び出し側からは渡さない */
export type ImageZoomVariant = "attachment" | "markdown";

export type ZoomableImageProps = {
  src: string;
  alt: string;
  title?: string;
  variant: ImageZoomVariant;
  /** 添付サムネイルの高さ。compact はチャットの密度が高く、狭い viewport では画像を小さく保つ */
  compact?: boolean;
};

/**
 * クリックでライトボックスを開く画像。dialog は body へ portal する。
 * 置いた場に <dialog> を出すと段落 (<p>) の中で DOM が不正になり、`.md img` の枠・角丸が拡大画像にも当たる。
 */
export function ZoomableImage({ src, alt, title, variant, compact = false }: ZoomableImageProps) {
  const [open, setOpen] = useState(false);
  // 読み込みに失敗した img は intrinsic 幅を持たない。button は fit-content の包含ブロックになり、
  // 失敗 img のサムネイルが alt テキスト幅まで縮む (main は段落幅で解決していた)。失敗した src だけを
  // 持つのは、src が変わったときに再度失敗するまで button へ戻すため
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const thumbRef = useRef<HTMLButtonElement | null>(null);
  const label = alt === "" ? "画像を拡大表示" : `${alt} を拡大表示`;

  // 閉じる操作は showModal() の標準挙動 (Escape / 背景 / 閉じるボタン) に任せ、印は close イベントで落とす
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog !== null && !dialog.open) dialog.showModal();
  }, [open]);

  const thumbnail = (
    <img
      src={src}
      alt={alt}
      title={title}
      onError={() => setFailedSrc(src)}
      className={cn(
        "object-contain",
        variant === "markdown" ? "md-img" : cn("rounded-lg border border-line", compact ? "max-h-32" : "max-h-44"),
      )}
    />
  );

  return (
    <>
      {failed ? (
        thumbnail
      ) : (
        <button
          type="button"
          ref={thumbRef}
          aria-label={label}
          onClick={() => setOpen(true)}
          className="block max-w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {thumbnail}
        </button>
      )}
      {open
        ? createPortal(
            <dialog
              ref={dialogRef}
              aria-label={label}
              onClose={() => {
                setOpen(false);
                // 閉じたら開いた場所へ focus を戻す (dialog は unmount するので行き場を失わせない)
                thumbRef.current?.focus();
              }}
              onClick={(event) => {
                if (event.target === dialogRef.current) dialogRef.current?.close();
              }}
              onKeyDown={(event) => {
                // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く。閉じるのは標準挙動に任せる
                if (event.key === "Escape") event.stopPropagation();
              }}
              className="m-0 flex h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-0"
            >
              <img src={src} alt={alt} title={title} className="max-h-full max-w-full object-contain" />
              <button
                type="button"
                aria-label="閉じる"
                onClick={() => dialogRef.current?.close()}
                className="icon-button absolute top-3 right-3"
              >
                <CloseIcon />
              </button>
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
