import { useRef, useState, type FormEvent } from "react";
import { cn } from "../lib/cn";
import { messageFor } from "../lib/errors";
import type { SessionForkDialogText, SessionForkRequest } from "../lib/sessionFork";
import { forkRequest } from "../lib/sessionFork";
import type { HandoffAgentChoice } from "../lib/sessionHandoff";
import { AgentChoiceList } from "./AgentChoiceList";
import { WorkDialog } from "./WorkDialog";
import type { ModalDialogHandle } from "./ModalDialog";

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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<ModalDialogHandle | null>(null);
  const currentAgent = agents.find((agent) => agent.current) ?? agents[0];
  const [agentId, setAgentId] = useState(() => currentAgent?.id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canFork = !busy && blockedNote === "" && agentId !== "";

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
        shellRef.current?.requestClose();
      } catch (err) {
        // 一覧の状態は巻き戻さず、理由だけをこの画面へ出す
        setError(messageFor(err));
        setBusy(false);
      }
    })();
  };

  return (
    <WorkDialog
      eyebrow="FORK"
      title={text.title}
      busy={busy}
      handleRef={shellRef}
      onClose={onClose}
      onSubmit={submit}
      initialFocusRef={cancelRef}
      note={{ text: error || blockedNote || text.note, danger: error !== "" || blockedNote !== "" }}
      submit={{ label: text.confirmLabel, tone: "primary", disabled: !canFork }}
      singleColumn={singleColumn}
    >
      {text.subject ? (
        <div className="grid gap-0.5">
          <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">{text.subject.label}</span>
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

      <AgentChoiceList
        label={text.agentLabel}
        agents={agents}
        agentId={agentId}
        onSelect={(id) => {
          setAgentId(id);
          setError("");
        }}
      >
        <p className={cn("break-words", agentId === currentAgent?.id ? "text-ink-muted" : "text-warn-text")}>
          {agentId === currentAgent?.id
            ? "現在のエージェントの役割・指示・ツールの許可をそのまま引き継ぎます。"
            : text.agentNote}
        </p>
      </AgentChoiceList>
    </WorkDialog>
  );
}
