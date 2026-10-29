import { useEffect, useRef, useState, type FormEvent } from "react";
import { cn } from "../lib/cn";
import type { SessionForkDialogText, SessionForkRequest } from "../lib/sessionFork";
import { forkRequest } from "../lib/sessionFork";
import type { HandoffAgentChoice } from "../lib/sessionHandoff";
import { MenuItem } from "./MenuItem";
import { CloseIcon } from "./icons";

export type SessionForkDialogProps = {
  /** 対象と確認文言。文言は lib の純関数が組み立てる (共有の確認ダイアログに select を足さない) */
  text: SessionForkDialogText;
  /** 分岐先のエージェント。現在のエージェントが先頭 (カタログから消えていても選べる) */
  agents: HandoffAgentChoice[];
  /** 実行できない理由。空なら実行できる (サーバーも同じ条件で 409 にする) */
  blockedNote: string;
  singleColumn?: boolean;
  onClose: () => void;
  /** 失敗は throw してダイアログ内に出す */
  onFork: (request: SessionForkRequest) => Promise<void>;
};

/**
 * 分岐先のエージェントを選ぶ専用ダイアログ。共有の `DialogRequest` は confirm / prompt の 2 種なので、
 * 選択を持つこの画面は `ProjectDialog` / `SessionHandoffDialog` と同じ専用部品にし、`App` が
 * 制御コンポーネントとして mount する。モーダルの標準挙動 (背面の inert 化 / Tab の拘束 / Escape) に任せる。
 */
export function SessionForkDialog({
  text,
  agents,
  blockedNote,
  singleColumn = false,
  onClose,
  onFork,
}: SessionForkDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const currentAgent = agents.find((agent) => agent.current) ?? agents[0];
  const [agentId, setAgentId] = useState(() => currentAgent?.id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canFork = !busy && blockedNote === "" && agentId !== "";

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

  // 初期焦点は取り消し側に置く (会話が増える操作を Enter で確定させない)
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canFork) return;
    const choice = agents.find((agent) => agent.id === agentId);
    if (!choice) return;
    setBusy(true);
    setError("");
    void (async () => {
      try {
        await onFork(forkRequest(choice));
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
        singleColumn
          ? "m-0 h-dvh max-h-none w-screen max-w-none rounded-none border-0"
          : "m-auto max-h-[min(88dvh,760px)] w-[min(420px,92vw)] rounded-xl border shadow-panel",
      )}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">FORK</div>
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
            <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">{text.agentLabel}</span>
            <div className="grid gap-1">
              {agents.map((agent) => (
                <MenuItem
                  key={agent.id}
                  label={agent.current ? `${agent.name}（現在）` : agent.name}
                  variant="choice"
                  selected={agent.id === agentId}
                  current="true"
                  onClick={() => {
                    setAgentId(agent.id);
                    setError("");
                  }}
                />
              ))}
            </div>
            <p className={cn("break-words", agentId === currentAgent?.id ? "text-ink-muted" : "text-warn-text")}>
              {agentId === currentAgent?.id
                ? "現在のエージェントの役割・指示・ツールの許可をそのまま引き継ぎます。"
                : text.agentNote}
            </p>
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <p
            role={error || blockedNote ? "alert" : undefined}
            className={cn(
              "min-w-0 flex-1 text-1xs leading-relaxed",
              error || blockedNote ? "text-danger-text" : "text-ink-muted",
            )}
          >
            {error || blockedNote || text.note}
          </p>
          <div className="flex items-center gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onClose}
              className="btn-quiet singleColumn:min-h-11"
              disabled={busy}
            >
              キャンセル
            </button>
            <button type="submit" disabled={!canFork} className="btn-primary singleColumn:min-h-11">
              {text.confirmLabel}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
