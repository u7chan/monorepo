import { useState } from "react";
import { agentIconOf } from "../../lib/agentIcon";
import { cn } from "../../lib/cn";
import { useConfirm } from "../ConfirmProvider";
import { useDiagnostics } from "../../DiagnosticsContext";
import { messageTimeLabel } from "../../lib/messageTime";
import { diagnosticsCopyNote } from "../../lib/diagnostics";
import { handoffBlockedReason } from "../../lib/sessionHandoff";
import { rawLogConfirmRequest, sessionRowActions, type SessionRowKind } from "../../lib/sidebarRowMenu";
import { sidebarStatus, type SidebarStatus } from "../../lib/sidebarStatus";
import { COPY_FAILED_TEXT } from "../chat/CopyButton";
import type { AgentDef, SessionSummary } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { BellIcon, PinIcon } from "../icons";
import { RowMenu } from "../RowMenu";

/** コピー成功のチェックを出す長さ (⋯ の既存のコピーと同じ 2 秒) */
const COPIED_MS = 2000;
/** 省略の件数を出しておく長さ。チェック (2 秒) より長く取り、読めるようにする */
const DROPS_NOTE_MS = 8000;

const DOT_TONE: Record<SidebarStatus["tone"], string> = {
  live: cn("dot-accent dot-pulse"),
  // 回答待ちは「サーバーが作業している」のではなく「利用者を待っている」ので、静止の warn で示す
  waiting: cn("dot-warn"),
  idle: cn("dot-idle"),
};

/** バッジの色は serve-badge-* に倣う。上下の余白を持たず、2 行目の高さと折り返しを変えない */
const LABEL_TONE: Record<SidebarStatus["tone"], string> = {
  live: cn("border-accent/40 bg-accent/10 text-accent-text"),
  waiting: cn("border-warn/40 bg-warn/10 text-warn"),
  idle: "",
};

type RowFailure = {
  message: string;
  /** コピーに失敗しても内容は捨てず、そのままファイル保存へ回せるようにする */
  detail?: string;
  save?: { text: string; fileName: string };
};

