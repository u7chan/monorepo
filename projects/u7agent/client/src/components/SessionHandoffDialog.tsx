import { useRef, useState, type FormEvent } from "react";
import type { Space } from "server";
import { messageFor } from "../lib/errors";
import { handoffAgentId, type HandoffAgentChoice, type SessionHandoffDialogText } from "../lib/sessionHandoff";
import { AgentChoiceList } from "./AgentChoiceList";
import { MenuItem } from "./MenuItem";
import { ToggleSwitch } from "./ToggleSwitch";
import { WorkDialog } from "./WorkDialog";
import type { ModalDialogHandle } from "./ModalDialog";

export type SessionHandoffRequest = {
  spaceId: string;
  /** 現在のエージェントを選んだときは省略する (保存済みのスナップショットを維持する) */
  agentId?: string;
  memo: boolean;
};

export type SessionHandoffDialogProps = {
  /** 対象と確認文言。文言は lib の純関数が組み立てる (共有の確認ダイアログに select を足さない) */
  text: SessionHandoffDialogText;
  /** 引き継ぎ先のエージェント。現在のエージェントが先頭 (カタログから消えていても選べる) */
  agents: HandoffAgentChoice[];
  /** 移動先の候補。現在のスペースを含む */
  spaces: Space[];
  currentSpaceId: string;
  /** プロジェクト所属は移動先スペースを選ばない (作業ディレクトリが同じで移す先がない) */
  projectSession: boolean;
  /** メモのトグルを無効にする理由。空ならトグルできる (メッセージ 0 件では材料が無い) */
  memoDisabledReason: string;
  /** 実行できない理由。空なら実行できる (サーバーも同じ条件で 409 / 400 にする) */
  blockedNote: string;
  singleColumn?: boolean;
  onClose: () => void;
  /** 失敗は throw してダイアログ内に出す */
  onHandoff: (request: SessionHandoffRequest) => Promise<void>;
};

/**
 * 引き継ぎ先を選ぶ専用ダイアログ。共有の `DialogRequest` は confirm / prompt の 2 種なので、
 * 選択とトグルを持つこの画面は `ProjectDialog` と同じ専用部品にし、`App` が制御コンポーネントとして mount する。
 * モーダルの標準挙動 (背面の inert 化 / Tab の拘束 / Escape での終了) と焦点の復帰に任せる。
 */
export function SessionHandoffDialog({
  text,
  agents,
  spaces,
  currentSpaceId,
  projectSession,
  memoDisabledReason,
  blockedNote,
  singleColumn = false,
  onClose,
  onHandoff,
}: SessionHandoffDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<ModalDialogHandle | null>(null);
  const currentAgent = agents.find((agent) => agent.current) ?? agents[0];
  const [agentId, setAgentId] = useState(() => currentAgent?.id ?? "");
  const [target, setTarget] = useState(currentSpaceId);
  const [memo, setMemo] = useState(memoDisabledReason === "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canHandoff = !busy && blockedNote === "" && agentId !== "" && (projectSession || target !== "");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canHandoff) return;
    const choice = agents.find((agent) => agent.id === agentId);
    if (!choice) return;
    setBusy(true);
    setError("");
    void (async () => {
      try {
        await onHandoff({
          spaceId: projectSession ? currentSpaceId : target,
          ...(handoffAgentId(choice) === undefined ? {} : { agentId: handoffAgentId(choice) }),
          memo: memoDisabledReason === "" && memo,
        });
        // 閉じるまで busy を戻さない (成功後に二重送信できないように)
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
      eyebrow="HANDOFF"
      title={text.title}
      busy={busy}
      handleRef={shellRef}
      onClose={onClose}
      onSubmit={submit}
      initialFocusRef={cancelRef}
      note={{ text: error || blockedNote || text.note, danger: error !== "" || blockedNote !== "" }}
      submit={{ label: text.confirmLabel, tone: "danger", disabled: !canHandoff }}
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
      />

      {projectSession ? null : (
        <div className="grid gap-1.5">
          <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">{text.spaceLabel}</span>
          <div className="grid gap-1">
            {spaces.map((space) => (
              <MenuItem
                key={space.id}
                label={space.id === currentSpaceId ? `${space.name}（現在）` : space.name}
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
        </div>
      )}

      <div className="grid gap-1 rounded-lg border border-line px-3 py-2.5">
        <ToggleSwitch
          checked={memoDisabledReason === "" && memo}
          label={text.memoLabel}
          disabled={memoDisabledReason !== ""}
          onChange={(checked) => setMemo(checked)}
        />
        <p className="break-words text-ink-soft">
          {memoDisabledReason === "" ? text.memoDescription : memoDisabledReason}
        </p>
        {memoDisabledReason === "" && text.memoProjectNote ? (
          <p className="break-words text-ink-soft">{text.memoProjectNote}</p>
        ) : null}
      </div>
    </WorkDialog>
  );
}
