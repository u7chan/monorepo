import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { DialogRequest } from "../lib/confirmDialog";

export type ConfirmDialogProps = {
  request: DialogRequest;
  /** 実行する側を押した。prompt は入力値を渡す（trim などの加工は呼び出し側の規則に任せる） */
  onConfirm: (value: string) => void;
  onCancel: () => void;
};

/**
 * 共通の確認ダイアログ。モーダル dialog の標準挙動 (背面の inert 化 / Tab の拘束 / Escape での終了) に任せ、
 * 開く前に当たっていた要素へ焦点を戻す（`ProjectDialog` と同じ作法）。
 * 対象名は clamp した独立した行に出し、全文は `title` 属性で読めるようにする。
 */
export function ConfirmDialog({ request, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [value, setValue] = useState(request.kind === "prompt" ? request.defaultValue : "");

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

  // 初期焦点は取り消し側に置く (破壊的な操作を Enter で確定させない)。prompt は入力欄に置き、現在値を選ぶ
  useEffect(() => {
    if (request.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    cancelRef.current?.focus();
  }, [request.kind]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onConfirm(request.kind === "prompt" ? value : "");
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      aria-modal="true"
      aria-label={request.title}
      tabIndex={-1}
      // Escape はダイアログだけを閉じる。設定ページの「戻る」など背面の keydown へ届かせない
      // (SettingsDetailSheet と同じ理由。native dialog の Escape は伝播する)
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className="m-auto max-h-[min(88dvh,760px)] w-[min(420px,92vw)] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-panel"
    >
      <form onSubmit={submit} className="flex flex-col">
        <header className="shrink-0 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-strong">{request.title}</h2>
        </header>

        <div className="grid min-h-0 content-start gap-2.5 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          {request.subject ? (
            <div className="grid gap-0.5">
              <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
                {request.subject.label}
              </span>
              <span className="line-clamp-2 min-w-0 break-words text-ink-strong" title={request.subject.value}>
                {request.subject.value}
              </span>
            </div>
          ) : null}

          {request.body?.map((paragraph) => (
            <p key={paragraph} className="break-words text-ink-soft">
              {paragraph}
            </p>
          ))}

          {request.kind === "confirm" && request.code ? (
            <div className="grid gap-0.5">
              <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
                {request.code.label}
              </span>
              <code className="block truncate rounded-md border border-line bg-soft px-2 py-1.5 text-2xs text-ink-soft">
                {request.code.value}
              </code>
            </div>
          ) : null}

          {request.kind === "prompt" ? (
            <div className="grid gap-1">
              <label htmlFor={inputId} className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
                {request.label}
              </label>
              <input
                id={inputId}
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
                className="field text-md"
              />
            </div>
          ) : null}

          {request.kind === "confirm"
            ? request.notes?.map((note) => (
                <p key={note} className="break-words text-warn">
                  {note}
                </p>
              ))
            : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button ref={cancelRef} type="button" className="btn-quiet" onClick={onCancel}>
            {request.cancelLabel ?? "キャンセル"}
          </button>
          <button type="submit" className={request.kind === "confirm" && request.danger ? "btn-danger" : "btn-primary"}>
            {request.confirmLabel}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