/** 行の選択と ⋯ の操作は別の button にする (入れ子の interactive control を作らない) */
export function SessionRow({
  item,
  agents,
  active,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  onHandoff,
}: {
  item: SessionSummary;
  /** アイコンはカタログから live 解決する (定義を編集すると既存セッションの表示も変わる) */
  agents: AgentDef[];
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  /** 未指定の呼び出し側には引き継ぎの項目を出さない (操作の受け取りと表示を揃える) */
  onHandoff?: () => void;
}) {
  const diagnostics = useDiagnostics();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<RowFailure | null>(null);
  const status = sidebarStatus(item.status, item.awaitingAnswer === true);
  const bits = [
    item.agentName,
    // 同じ表記をセッション一覧にも使う (locale 依存の toLocaleTimeString をやめる)
    messageTimeLabel(item.lastUsedAt),
  ].filter(Boolean);
  // kind から行の props を引く表。actions と同じ種別に狭め、表の無い kind を型で検出する
  const handlers: Record<SessionRowKind, (() => void) | undefined> = {
    pin: onTogglePin,
    rename: onRename,
    handoff: onHandoff,
    diagnostics: () => void copyDiagnostics(),
    "raw-log": () => void downloadRawLog(),
    delete: onDelete,
  };

  /** 診断の取得とコピー。失敗しても取れた内容を捨てず、行の下に保存の逃げ道を出す */
  async function copyDiagnostics(): Promise<void> {
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const result = await diagnostics.copy(item.sessionId);
      // 上限で落ちた件数は ⋯ のチェックだけでは伝わらない。コピーの成否にかかわらず行へ出し、
      // 失敗して保存へ回ったときも、渡る内容が完全でないことを残す
      const noteText = diagnosticsCopyNote(result.report, result.ok);
      if (noteText !== "") {
        setNote(noteText);
        window.setTimeout(() => setNote(null), DROPS_NOTE_MS);
      }
      if (result.ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
        return;
      }
      setFailure({
        message: COPY_FAILED_TEXT,
        detail: result.detail,
        save: { text: result.text, fileName: result.fileName },
      });
    } finally {
      setBusy(false);
    }
  }

  /** 開示の確認を取ってから保存する (生ログは mask 前の値を含む) */
  async function downloadRawLog(): Promise<void> {
    if (!(await confirm(rawLogConfirmRequest(item.title)))) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const result = await diagnostics.downloadRaw(item.sessionId);
      if (!result.ok) setFailure({ message: `生ログを保存できませんでした`, detail: result.detail });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      <div
        className={cn(
          "group flex min-h-10.5 items-center gap-1 rounded-lg border pr-1.5 transition-colors singleColumn:min-h-11",
          active ? "border-accent/35 bg-accent-wash" : "border-transparent bg-soft hover:bg-hover",
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-current={active ? "true" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
        >
          {/* 圧縮も「サーバーが動いている」ので実行中と同じ点で示す (区別はラベルが担う) */}
          <span className={cn("dot", DOT_TONE[status.tone])} aria-hidden />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              {item.pinned ? (
                <span role="img" aria-label="ピン留め中" title="ピン留め中" className="shrink-0 text-accent-text">
                  <PinIcon small />
                </span>
              ) : null}
              <strong className="truncate text-xs text-ink">{item.title || "無題のセッション"}</strong>
            </span>
            <small className="flex min-w-0 items-center gap-1 text-2xs text-ink-muted">
              {/* アイコンはエージェント名の隣にだけ置く (名前が無いセッションでは時刻から始める) */}
              {item.agentName ? <AgentIcon icon={agentIconOf(agents, item.agentId)} variant="inline" /> : null}
              <span className="flex-1 truncate">{bits.join(" · ")}</span>
              {/* 状態ラベルは truncate の外に置く (長いエージェント名でも切れない)。
                  ラベルは button 内の可視テキストなので、読み上げ名にはそのまま入る */}
              {status.label ? (
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-1.5 leading-none whitespace-nowrap",
                    LABEL_TONE[status.tone],
                  )}
                  title={status.label}
                >
                  {status.label}
                </span>
              ) : null}
            </small>
          </span>
        </button>
        {/* 通知が On の会話だけ鳴っているベルを出す (Off は印を出さず、一覧が記号で埋まらないようにする) */}
        {item.notify ? (
          <span role="img" aria-label="通知オン" title="通知オン" className="shrink-0 text-accent-text">
            <BellIcon ringing />
          </span>
        ) : null}
        <RowMenu
          name={item.title || "無題のセッション"}
          // 引き継ぎは受取りがある行に出し、実行中・圧縮中・片付け中は無効にして理由を説明行へ出す
          actions={sessionRowActions({
            pinned: item.pinned === true,
            canHandoff: onHandoff !== undefined,
            open: active,
            hasRawLog: item.hasRawLog === true,
            ...(onHandoff === undefined ? {} : { handoffBlockedReason: handoffBlockedReason(item) }),
          })}
          copied={copied}
          busy={busy}
          onSelect={(kind) => handlers[kind]?.()}
        />
      </div>
      {failure ? (
        <RowFailureLine failure={failure} onSave={({ text, fileName }) => diagnostics.saveText(text, fileName)} />
      ) : null}
      {note ? (
        <p role="status" className="pb-1 pl-2 text-2xs leading-relaxed text-ink-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 行の直下に出す失敗の 1 行 (ファイルツリーのパスコピー失敗と同じ作法)。コピーに失敗しても内容は
 * 残っているため、そのままファイルへ保存できる逃げ道を置く。
 */
function RowFailureLine({
  failure,
  onSave,
}: {
  failure: RowFailure;
  onSave: (save: { text: string; fileName: string }) => void;
}) {
  const save = failure.save;
  return (
    <div role="alert" className="grid gap-0.5 pb-1 pl-2 text-2xs leading-relaxed text-danger-text">
      <span>{failure.message}</span>
      {failure.detail ? <span className="break-words text-ink-faint">{failure.detail}</span> : null}
      {save ? (
        <button type="button" className="justify-self-start underline" onClick={() => onSave(save)}>
          ファイルとして保存
        </button>
      ) : null}
    </div>
  );
}
