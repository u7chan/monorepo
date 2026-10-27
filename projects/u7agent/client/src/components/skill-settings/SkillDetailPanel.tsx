import { useRef, type ReactNode } from "react";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import { cn } from "../../lib/cn";
import { selectCopyTarget } from "../../lib/copyToClipboard";
import { FILE_SKILL_BODY_ERROR_PREFIX, FILE_SKILL_BODY_LOADING_NOTE, SKILL_TAB_BODY_LABEL } from "../../lib/fileSkills";
import { CopyButton } from "../chat/CopyButton";

/** 本文の状態。組み込みとカタログは一覧の応答の本文をそのまま ready で渡す */
export type SkillBodyState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

/** メタの 1 項目。mono は置き場のような等幅で出す値 */
export type SkillMetaItem = { label: string; value: string; mono?: boolean; title?: string };

/** 詳細の面。ファイルは root を導けるスキルだけ、使用中は読み取り専用の一覧 */
export type SkillDetailTab = "body" | "files" | "usage";

export type SkillDetailPanelProps = {
  /** タブ行 (SettingsTabs)。ページが選択状態を持つ */
  tabs: ReactNode;
  /** 置き場 / 更新 / 使用中を 1 行にまとめたメタ行 (カードにしない) */
  meta: SkillMetaItem[];
  /** メタ行の下に出す補足 (読み取り専用の断りなど) */
  note?: string;
  /** 上書きされています などの警告 */
  warning?: string;
  /** 本文タブの先頭に全文を出す説明 */
  description: string;
  body: SkillBodyState;
  activeTab: SkillDetailTab;
  /** ファイルタブの中身。選んだファイルを保つため、初回に開いたあとは渡し続ける */
  files?: ReactNode;
  /** 使用中タブの中身 (読み取り専用の一覧) */
  usage?: ReactNode;
};

/**
 * スキル詳細の共通枠。タブ → メタ行 → 本文 / ファイル / 使用中 の順に積む。
 * 説明はヘッダではなく本文タブの先頭に全文を出し、メタはカードにせず 1 行にまとめる
 * (本文の主役より先にメタのカードが並ばないようにする)。
 * タブより下は min-h-0 + overflow の残余領域にして、ファイルタブは FileBrowser の高さをそのまま使う。
 */
export function SkillDetailPanel({
  tabs,
  meta,
  note,
  warning,
  description,
  body,
  activeTab,
  files,
  usage,
}: SkillDetailPanelProps) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const bodyRef = useRef<HTMLPreElement>(null);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tabs}
      <div className="shrink-0 border-b border-line px-4 py-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-2xs">
          {meta.map((item) => (
            <span key={item.label} className="flex min-w-0 items-baseline gap-1">
              <span className="shrink-0 text-ink-faint">{item.label}</span>
              {item.mono ? (
                <code className="min-w-0 truncate text-ink-soft" title={item.title ?? item.value}>
                  {item.value}
                </code>
              ) : (
                <span className="min-w-0 truncate text-ink-soft" title={item.title}>
                  {item.value}
                </span>
              )}
            </span>
          ))}
        </div>
        {warning ? <p className="mt-1 text-2xs leading-4 text-warn">{warning}</p> : null}
        {note ? <p className="mt-1 text-2xs leading-4 text-ink-muted">{note}</p> : null}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3",
          activeTab !== "body" && "hidden",
        )}
      >
        <div className="mx-auto grid max-w-3xl content-start gap-3">
          <section className="grid gap-1">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">説明</h3>
            <p className="text-1xs leading-relaxed break-words text-ink-soft">{description}</p>
          </section>
          {/* 説明と本文を分ける。本文が無いときも同じ位置に線を残し、読み込み中で行が動かないようにする */}
          <div className="grid gap-1.5 border-t border-line pt-2.5">
            {body.status === "loading" ? (
              <p className="text-2xs leading-4 text-ink-muted">{FILE_SKILL_BODY_LOADING_NOTE}</p>
            ) : body.status === "error" ? (
              <p className="text-2xs leading-4 break-words text-warn">
                {FILE_SKILL_BODY_ERROR_PREFIX}: {body.message}
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
                    {SKILL_TAB_BODY_LABEL}
                  </div>
                  <CopyButton
                    copied={copiedId === "skill"}
                    failure={copyFailure("skill")}
                    onClick={() => void copyMessage(body.text, "skill")}
                    onSelect={() => selectCopyTarget(bodyRef.current)}
                    label="本文をコピー"
                  />
                </div>
                <pre
                  ref={bodyRef}
                  className="scrollbar-thin overflow-x-hidden overflow-y-visible rounded-lg border border-line bg-soft px-2.5 py-2 font-mono text-2xs leading-relaxed wrap-anywhere whitespace-pre-wrap text-ink-soft select-text"
                >
                  {body.text}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
      {/* ファイルタブは残余領域の高さをそのまま使う (grid item にして FileBrowser の h-full を効かせる) */}
      {files ? (
        <div
          className={cn(
            activeTab === "files"
              ? "grid min-h-0 flex-1 scrollbar-thin grid-rows-1 overflow-x-hidden overflow-y-auto"
              : "hidden",
          )}
        >
          {files}
        </div>
      ) : null}
      {usage ? (
        <div
          className={cn(
            activeTab === "usage"
              ? "min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3"
              : "hidden",
          )}
        >
          <div className="mx-auto grid max-w-3xl content-start gap-2">{usage}</div>
        </div>
      ) : null}
    </section>
  );
}
