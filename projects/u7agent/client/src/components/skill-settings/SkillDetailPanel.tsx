import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import { cn } from "../../lib/cn";
import {
  FILE_SKILL_BODY_ERROR_PREFIX,
  FILE_SKILL_BODY_LOADING_NOTE,
  SKILL_BODY_READER_CLOSE_LABEL,
  SKILL_BODY_READER_OPEN_LABEL,
  SKILL_BODY_VIEW_ARIA_LABEL,
  SKILL_BODY_VIEW_MODES,
  SKILL_TAB_BODY_LABEL,
  skillBodyMetaLabel,
  skillBodyPreviewText,
  type SkillBodyView,
} from "../../lib/fileSkills";
import { CopyButton } from "../chat/CopyButton";
import { CollapseIcon, DisclosureChevronIcon, ExpandIcon } from "../icons";
import { MarkdownView } from "../markdown/MarkdownView";
import { OutputPanel } from "../OutputPanel";
import { SegmentedControl } from "../SegmentedControl";

/** 本文の状態。組み込みとカタログは一覧の応答の本文をそのまま ready で渡す */
export type SkillBodyState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

/** メタの 1 項目。mono は置き場のような等幅で出す値、copy は値のコピーボタンを添えるか */
export type SkillMetaItem = { label: string; value: string; mono?: boolean; title?: string; copy?: boolean };

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
  /** 全画面で読むときの見出し (スキル名)。読み上げ名にも使う */
  title?: string;
  /** 一覧が隠れる幅か。狭いときは説明を既定で畳み、本文へ高さを譲る */
  singleColumn?: boolean;
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
  title,
  singleColumn = false,
  body,
  activeTab,
  files,
  usage,
}: SkillDetailPanelProps) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  // 本文はまず読める形 (Markdown) で開き、原文が必要なときだけソースへ切り替える
  const [bodyView, setBodyView] = useState<SkillBodyView>("preview");
  // 狭い幅では、ページの外枠 (ヘッダ / タブ / メタ) を外した全画面の読み面へ切り替えられる。
  // 本文の DOM は 1 つだけにして、全画面のあいだはその 1 つを dialog の中へ移す (二重に解析しない)
  const [reading, setReading] = useState(false);
  const readerDialogRef = useRef<HTMLDialogElement>(null);
  const readerButtonRef = useRef<HTMLButtonElement>(null);
  const restoreReaderFocus = useRef(false);
  useEffect(() => {
    const dialog = readerDialogRef.current;
    if (reading && dialog !== null && !dialog.open) dialog.showModal();
  }, [reading]);
  useEffect(() => {
    if (reading || !restoreReaderFocus.current) return;
    restoreReaderFocus.current = false;
    readerButtonRef.current?.focus();
  }, [reading]);
  // 本文の枠。全画面の読み面でも同じ 1 つを使い回す (表示の切替と本文の解析を二重に持たない)
  const bodyPanel = (text: string) => {
    const panel = (
      <OutputPanel
        label={reading && title ? title : SKILL_TAB_BODY_LABEL}
        meta={skillBodyMetaLabel(text)}
        text={text}
        mono
        copyLabel="本文をコピー"
        copyAlwaysVisible
        actions={
          <>
            <SegmentedControl
              items={SKILL_BODY_VIEW_MODES}
              value={bodyView}
              onChange={setBodyView}
              ariaLabel={SKILL_BODY_VIEW_ARIA_LABEL}
            />
            {singleColumn ? (
              <button
                type="button"
                ref={readerButtonRef}
                aria-label={reading ? SKILL_BODY_READER_CLOSE_LABEL : SKILL_BODY_READER_OPEN_LABEL}
                title={reading ? SKILL_BODY_READER_CLOSE_LABEL : SKILL_BODY_READER_OPEN_LABEL}
                onClick={() => {
                  if (reading) readerDialogRef.current?.close();
                  else setReading(true);
                }}
                className="grid size-5 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:text-accent-text"
              >
                {reading ? <CollapseIcon /> : <ExpandIcon />}
              </button>
            ) : null}
          </>
        }
      >
        {bodyView === "preview" ? (
          <div className="px-2.5 py-2">
            <MarkdownView text={skillBodyPreviewText(text)} />
          </div>
        ) : undefined}
      </OutputPanel>
    );
    if (!reading) return panel;
    // 全画面の読み面。外枠 (ページのヘッダ / タブ / メタ) を外し、閉じる操作は標準の dialog に任せる
    return createPortal(
      <dialog
        ref={readerDialogRef}
        aria-label={title ? `${title} の${SKILL_TAB_BODY_LABEL}` : SKILL_TAB_BODY_LABEL}
        onClose={() => {
          restoreReaderFocus.current = true;
          setReading(false);
        }}
        // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        className="m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-soft p-0"
      >
        <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 py-3">{panel}</div>
      </dialog>,
      document.body,
    );
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tabs}
      <div className="shrink-0 border-b border-line px-4 py-1.5">
        {/* コピーのボタンは字の中心に合わせる (baseline だと、文字を持たないボタンが行の下側へずれる) */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-2xs">
          {meta.map((item) => {
            // コピーの状態は項目ごとに持つ (本文のコピーと同じ hook を共有し、成功 / 失敗の表示を混ぜない)
            const copyId = `meta:${item.label}`;
            return (
              <span key={item.label} className="flex min-w-0 items-center gap-1">
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
                {item.copy ? (
                  <span className="shrink-0">
                    <CopyButton
                      compact
                      copied={copiedId === copyId}
                      failure={copyFailure(copyId)}
                      onClick={() => void copyMessage(item.value, copyId)}
                      label={`${item.label}をコピー`}
                    />
                  </span>
                ) : null}
              </span>
            );
          })}
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
          {singleColumn ? (
            // 狭い幅では説明を畳む。一覧の行にも説明が出ているので、開いた直後は本文へ高さを譲る
            <details>
              <summary className="disclosure-summary flex cursor-pointer items-center gap-1.5 rounded-md text-2xs font-semibold tracking-label text-ink-faint uppercase transition-colors outline-none hover:text-ink-soft focus-visible:ring-2 focus-visible:ring-focus">
                <DisclosureChevronIcon />
                説明
              </summary>
              <p className="mt-1 text-1xs leading-relaxed break-words text-ink-soft">{description}</p>
            </details>
          ) : (
            <section className="grid gap-1">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">説明</h3>
              <p className="text-1xs leading-relaxed break-words text-ink-soft">{description}</p>
            </section>
          )}
          {/* 説明と本文を分ける。本文が無いときも同じ位置に線を残し、読み込み中で行が動かないようにする */}
          <div className="grid gap-1.5 border-t border-line pt-2.5">
            {body.status === "loading" ? (
              <p className="text-2xs leading-4 text-ink-muted">{FILE_SKILL_BODY_LOADING_NOTE}</p>
            ) : body.status === "error" ? (
              <p className="text-2xs leading-4 break-words text-warn">
                {FILE_SKILL_BODY_ERROR_PREFIX}: {body.message}
              </p>
            ) : (
              bodyPanel(body.text)
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
