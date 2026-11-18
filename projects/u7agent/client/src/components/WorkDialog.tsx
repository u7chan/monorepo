import { useEffect, useRef, type FormEvent, type ReactNode, type RefObject } from "react";
import { cn } from "../lib/cn";
import { CloseIcon } from "./icons";

export type WorkDialogNote = {
  /** フッターの 1 行。エラー / 実行できない理由 / 案内のどれを出すかは呼び出し側が決める */
  text: string;
  /** エラー・実行できない理由として読ませる (alert で読み上げ、danger 色) */
  danger: boolean;
};

export type WorkDialogProps = {
  /** ヘッダー左上の小さい英字 (面の種類) */
  eyebrow: string;
  /** 見出し。読み上げ名 (`aria-label`) も兼ねる */
  title: string;
  /** 実行中。ヘッダーの X / キャンセル / Escape を止める (docs/testing.md の「実行中は閉じない」) */
  busy: boolean;
  /** 閉じる。X とキャンセルは同じ経路を通る */
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /**
   * 初期焦点を置く要素 (フッターのキャンセル)。実行できない操作を Enter で確定させないためキャンセルへ置く。
   * 呼び出し側の ref 名は問わない (`cancelRef` / `closeRef` のどちらでも渡せる)
   */
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  note: WorkDialogNote;
  /** 主ボタン。`tone` は元に戻せない操作だけ danger にする */
  submit: { label: string; tone: "primary" | "danger"; disabled: boolean };
  singleColumn?: boolean;
  /** 本文 (スクロール領域の中身)。選択 UI・トグル・確認文言は呼び出し側が持つ */
  children: ReactNode;
};

/**
 * 作業面のダイアログの殻。ヘッダー (種類の英字 / 見出し / X)・本文スクロール領域・フッター (注記 /
 * キャンセル / 主ボタン) と、モーダルの標準挙動を前提にした後始末を 1 か所に持つ。
 * 閉じる導線は docs/testing.md の型に従う: X とキャンセルの両方から閉じ、実行中 (`busy`) は
 * Escape / X / キャンセルを止め、初期焦点はキャンセルに置く。背面の inert 化・Tab の拘束・Escape の
 * 終了は `showModal()` の標準挙動に任せ、開く前に当たっていた要素へ焦点を戻す。
 */
export function WorkDialog({
  eyebrow,
  title,
  busy,
  onClose,
  onSubmit,
  initialFocusRef,
  note,
  submit,
  singleColumn = false,
  children,
}: WorkDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      // 直前の cleanup でフォーカスが背面へ戻されている (StrictMode)
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, []);

  // 初期焦点は取り消し側に置く (元に戻せない操作を Enter で確定させない)
  useEffect(() => {
    initialFocusRef.current?.focus();
  }, [initialFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      // Escape はダイアログだけを閉じる (背面の「設定ページから戻る」などへ届かせない)
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      // 実行中は閉じさせない (作った / 移した結果を取りこぼさない)
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      className={cn(
        "flex flex-col overflow-hidden border-line bg-panel p-0 text-ink",
        singleColumn
          ? "m-0 h-dvh max-h-none w-screen max-w-none rounded-none border-0"
          : "m-auto max-h-[min(88dvh,760px)] w-[min(420px,92vw)] rounded-xl border shadow-panel",
      )}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">{eyebrow}</div>
          <h2 className="text-md font-semibold text-ink-strong">{title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          title="閉じる"
          className="btn-quiet size-9 shrink-0 p-0 singleColumn:size-11"
          disabled={busy}
        >
          <CloseIcon />
        </button>
      </header>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 scrollbar-thin content-start gap-3.5 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          {children}
        </div>

        <footer className="grid shrink-0 gap-1.5 border-t border-line px-4 py-3">
          {/* 注記はボタン行の上に固定する (長い理由でボタンが縦中央に浮かない) */}
          <p
            role={note.danger ? "alert" : undefined}
            className={cn("min-w-0 text-1xs leading-relaxed", note.danger ? "text-danger-text" : "text-ink-muted")}
          >
            {note.text}
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              ref={initialFocusRef}
              type="button"
              onClick={onClose}
              className="btn-quiet singleColumn:min-h-11"
              disabled={busy}
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={submit.disabled}
              className={
                submit.tone === "danger" ? "btn-danger singleColumn:min-h-11" : "btn-primary singleColumn:min-h-11"
              }
            >
              {submit.label}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
