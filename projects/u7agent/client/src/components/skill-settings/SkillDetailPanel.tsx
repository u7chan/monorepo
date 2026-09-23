import type { ReactNode } from "react";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import { cn } from "../../lib/cn";
import { FILE_SKILL_BODY_ERROR_PREFIX, FILE_SKILL_BODY_LOADING_NOTE } from "../../lib/fileSkills";
import { CopyButton } from "../chat/CopyButton";

/** 本文の状態。組み込みとカタログは一覧の応答の本文をそのまま ready で渡す */
export type SkillBodyState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

/** メタの 1 行。mono は置き場のような等幅で出す値、strong は名前のような主語に使う */
export type SkillMetaItem = { label: string; value: string; tone?: "strong"; mono?: boolean };

export type SkillDetailPanelProps = {
  /** 操作行の左 (SKILL eyebrow + 見出し)。compact のシートはヘッダに同じ見出しが出るため null (操作だけを残す) */
  heading: ReactNode;
  /** 操作行の右に置く操作 (本文 / ファイル のタブ、編集ボタン) */
  actions?: ReactNode;
  meta: SkillMetaItem[];
  /** メタの下に出す補足 (読み取り専用の断りなど) */
  note?: string;
  /** メタの中に出す警告 (上書きされています など) */
  warning?: string;
  body: SkillBodyState;
  /** ファイルタブの中身。渡したときは本文と display で切り替える (mount を保つため常に渡す) */
  files?: ReactNode;
  /** files を表示するか。本文だけのパネルでは省略する */
  showFiles?: boolean;
};

/**
 * スキル詳細の共通枠。先頭の操作行 (見出し + タブ / 編集)、メタ、コピー付きの本文を出す。
 * 操作行より下は min-h-0 + overflow-y-auto の残余領域にして、本文だけがその中でスクロールし、
 * ファイルタブは残余領域いっぱいへ直接広げる (本文のスクロール枠へ FileBrowser を入れると入れ子スクロールになる。
 * docs/ui-layout.md)。
 */
export function SkillDetailPanel({
  heading,
  actions,
  meta,
  note,
  warning,
  body,
  files,
  showFiles = false,
}: SkillDetailPanelProps) {
  const { copiedId, copyMessage } = useMessageCopy();
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-2 gap-y-1 px-4 pt-3 pb-2.5">
        {heading ? (
          <div className="min-w-0">
            <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">SKILL</div>
            <h3 className="text-sm font-semibold text-ink-strong">{heading}</h3>
          </div>
        ) : null}
        {/* 操作行は折り返しても右端に残す (狭い幅で見出しと重ならないようにする) */}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3",
          showFiles && "hidden",
        )}
      >
        <div className="mx-auto grid max-w-5xl content-start gap-2.5">
          <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-2.5 py-2">
            <dl className="grid gap-1.5">
              {meta.map((item) => (
                <div key={item.label} className="grid gap-1.5">
                  <dt className="text-2xs font-semibold tracking-label text-ink-faint uppercase">{item.label}</dt>
                  <dd
                    className={cn(
                      "break-words",
                      item.mono ? "text-2xs" : "text-xs",
                      item.tone === "strong" ? "text-ink-strong" : "text-ink-soft",
                    )}
                  >
                    {item.mono ? <code>{item.value}</code> : item.value}
                  </dd>
                </div>
              ))}
            </dl>
            {warning ? <p className="text-2xs leading-4 text-warn">{warning}</p> : null}
          </div>
          {note ? <p className="text-1xs leading-relaxed text-ink-muted">{note}</p> : null}
          {/* 補足の下は本文だけを分ける (本文が無いときも同じ位置に線を残し、読み込み中で行が動かないようにする) */}
          <div className={cn("grid gap-1.5", note && "border-t border-line pt-2.5")}>
            {body.status === "loading" ? (
              <p className="text-2xs leading-4 text-ink-muted">{FILE_SKILL_BODY_LOADING_NOTE}</p>
            ) : body.status === "error" ? (
              <p className="text-2xs leading-4 break-words text-warn">
                {FILE_SKILL_BODY_ERROR_PREFIX}: {body.message}
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">本文</div>
                  <CopyButton
                    copied={copiedId === "skill"}
                    onClick={() => void copyMessage(body.text, "skill")}
                    label="本文をコピー"
                  />
                </div>
                <pre className="scrollbar-thin overflow-x-hidden overflow-y-visible rounded-lg border border-line bg-soft px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-soft select-text">
                  {body.text}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
      {/* ファイルタブは残余領域の高さをそのまま使う (grid item にして FileBrowser の h-full を効かせる)。
          この領域もスクロール容器にする: FilePreview の min-h-40 を含む FileBrowser の下限を下回る極端に
          低い容器では、ここだけがスクロールしてはみ出さない */}
      {files ? (
        <div
          className={cn(
            showFiles ? "grid min-h-0 flex-1 scrollbar-thin grid-rows-1 overflow-x-hidden overflow-y-auto" : "hidden",
          )}
        >
          {files}
        </div>
      ) : null}
    </section>
  );
}
