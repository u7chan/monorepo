import { useState } from "react";
import { splitAttachedFiles } from "../../lib/attachments";
import { cn } from "../../lib/cn";
import type { QueuedSend } from "../../lib/queueWait";
import { splitSkillBlock } from "../../lib/skillBlock";

export type QueuedSendsProps = {
  /** 実行順に並んだ待機中の送信。0 件ならブロックごと出さない */
  sends: QueuedSend[];
  /** 狭いレイアウト。角の丸みだけを状態行と揃える */
  singleColumn?: boolean;
  /** 取り消し (実行中のターンは止めず、未送信として残す)。未指定はボタンを出さない */
  onCancel?: (runId: string) => Promise<void>;
};

/** 読み上げ名に載せる本文の頭の長さ。同じ `取り消し` が最大 10 個並ぶため、対象を本文で示す */
const CANCEL_LABEL_HEAD_CHARS = 20;

/**
 * 本文から、送信の時に混ぜた注記を外して打った文面だけを取り出す。スキルだけの送信 (`/skill:name`) は
 * 引数が空になるため、打った /skill:name が読めるよう元の文面へ戻す。
 */
function queuedSendText(text: string): string {
  const { text: body } = splitAttachedFiles(text);
  const skill = splitSkillBlock(body);
  const shown = (skill ? (skill.userMessage ?? "") : body).trim();
  return shown === "" ? text : shown;
}

/** 読み上げ名用の 1 行。改行と連続する空白は畳む (truncate は CSS の見た目だけを担う) */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CANCEL_LABEL_HEAD_CHARS ? `${line.slice(0, CANCEL_LABEL_HEAD_CHARS)}…` : line;
}

/**
 * 待機中の送信のブロック。コンポーザーの直上に置き、transcript のスクロール位置に依らず見せる
 * (transcript に描くと、実行中ターンの応答が流れるほど上へ押し出されて見失う)。件数の正はここだけ。
 */
export function QueuedSends({ sends, singleColumn = false, onCancel }: QueuedSendsProps) {
  if (sends.length === 0) return null;
  return (
    <div
      className={cn("mb-1.5 border border-focus/35 bg-soft px-2.5 py-1.5", singleColumn ? "rounded-lg" : "rounded-xl")}
    >
      {/* 件数の増減だけを読み上げる。行の本文は、実行に移った時点で transcript が読み上げる */}
      <p aria-live="polite" className="m-0 text-2xs font-medium text-focus">
        送信待ち {sends.length} 件
      </p>
      {/* 行の一覧だけをスクロールさせ、入力欄と状態行を常に見える位置に残す (行が入り切らないときは
          ブロックの中でスクロールする。`取り消し` は各行に残るので全件に届く) */}
      <ul className="m-0 mt-1 flex max-h-(--queued-sends-max-height) scrollbar-thin list-none flex-col gap-0.5 overflow-y-auto p-0">
        {sends.map((send) => (
          <QueuedSendRow key={send.runId} send={send} onCancel={onCancel} />
        ))}
      </ul>
    </div>
  );
}

function QueuedSendRow({ send, onCancel }: { send: QueuedSend; onCancel?: (runId: string) => Promise<void> }) {
  // 押下から応答まで無効化する。二度押しの 2 回目はサーバーが 404 で断る
  const [canceling, setCanceling] = useState(false);
  const text = queuedSendText(send.text);

  async function cancel(): Promise<void> {
    if (!onCancel) return;
    setCanceling(true);
    try {
      await onCancel(send.runId);
    } finally {
      setCanceling(false);
    }
  }

  return (
    <li className="flex min-w-0 items-center gap-2 text-2xs">
      {send.index === undefined ? null : (
        <span aria-hidden="true" className="w-3 shrink-0 text-right text-ink-ghost tabular-nums">
          {send.index}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-ink-soft" title={text}>
        {text}
      </span>
      {onCancel ? (
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={canceling}
          aria-label={`「${oneLine(text)}」の送信を取り消す`}
          title="実行前の待機から外します。本文は未送信として残り、再送か破棄を選べます"
          className="shrink-0 cursor-pointer rounded-sm border border-focus/40 px-1 text-3xs text-focus transition-colors hover:bg-focus/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          取り消し
        </button>
      ) : null}
    </li>
  );
}
