import { useEffect, useState } from "react";
import { getContainerAction, type ContainerAction } from "../../lib/containerState";
import type { Container } from "../../types/container";
import type { ContainerCardProps } from "../ContainerCard";
import { ConfirmSheet } from "../ConfirmSheet";
import { PlayIcon, StopIcon } from "../icons";

/**
 * 起動 / 停止ボタン。停止だけは不可逆なので、押したところで確認シートを出す。
 * window.confirm をやめた理由は、ダイアログが対象のコンテナから切り離されて
 * 「何を止めるのか」が読み返せないこと。シートのタイトルに対象の名前を入れて示す。
 */
function ContainerActionButton({
  action,
  container,
  pending,
  onAction,
}: {
  action: ContainerAction;
  container: Container;
  pending: boolean;
  onAction: (action: ContainerAction) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isStart = action === "start";

  // ポーリングでコンテナの状態が変わると action が入れ替わる。開いたままの確認が
  // 次に running へ戻ったとき勝手に開かないよう、action が変わったら閉じる。
  useEffect(() => {
    setConfirmOpen(false);
  }, [action]);

  const label = isStart ? "Start" : "Stop";
  const pendingLabel = isStart ? "Starting" : "Stopping";

  const handleClick = () => {
    if (isStart) {
      onAction("start");
      return;
    }
    setConfirmOpen(true);
  };

  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-haspopup={isStart ? undefined : "dialog"}
        onClick={handleClick}
        className={[
          "hit-area inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-fill px-4",
          "text-subhead font-semibold transition-[background-color,scale] duration-150 ease-ios",
          "can-hover:hover:bg-fill-strong active:scale-[0.97] active:bg-fill-strong",
          "disabled:cursor-not-allowed disabled:opacity-60",
          pending ? "text-label-2" : "text-label",
        ].join(" ")}
      >
        {pending ? (
          <span
            aria-hidden="true"
            className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        ) : isStart ? (
          <PlayIcon className="size-3.5" />
        ) : (
          <StopIcon className="size-3.5" />
        )}
        <span>{pending ? pendingLabel : label}</span>
      </button>

      {/* 状態が変わって Start に切り替わったら、停止確認は残さない */}
      {!isStart && (
        <ConfirmSheet
          open={confirmOpen}
          title={`Stop ${container.name}?`}
          description="Its ports close immediately and open connections are dropped."
          confirmLabel="Stop"
          pending={pending}
          onConfirm={() => {
            setConfirmOpen(false);
            onAction("stop");
          }}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}

export function ContainerActionSlot({ container, pendingAction, onAction }: ContainerCardProps) {
  const action = getContainerAction(container.state);

  if (!action || !onAction) {
    return null;
  }

  return (
    <ContainerActionButton
      action={action}
      container={container}
      pending={pendingAction === action}
      onAction={(next) => onAction(container, next)}
    />
  );
}
