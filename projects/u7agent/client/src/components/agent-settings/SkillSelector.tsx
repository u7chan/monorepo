import { useState } from "react";
import type { FileSkillsState } from "../../hooks/useFileSkills";
import { allowlistCount, allowlistCountLabel } from "../../lib/agentAllowlist";
import {
  ALLOWLIST_DEFAULT_LABEL,
  ALLOWLIST_DIRTY_LABEL,
  ALLOWLIST_DISABLE_GROUP_LABEL,
  ALLOWLIST_RESET_LABEL,
  ALLOWLIST_SEARCH_EMPTY_NOTE,
} from "../../lib/allowlistText";
import {
  COMMON_SKILL_SECTION_LABEL,
  FILE_SKILL_EMPTY_NOTE,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_LOADING_NOTE,
  FILE_SKILL_RELOAD_ARIA_LABEL,
  FILE_SKILL_RELOAD_LABEL,
  groupFileSkills,
} from "../../lib/fileSkills";
import { RELOAD_ABOVE_NOTE } from "../../lib/settingsNotes";
import { filterBySearch } from "../../lib/settingsSearch";
import type { BuiltinSkillInfo, FileSkillInfo } from "../../types";
import { ReloadButton } from "../ReloadButton";
import { SettingsSearchField } from "../SettingsSearchField";
import { InvocationModeRow } from "./InvocationModeRow";
import { SkillGroup } from "./SkillRow";
import { SwitchRow } from "./SwitchRow";

/** 組み込み行の見出し。ビルトインの閲覧ビューも同じ語で出す */
export const BUILTIN_SECTION_LABEL = "組み込み";
export const SKILL_SEARCH_PLACEHOLDER = "スキル名・説明で絞り込む";
export const SKILL_SEARCH_ARIA_LABEL = "スキルを絞り込む";
/**
 * 組み込み行の注記。スイッチを外すとこのエージェントの会話へ読み込まれなくなることをここ 1 箇所で伝える
 * (同梱物そのものは変更しない。docs/api-catalog.md#組み込みスキル)。
 */
export const BUILTIN_SECTION_NOTE =
  "外しても同梱物は変わりません。このエージェントの会話でだけ読み込まれなくなります。";
/** 明示リストは対象の名前だけを使う。同梱物が増えても勝手に有効にしないことを注記で知らせる */
export const BUILTIN_SKILL_EXPLICIT_NOTE =
  "選んだ組み込みスキルだけを使います。あとから同梱された分は自動では選ばれません。";

/**
 * 共通スキルの注記。行に出る「自動起動なし」(`disable-model-invocation` = モデルが自分からは起動しない) とは
 * 別の操作で、スイッチを外すとこのエージェントの会話へ読み込まれなくなることをここで伝える
 * (docs/ui-layout.md)。共通スキルのファイルは変更しない。
 */
export const COMMON_SKILL_SECTION_NOTE =
  "外してもファイルは消えません。このエージェントの会話でだけ読み込まれなくなります。";
/** 明示リストは対象の名前だけを使う。一覧が後から増えても勝手に有効にしないことを注記で知らせる */
export const COMMON_SKILL_EXPLICIT_NOTE = "選んだ名前だけを使います。あとから増えた共通スキルは自動では選ばれません。";

/** 保存名のうち一覧に無いもの (ファイルの削除・改名)。落とさず残すので、自動では直らないことを知らせる */
function commonSkillMissingNote(names: string[]): string {
  return `見つかりません: ${names.join("、")}（ファイルが削除・改名されても、保存した名前はそのまま残ります）`;
}

/** 組み込み側の同じ注記。同梱物が入れ替わったときに保存名が残ることを知らせる */
function builtinSkillMissingNote(names: string[]): string {
  return `見つかりません: ${names.join("、")}（同梱物が入れ替わっても、保存した名前はそのまま残ります）`;
}

function missingOf(names: string[] | null | undefined, visible: readonly string[]): string[] {
  if (!Array.isArray(names)) return [];
  return names.filter((name) => !visible.includes(name));
}

/**
 * エージェント編集のスキルタブ。1 枚のパネルに「組み込み → 共通」の順でスイッチ行を積む。
 * 検索は表示だけを絞り、切替と一括操作の母集合は未絞込の visible 行にする (行が隠れていても、
 * その状態は保存値のまま変えない)。件数も検索中は未絞込で数える。
 */
