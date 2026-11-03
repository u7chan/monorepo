import type { ReactNode } from "react";
import { TRIAL_CHARGE_NOTE, trialPanelNote, trialStorageNote, type TrialPanelState } from "../../lib/contentTrials";
import { cn } from "../../lib/cn";
import type { ContentTrialArtifactUsageValue } from "../../types";
import { CheckIcon } from "../icons";

/**
 * 3 タブ共通の試行の面。見出しの段・説明の置き場・その下の保存容量・余白を 1 か所に持ち、
 * 面ごとの差は入力欄の中身だけにする（見出しを面ごとに写すと、片方だけ `div` のまま残る）。
 */
export function TrialSection({
  description,
  artifactUsage,
  children,
}: {
  description: string;
  /** 保存容量。3 タブの合計で、履歴が 0 件でも読めるよう履歴の有無に依らず見出しの下に出す */
  artifactUsage: ContentTrialArtifactUsageValue;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-2 border-t border-line pt-3">
      <div className="grid gap-0.5">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">設定に反映しない試行</h3>
        <p className="text-2xs leading-relaxed text-ink-muted">{description}</p>
      </div>
      <p className="text-2xs text-ink-faint">{trialStorageNote(artifactUsage)}</p>
      {children}
    </section>
  );
}

/**
 * 開始 / 中断と状態の 1 行。課金の注記もここで出す。注記を各面に書かせると、書いた面だけに残る。
 */
export function TrialRunControls({
  busy,
  running,
  panel,
  blocked,
  onStart,
  onCancel,
}: {
  busy: boolean;
  running: boolean;
  panel: TrialPanelState;
  /** 開始できない理由。null なら押せる */
  blocked: string | null;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy || blocked !== null} onClick={onStart}>
          <CheckIcon />
          {running ? "生成中…" : "試行する"}
        </button>
        {running ? (
          <button type="button" className="btn-quiet" disabled={busy} onClick={onCancel}>
            中断
          </button>
        ) : null}
        <p role="status" className="min-w-0 text-2xs text-ink-muted">
          {trialPanelNote(panel)}
          {blocked === null ? null : <span className="text-ink-faint">（{blocked}）</span>}
        </p>
      </div>
      <p className="text-2xs leading-relaxed text-ink-faint">{TRIAL_CHARGE_NOTE}</p>
    </>
  );
}

/**
 * 送信前の検証と試行の操作の結果。設定の注記と場所を奪い合わないよう、面の中だけに出す。
 */
export function TrialNoteLines({
  alert,
  note,
}: {
  /** クライアント側で止めた理由（音声・BGM）。無い面は null */
  alert: string | null;
  note: { text: string; error: boolean } | null;
}) {
  return (
    <>
      {alert === null ? null : (
        <p role="alert" className="text-2xs break-words text-warn">
          {alert}
        </p>
      )}
      {note === null ? null : (
        <p role="status" className={cn("text-2xs break-words", note.error ? "text-warn" : "text-ink-muted")}>
          {note.text}
        </p>
      )}
    </>
  );
}

/** 履歴が 1 件も無いときの 1 行。結果ビューポートの代わりに出す */
export function TrialEmptyNote() {
  return <p className="text-2xs text-ink-faint">まだ試行の履歴はありません。</p>;
}
