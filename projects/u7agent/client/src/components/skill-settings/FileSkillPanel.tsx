import { useEffect, useState, type ReactNode } from "react";
import { getFilePreview } from "../../api";
import { cn } from "../../lib/cn";
import {
  BUILTIN_SKILL_OVERRIDE_NOTE,
  BUILTIN_SKILL_READONLY_NOTE,
  FILE_SKILL_EDITABLE_NOTE,
  FILE_SKILL_LOCKED_PREFIX,
  FILE_SKILL_PANEL_HEADING,
  fileSkillDir,
} from "../../lib/fileSkills";
import type { FileSkillInfo, SandboxSkillFileDetail } from "../../types";
import { FileBrowser } from "../FileBrowser";
import { SkillDetailPanel, type SkillBodyState } from "./SkillDetailPanel";

type SkillTab = "body" | "files";

const SKILL_TABS: { value: SkillTab; label: string }[] = [
  { value: "body", label: "本文" },
  { value: "files", label: "ファイル" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ファイルスキル (共通 / プロジェクト / 組み込み) の本文ビュー。編集フォームの代わりに、
 * 何が使われるか (名前 / 説明 / 置き場 / スコープ / 版) と本文を出す。
 * 共通スキルは編集内容 (`detail`) を渡すと、その本文と保存可否をそのまま表示する (編集中の内容と一致させる)。
 * 組み込みは一覧の `body` をそのまま使い、それ以外はファイルプレビューから取り直す
 * (docs/api-catalog.md。反映タイミングは本文の取得時点)。ファイルスキルは本文の隣の補助ファイル
 * (references / scripts / assets) も見られるよう「本文 / ファイル」のタブを持つ。
 */
export function FileSkillPanel({
  skill,
  detail,
  actions,
  variant,
  filePreviewPort,
  rootCwd,
}: {
  skill: FileSkillInfo;
  /** 共通スキルの編集内容。渡したときは本文と保存可否をここから出す (エディターと同じ取得結果) */
  detail?: SandboxSkillFileDetail;
  /** 操作行に足す操作 (編集 / 削除)。組み込みでは渡さない */
  actions?: ReactNode;
  variant: "page" | "sheet";
  /** プレビュー オリジンのブラウザから見たポート (health)。未取得は undefined */
  filePreviewPort?: number;
  /** ワークスペース root の絶対パス (health.cwd)。行の絶対パスをコピーする導線に使う */
  rootCwd?: string;
}) {
  const bodySource = detail?.body ?? skill.body;
  const [body, setBody] = useState<SkillBodyState>(() =>
    bodySource === undefined ? { status: "loading" } : { status: "ready", text: bodySource },
  );
  const [tab, setTab] = useState<SkillTab>("body");
  // ファイルタブは初回に開いたときだけ mount し、以降は display で隠して保持する
  // (行き来のたびに一覧とタブを取り直さず、選んだファイルも保つ)
  const [filesOpened, setFilesOpened] = useState(false);
  // 組み込みは実体の無い仮想パス、root の外は絶対パスなのでファイルタブを出さない
  const skillDir = fileSkillDir(skill);

  useEffect(() => {
    // 組み込みは応答の本文を、共通スキルは編集内容の本文をそのまま出す (取り直す先が無い)
    if (bodySource !== undefined) {
      setBody({ status: "ready", text: bodySource });
      return;
    }
    // 選択を切り替えたら前の本文は捨てる。取得中に切り替えたら中断して結果を反映しない
    const controller = new AbortController();
    setBody({ status: "loading" });
    void getFilePreview(skill.relativePath, controller.signal).then(
      (preview) => {
        if (!controller.signal.aborted) setBody({ status: "ready", text: preview.text });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setBody({ status: "error", message: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [skill.relativePath, bodySource]);

  const openTab = (next: SkillTab) => {
    if (next === "files") setFilesOpened(true);
    setTab(next);
  };

  const note =
    skill.scope === "builtin"
      ? BUILTIN_SKILL_READONLY_NOTE
      : detail === undefined
        ? undefined
        : detail.editable
          ? FILE_SKILL_EDITABLE_NOTE
          : `${FILE_SKILL_LOCKED_PREFIX}: ${detail.reason ?? ""}`;

  return (
    <SkillDetailPanel
      heading={variant === "page" ? FILE_SKILL_PANEL_HEADING[skill.scope] : null}
      actions={
        <>
          {actions}
          {skillDir ? (
            <div
              role="group"
              aria-label="表示の切替"
              className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line p-0.5"
            >
              {SKILL_TABS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={tab === item.value}
                  onClick={() => openTab(item.value)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-3xs transition-colors",
                    tab === item.value
                      ? "bg-accent-wash text-accent-text"
                      : "text-ink-soft hover:bg-hover hover:text-ink",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      }
      meta={[
        { label: "名前", value: detail?.name ?? skill.name, tone: "strong" },
        { label: "説明", value: (detail?.description ?? skill.description) || "説明なし" },
        { label: "置き場", value: detail?.relativePath ?? skill.relativePath, mono: true },
        ...((detail?.fileVersion ?? skill.version)
          ? [{ label: "版", value: detail?.fileVersion ?? skill.version ?? "" }]
          : []),
      ]}
      note={note}
      warning={skill.overridden ? BUILTIN_SKILL_OVERRIDE_NOTE : undefined}
      body={body}
      files={
        skillDir && filesOpened ? (
          // ファイルタブではメタ行 (置き場) が display で隠れるため、ツリーの root をここに出す
          // (パンくずは画面 root 相対なので、root は面ごとのヘッダ側に置く)
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <code
              className="block truncate border-b border-line px-4 py-1.5 text-2xs leading-normal text-ink-muted"
              title={skillDir}
            >
              {skillDir}
            </code>
            {/* 読み取り専用の面なので実体を移す / 変える操作は出さない（除外名は使われない）。パスのコピーは残す */}
            <FileBrowser
              root={skillDir}
              rootCwd={rootCwd}
              reloadToken={0}
              readOnly
              excludeNames={[]}
              filePreviewPort={filePreviewPort}
            />
          </div>
        ) : undefined
      }
      showFiles={tab === "files"}
    />
  );
}