export function SkillSelector({
  builtinSkills,
  fileSkills,
  onReloadFileSkills,
  commonSkillNames,
  builtinSkillNames,
  onToggleCommonSkill,
  onToggleBuiltinSkill,
  onDisableCommonSkills,
  onDisableBuiltinSkills,
  onResetSkills,
  allowNaturalInvocation,
  onToggleNaturalInvocation,
}: {
  /** アプリに同梱する組み込みスキル。エージェント定義の許可リストで外せるので、スイッチ行で出す */
  builtinSkills: BuiltinSkillInfo[];
  /** 共通スキル (`.agents/skills`) の取得状態。取得できないときは行を出さず、理由だけを出す */
  fileSkills: FileSkillsState;
  onReloadFileSkills: () => void;
  /** undefined = 未指定 (全可視)、null = 解除 (全可視)、配列 = 明示リスト ([] はすべて OFF) */
  commonSkillNames?: string[] | null;
  builtinSkillNames?: string[] | null;
  onToggleCommonSkill: (name: string, checked: boolean) => void;
  onToggleBuiltinSkill: (name: string, checked: boolean) => void;
  onDisableCommonSkills: () => void;
  onDisableBuiltinSkills: () => void;
  /** 明示リストを null へ戻す (既定 = 全可視) */
  onResetSkills: () => void;
  /** true = 自然文でも発火する (既定)。false なら使用中のスキルは /skill: とスキルボタンだけ */
  allowNaturalInvocation: boolean;
  onToggleNaturalInvocation: (allowed: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  // 一覧 API は共通 (user) と組み込みだけを返すので、組み込みを除いた側がそのまま共通スキル
  const commonSkills = fileSkills.status === "ready" ? groupFileSkills(fileSkills.skills).common : [];
  const commonVisible = commonSkills.map((skill) => skill.name);
  const builtinVisible = builtinSkills.map((skill) => skill.name);
  const commonCount = allowlistCount(commonSkillNames, commonVisible);
  const builtinCount = allowlistCount(builtinSkillNames, builtinVisible);
  const explicit = Array.isArray(commonSkillNames) || Array.isArray(builtinSkillNames);
  const total = commonCount.total + builtinCount.total;
  const used = commonCount.used + builtinCount.used;
  const missingCommonNames = missingOf(commonSkillNames, commonVisible);
  const missingBuiltinNames = missingOf(builtinSkillNames, builtinVisible);

  const commonRows = filterBySearch(commonSkills, query, (skill) => [skill.name, skill.description]);
  const builtinRows = filterBySearch(builtinSkills, query, (skill: BuiltinSkillInfo) => [
    skill.name,
    skill.description,
  ]);
  const commonRow = (skill: FileSkillInfo) => (
    <SwitchRow
      key={skill.path}
      name={skill.name}
      description={skill.description || ""}
      checked={usedName(commonSkillNames, commonVisible, skill.name)}
      onToggle={(checked) => onToggleCommonSkill(skill.name, checked)}
      // 同名の組み込みと共通行が並ぶので、読み上げ名にスコープを付ける (表示は変えない)
      toggleLabel={`${COMMON_SKILL_SECTION_LABEL}スキル ${skill.name} を使う`}
      // モデルが自分からは起動しないというスキル側の性質。外すスイッチとは別物なので語を分ける
      badge={skill.disableModelInvocation ? "自動起動なし" : undefined}
    />
  );

  return (
    <div className="grid min-w-0 content-start gap-2.5">
      <AllowlistStatus used={used} total={total} dirty={explicit} onReset={explicit ? onResetSkills : undefined} />
      <SettingsSearchField
        value={query}
        onChange={setQuery}
        placeholder={SKILL_SEARCH_PLACEHOLDER}
        ariaLabel={SKILL_SEARCH_ARIA_LABEL}
      />
      {/* 行の「使用」とは別の軸。ON = 自然文でも発火、OFF = /skill: とスキルボタンだけ */}
      <InvocationModeRow allowNaturalInvocation={allowNaturalInvocation} onChange={onToggleNaturalInvocation} />
      <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2">
        {fileSkills.status === "loading" ? (
          <p className="text-2xs leading-4 break-words text-ink-muted">{FILE_SKILL_LOADING_NOTE}</p>
        ) : null}
        {fileSkills.status === "error" ? (
          // 行ごと消すと「このエージェントには共通スキルが無い」と読めるので、取得できていない理由を出す
          <>
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 text-2xs leading-4 break-words text-warn">
                {FILE_SKILL_ERROR_PREFIX}: {fileSkills.message}
              </p>
              <ReloadButton size="sm" onClick={onReloadFileSkills} aria-label={FILE_SKILL_RELOAD_ARIA_LABEL}>
                {FILE_SKILL_RELOAD_LABEL}
              </ReloadButton>
            </div>
            <p className="text-2xs leading-4 break-words text-ink-muted">{RELOAD_ABOVE_NOTE}</p>
          </>
        ) : null}
        <SkillGroup
          label={BUILTIN_SECTION_LABEL}
          countText={allowlistCountLabel(builtinCount)}
          actions={
            builtinCount.used > 0 ? (
              <button type="button" className="link-quiet" onClick={onDisableBuiltinSkills}>
                {ALLOWLIST_DISABLE_GROUP_LABEL}
              </button>
            ) : undefined
          }
        >
          {builtinSkills.length === 0 ? (
            <p className="px-2.5 text-2xs leading-4 text-ink-faint">組み込みスキルはありません。</p>
          ) : builtinRows.length === 0 ? (
            <p className="px-2.5 text-2xs leading-4 text-ink-faint">{ALLOWLIST_SEARCH_EMPTY_NOTE}</p>
          ) : (
            builtinRows.map((skill) => (
              <SwitchRow
                key={skill.name}
                name={skill.name}
                description={skill.description}
                badge={skill.version ? `v${skill.version}` : undefined}
                checked={usedName(builtinSkillNames, builtinVisible, skill.name)}
                onToggle={(checked) => onToggleBuiltinSkill(skill.name, checked)}
                // 同名の共通行と並ぶので、読み上げ名にスコープを付ける (表示は変えない)
                toggleLabel={`${BUILTIN_SECTION_LABEL}スキル ${skill.name} を使う`}
              />
            ))
          )}
        </SkillGroup>
        {fileSkills.status === "ready" ? (
          <SkillGroup
            divider
            label={COMMON_SKILL_SECTION_LABEL}
            countText={allowlistCountLabel(commonCount)}
            actions={
              commonCount.used > 0 ? (
                <button type="button" className="link-quiet" onClick={onDisableCommonSkills}>
                  {ALLOWLIST_DISABLE_GROUP_LABEL}
                </button>
              ) : undefined
            }
          >
            {commonSkills.length === 0 ? (
              <p className="px-2.5 text-2xs leading-4 text-ink-faint">{FILE_SKILL_EMPTY_NOTE}</p>
            ) : commonRows.length === 0 ? (
              <p className="px-2.5 text-2xs leading-4 text-ink-faint">{ALLOWLIST_SEARCH_EMPTY_NOTE}</p>
            ) : (
              commonRows.map(commonRow)
            )}
          </SkillGroup>
        ) : null}
        {missingCommonNames.length > 0 ? (
          <p className="text-2xs leading-4 break-words text-ink-faint">{commonSkillMissingNote(missingCommonNames)}</p>
        ) : null}
        {missingBuiltinNames.length > 0 ? (
          <p className="text-2xs leading-4 break-words text-ink-faint">
            {builtinSkillMissingNote(missingBuiltinNames)}
          </p>
        ) : null}
        <div className="grid gap-1 border-t border-line pt-2">
          <p className="text-2xs leading-4 break-words text-ink-faint">{BUILTIN_SECTION_NOTE}</p>
          {fileSkills.status === "ready" ? (
            <p className="text-2xs leading-4 break-words text-ink-faint">{COMMON_SKILL_SECTION_NOTE}</p>
          ) : null}
          {Array.isArray(builtinSkillNames) ? (
            <p className="text-2xs leading-4 break-words text-ink-faint">{BUILTIN_SKILL_EXPLICIT_NOTE}</p>
          ) : null}
          {Array.isArray(commonSkillNames) ? (
            <p className="text-2xs leading-4 break-words text-ink-faint">{COMMON_SKILL_EXPLICIT_NOTE}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 行の ON / OFF。未指定 / 解除は全部 ON、明示リストは配列に含まれる名前だけ ON */
function usedName(names: string[] | null | undefined, visible: readonly string[], name: string): boolean {
  if (!Array.isArray(names)) return visible.includes(name);
  return names.includes(name);
}

/**
 * スキル / ツールのタブ上部に出す件数と既定からの変更。`used` は未絞込の visible 行での割当件数で、
 * スキル一覧の「使用中エージェント数」(実効) とは数え方が違うため、タブ側では「割当」と添える。
 */
export function AllowlistStatus({
  used,
  total,
  dirty,
  onReset,
}: {
  used: number;
  total: number;
  dirty: boolean;
  onReset?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
      <span className="flex min-w-0 items-baseline gap-1.5 text-2xs text-ink-muted">
        <span className="font-semibold text-ink">
          使用 {used} / 全 {total}
        </span>
        <span className="text-ink-faint">{dirty ? ALLOWLIST_DIRTY_LABEL : ALLOWLIST_DEFAULT_LABEL}</span>
      </span>
      {onReset ? (
        <button type="button" className="link-quiet min-h-9 shrink-0 px-1 text-2xs" onClick={onReset}>
          {ALLOWLIST_RESET_LABEL}
        </button>
      ) : null}
    </div>
  );
}
