import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Space } from "server";
import { cn } from "../lib/cn";
import type { SessionMoveDialogText } from "../lib/sidebarRowMenu";
import { MenuItem } from "./MenuItem";
import { CloseIcon } from "./icons";

export type SessionMoveDialogProps = {
  /** 対象と確認文言。文言は lib の純関数が組み立てる (共有の確認ダイアログに select を足さない) */
  text: SessionMoveDialogText;
  /** 移動先の候補。現在のスペースは呼び出し側が除く */
  destinations: Space[];
  compact?: boolean;
  onClose: () => void;
  /** 失敗は throw してダイアログ内に出す */
  onMove: (targetSpaceId: string) => Promise<void>;
};

/**
 * 引っ越し先を選ぶ専用ダイアログ。共有の `DialogRequest` は confirm / prompt の 2 種なので、
 * 選択を持つこの画面は `ProjectDialog` と同じ専用部品にし、`App` が制御コンポーネントとして mount する。
 * モーダルの標準挙動 (背面の inert 化 / Tab の拘束 / Escape での終了) と焦点の復帰に任せる。
 */
export function SessionMoveDialog({ text, destinations, compact = false, onClose, onMove }: SessionMoveDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState(() => destinations[0]?.id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canMove = !busy && target !== "";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, []);

  // 初期焦点は取り消し側に置く (元に戻せない操作を Enter で確定させない)
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canMove) return;
    setBusy(true);
    setError("");
    void (async () => {
      try {
        await onMove(target);
        // 閉じるまで busy を戻さない (成功後に二重送信できないように)
        onClose();
      } catch (err) {
        // 一覧の状態は巻き戻さず、理由だけをこの画面へ出す
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    })();
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label={text.title}
      tabIndex={-1}
      // Escape はダイアログだけを閉じる (設定ページの「戻る」など背面の keydown へ届かせない)
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className={cn(
        "flex flex-col overflow-hidden border-line bg-panel p-0 text-ink",
        compact
          ? "m-0 h-dvh max-h-none w-screen max-w-none rounded-none border-0"
          : "m-auto max-h-[min(88dvh,760px)] w-[min(420px,92vw)] rounded-xl border shadow-panel",
      )}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">SPACE</div>
          <h2 className="text-md font-semibold text-ink-strong">{text.title}</h2>
        </div>
        <button type="button" onClick={onClose} className="btn-quiet" disabled={busy}>
          <CloseIcon />
          閉じる
        </button>
      </header>

      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 scrollbar-thin content-start gap-3.5 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          {text.subject ? (
            <div className="grid gap-0.5">
              <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
                {text.subject.label}
              </span>
              <span className="line-clamp-2 min-w-0 break-words text-ink-strong" title={text.subject.value}>
                {text.subject.value}
              </span>
            </div>
          ) : null}

          {text.body.map((paragraph) => (
            <p key={paragraph} className="break-words text-ink-soft">
              {paragraph}
            </p>
          ))}

          <div className="grid gap-1.5">
            <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">移動先のスペース</span>
            {destinations.length === 0 ? (
              <p className="break-words text-ink-muted">{text.emptyNote}</p>
            ) : (
              <div className="grid gap-1">
                {destinations.map((space) => (
                  <MenuItem
                    key={space.id}
                    label={space.name}
                    variant="choice"
                    selected={space.id === target}
                    current="true"
                    onClick={() => {
                      setTarget(space.id);
                      setError("");
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <p
            role={error ? "alert" : undefined}
            className={cn("min-w-0 flex-1 text-1xs leading-relaxed", error ? "text-danger-text" : "text-ink-muted")}
          >
            {error || text.note}
          </p>
          <div className="flex items-center gap-2">
            <button ref={cancelRef} type="button" onClick={onClose} className="btn-quiet" disabled={busy}>
              キャンセル
            </button>
            <button type="submit" disabled={!canMove} className="btn-danger">
              {text.confirmLabel}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
