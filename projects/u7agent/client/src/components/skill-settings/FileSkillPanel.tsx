import { useEffect, useState } from "react";
import { getFilePreview } from "../../api";
import {
  BUILTIN_SKILL_OVERRIDE_NOTE,
  BUILTIN_SKILL_READONLY_NOTE,
  FILE_SKILL_EDITABLE_NOTE,
  FILE_SKILL_LOCKED_PREFIX,
  SKILL_DETAIL_TABS_ARIA_LABEL,
  SKILL_TAB_BODY_LABEL,
  SKILL_TAB_FILES_LABEL,
  SKILL_TAB_USAGE_LABEL,
  SKILL_USAGE_EMPTY_NOTE,
  SKILL_USAGE_TAB_NOTE,
  fileSkillDir,
  fileSkillUsageLabel,
} from "../../lib/fileSkills";
import { fileTimeLabel, messageFullTimeLabel } from "../../lib/messageTime";
import { SKILL_USAGE_NOTE, SKILL_USAGE_UNAVAILABLE_NOTE, skillUsageCount, type SkillUsage } from "../../lib/skillUsage";
import type { AgentDef, FileSkillInfo, SandboxSkillFileDetail } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { FileBrowser } from "../FileBrowser";
import { SettingsTabs } from "../SettingsTabs";
import { SkillDetailPanel, type SkillBodyState, type SkillDetailTab } from "./SkillDetailPanel";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * スキル詳細。本文 / ファイル / 使用中 の 3 タブで、説明は本文タブの先頭に全文を出す。
 * 共通スキルは編集内容 (`detail`) を渡すと、その本文と保存可否をそのまま表示する (編集中の内容と一致させる)。
 * 組み込みは一覧の `body` をそのまま使い、それ以外はファイルプレビューから取り直す
 * (docs/api-catalog.md。反映タイミングは本文の取得時点)。ファイルタブは root を導けるスキルだけに出す
 * (組み込み・仮想パス・絶対パス・親参照は出さない)。使用中は読み取り専用。
 */
export function FileSkillPanel({
  skill,
  detail,
  usage,
  filePreviewPort,
  rootCwd,
}: {
  skill: FileSkillInfo;
  /** 共通スキルの編集内容。渡したときは本文と保存可否をここから出す (エディターと同じ取得結果) */
  detail?: SandboxSkillFileDetail;
  /** 使用中エージェント。catalog 未取得のときは渡さない (0 と断定しない) */
  usage?: SkillUsage;
  /** プレビュー オリジンのブラウザから見たポート (health)。未取得は undefined */
  filePreviewPort?: number;
  /** ワークスペース root の絶対パス (health.cwd)。行の絶対パスをコピーする導線に使う */
  rootCwd?: string;
}) {
  const bodySource = detail?.body ?? skill.body;
  const [body, setBody] = useState<SkillBodyState>(() =>
    bodySource === undefined ? { status: "loading" } : { status: "ready", text: bodySource },
  );
  const [tab, setTab] = useState<SkillDetailTab>("body");
  // ファイルタブは初回に開いたときだけ mount し、以降は display で隠して保持する
  // (行き来のたびに一覧とタブを取り直さず、選んだファイルも保つ)。詳細を閉じると unmount される
  const [filesOpened, setFilesOpened] = useState(false);
  // 組み込みは実体の無い仮想パス、root の外は絶対パスなのでファイルタブを出さない (root をワークスペースへ落とさない)
  const skillDir = fileSkillDir(skill);
  const usageCount = skillUsageCount(usage, skill.relativePath);
  const users: AgentDef[] = usage?.get(skill.relativePath) ?? [];

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

  const openTab = (next: SkillDetailTab) => {
    if (next === "files") setFilesOpened(true);
    setTab(next);
  };

  const tabs = [
    { subsection: "body" as const, label: SKILL_TAB_BODY_LABEL },
    ...(skillDir ? [{ subsection: "files" as const, label: SKILL_TAB_FILES_LABEL }] : []),
    {
      subsection: "usage" as const,
      label: usageCount === undefined ? SKILL_TAB_USAGE_LABEL : `${SKILL_TAB_USAGE_LABEL} ${usageCount}`,
      ariaLabel:
        usageCount === undefined
          ? SKILL_TAB_USAGE_LABEL
          : `${SKILL_TAB_USAGE_LABEL}（${fileSkillUsageLabel(usageCount)}）`,
    },
  ];

  const note =
    skill.scope === "builtin"
      ? BUILTIN_SKILL_READONLY_NOTE
      : detail === undefined
        ? undefined
        : detail.editable
          ? FILE_SKILL_EDITABLE_NOTE
          : `${FILE_SKILL_LOCKED_PREFIX}: ${detail.reason ?? ""}`;

  const meta = [
    { label: "置き場", value: skill.relativePath, mono: true },
    // 最終更新は SKILL.md の mtime で、保存の競合検出に使う版 (fileVersion) は出さない。
    // 組み込みは実体が無く、他のスコープは詳細を取得しないため、行ごと出さない
    ...(detail
      ? [
          {
            label: "更新",
            value: fileTimeLabel(detail.mtime),
            title: `SKILL.md の更新時刻（目安）: ${messageFullTimeLabel(detail.mtime)}`,
          },
        ]
      : []),
    ...(usageCount === undefined ? [] : [{ label: "使用中", value: fileSkillUsageLabel(usageCount) }]),
  ];

  return (
    <SkillDetailPanel
      tabs={<SettingsTabs items={tabs} active={tab} onSelect={openTab} ariaLabel={SKILL_DETAIL_TABS_ARIA_LABEL} />}
      meta={meta}
      note={note}
      warning={skill.overridden ? BUILTIN_SKILL_OVERRIDE_NOTE : undefined}
      description={(detail?.description ?? skill.description) || "説明なし"}
      body={body}
      activeTab={tab}
      usage={
        <div className="grid gap-2">
          <div className="grid gap-0.5">
            <p className="text-1xs leading-relaxed text-ink-muted">{SKILL_USAGE_TAB_NOTE}</p>
            {/* 何を数えていないかは件数のすぐ近くに出す (0 体の理由を読み手が補えるように) */}
            <p className="text-2xs leading-4 text-ink-faint">{SKILL_USAGE_NOTE}</p>
          </div>
          {usage === undefined ? (
            <p className="text-2xs leading-4 text-ink-faint">{SKILL_USAGE_UNAVAILABLE_NOTE}</p>
          ) : users.length === 0 ? (
            <p className="text-2xs leading-4 text-ink-faint">{SKILL_USAGE_EMPTY_NOTE}</p>
          ) : (
            <ul className="grid gap-1 rounded-lg border border-line bg-soft px-2.5 py-2">
              {users.map((agent) => (
                <li key={agent.id} className="flex min-w-0 items-center gap-2 py-1">
                  <AgentIcon icon={agent.icon} variant="list" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-xs text-ink">{agent.name}</span>
                    <span className="truncate text-2xs text-ink-muted">{agent.description || "説明なし"}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
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
    />
  );
}
