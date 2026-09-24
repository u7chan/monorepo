import { useEffect, useState } from "react";
import { getFilePreview } from "../../api";
import { cn } from "../../lib/cn";
import {
  BUILTIN_SKILL_OVERRIDE_NOTE,
  BUILTIN_SKILL_READONLY_NOTE,
  FILE_SKILL_PANEL_HEADING,
  FILE_SKILL_READONLY_NOTE,
  fileSkillDir,
} from "../../lib/fileSkills";
import type { FileSkillInfo } from "../../types";
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
 * 読み取り専用スキル (共通 / プロジェクト / 組み込み) の本文ビュー。編集フォームの代わりに、
 * 何が使われるか (名前 / 説明 / 置き場 / スコープ / 版) と本文を出す。組み込みは一覧の `body` をそのまま使い、
 * ファイルスキルは本文を持たない一覧なので、選択のたびにファイルプレビューから取り直す
 * (docs/api-catalog.md。反映タイミングは本文の取得時点)。ファイルスキルは本文の隣の補助ファイル
 * (references / scripts / assets) も見られるよう「本文 / ファイル」のタブを持つ。
 */
export function ReadOnlySkillPanel({ skill, variant }: { skill: FileSkillInfo; variant: "page" | "sheet" }) {
  const [body, setBody] = useState<SkillBodyState>(() =>
    skill.body === undefined ? { status: "loading" } : { status: "ready", text: skill.body },
  );
  const [tab, setTab] = useState<SkillTab>("body");
  // ファイルタブは初回に開いたときだけ mount し、以降は display で隠して保持する
  // (行き来のたびに一覧とタブを取り直さず、選んだファイルも保つ)
  const [filesOpened, setFilesOpened] = useState(false);
  // 組み込みは実体の無い仮想パス、root の外は絶対パスなのでファイルタブを出さない
  const skillDir = fileSkillDir(skill);

  useEffect(() => {
    // 組み込みは応答の本文をそのまま出す (実ファイルが無いので取り直す先が無い)
    if (skill.body !== undefined) {
      setBody({ status: "ready", text: skill.body });
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
  }, [skill.relativePath, skill.body]);

  const openTab = (next: SkillTab) => {
    if (next === "files") setFilesOpened(true);
    setTab(next);
  };

  return (
    <SkillDetailPanel
      heading={variant === "page" ? FILE_SKILL_PANEL_HEADING[skill.scope] : null}
      actions={
        skillDir ? (
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
        ) : null
      }
      meta={[
        { label: "名前", value: skill.name, tone: "strong" },
        { label: "説明", value: skill.description || "説明なし" },
        { label: "置き場", value: skill.relativePath, mono: true },
        ...(skill.version ? [{ label: "版", value: skill.version }] : []),
      ]}
      note={skill.scope === "builtin" ? BUILTIN_SKILL_READONLY_NOTE : FILE_SKILL_READONLY_NOTE}
      warning={skill.overridden ? BUILTIN_SKILL_OVERRIDE_NOTE : undefined}
      body={body}
      files={
        skillDir && filesOpened ? (
          // 読み取り専用の面なので行の操作ごと出さない（除外名は使われない）
          <FileBrowser root={skillDir} reloadToken={0} readOnly excludeNames={[]} />
        ) : undefined
      }
      showFiles={tab === "files"}
    />
  );
}
