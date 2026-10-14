import type { FileSkillsState } from "../../hooks/useFileSkills";
import {
  FILE_SKILL_EMPTY_NOTE,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_GROUP_LABEL,
  FILE_SKILL_LOADING_NOTE,
  groupFileSkills,
} from "../../lib/fileSkills";
import type { BuiltinSkillInfo, FileSkillInfo, SkillDef } from "../../types";

/** 組み込み行の見出し。チェックでエージェント別に外せる (既定は全部 ON) */
const BUILTIN_SECTION_LABEL = "組み込み";
/**
 * 組み込み行の注記。チェックを外すとこのエージェントの会話へ読み込まれなくなることをここ 1 箇所で伝える
 * (同梱物そのものは変更しない。docs/api-catalog.md#組み込みスキル)。
 */
export const BUILTIN_SECTION_NOTE =
  "チェックを外すと、このエージェントの会話では読み込まれません。同梱物は変更しません。";
/** 明示リストは対象の名前だけを使う。同梱物が増えても勝手に有効にしないことを注記で知らせる */
export const BUILTIN_SKILL_EXPLICIT_NOTE =
  "選んだ組み込みスキルだけを使います。あとから同梱された分は自動では選ばれません。";
export const BUILTIN_SKILL_SHOW_ALL_LABEL = "すべて使用に戻す";
export const BUILTIN_SKILL_DISABLE_ALL_LABEL = "すべて外す";
/**
 * 外した行だけに出す、「ツールはスキルと別軸」の注記。名前で引くため、同梱物が増えても
 * 対応するツールが無ければ何も出ない。
 */
const BUILTIN_SKILL_OFF_HINTS: Record<string, string> = {
  serve: "外しても「サービス」ツールは使えます",
};

/**
 * 共通スキルの注記。行に出る「自動起動なし」(`disable-model-invocation` = モデルが自分からは起動しない) とは
 * 別の操作で、チェックを外すとこのエージェントの会話へ読み込まれなくなることをここで伝える
 * (docs/ui-layout.md)。共通スキルのファイルは変更しない。
 */
export const COMMON_SKILL_SECTION_NOTE =
  "チェックを外すと、このエージェントの会話では読み込まれません。ファイルは変更しません。";
/** 明示リストは対象の名前だけを使う。一覧が後から増えても勝手に有効にしないことを注記で知らせる */
export const COMMON_SKILL_EXPLICIT_NOTE = "選んだ名前だけを使います。あとから増えた共通スキルは自動では選ばれません。";
export const COMMON_SKILL_SHOW_ALL_LABEL = "すべて表示に戻す";

/** 保存名のうち一覧に無いもの (ファイルの削除・改名)。落とさず残すので、自動では直らないことを知らせる */
function commonSkillMissingNote(names: string[]): string {
  return `見つかりません: ${names.join("、")}（ファイルが削除・改名されても、保存した名前はそのまま残ります）`;
}

/** 組み込み側の同じ注記。同梱物が入れ替わったときに保存名が残ることを知らせる */
function builtinSkillMissingNote(names: string[]): string {
  return `見つかりません: ${names.join("、")}（同梱物が入れ替わっても、保存した名前はそのまま残ります）`;
}

export function SkillSelector({
  skills,
  builtinSkills,
  selectedIds,
  onToggle,
  fileSkills,
  commonSkillNames,
  onToggleCommonSkill,
  onShowAllCommonSkills,
  builtinSkillNames,
  onToggleBuiltinSkill,
  onShowAllBuiltinSkills,
  onDisableAllBuiltinSkills,
}: {
  skills: SkillDef[];
  /** アプリに同梱する組み込みスキル。エージェント定義の許可リストで外せるので、チェック可能な行で出す */
  builtinSkills: BuiltinSkillInfo[];
  selectedIds: string[];
  onToggle: (skillId: string, checked: boolean) => void;
  /** 共通スキル (`.agents/skills`) の取得状態。取得できないときは欄を出さず、理由だけを出す */
  fileSkills: FileSkillsState;
  /** undefined = 未指定 (全可視)、null = 解除 (全可視)、配列 = 明示リスト ([] はすべて OFF) */
  commonSkillNames?: string[] | null;
  onToggleCommonSkill: (name: string, checked: boolean) => void;
  onShowAllCommonSkills: () => void;
  /** undefined = 未指定 (全部 ON)、null = 解除 (全部 ON)、配列 = 明示リスト ([] はすべて OFF) */
  builtinSkillNames?: string[] | null;
  onToggleBuiltinSkill: (name: string, checked: boolean) => void;
  onShowAllBuiltinSkills: () => void;
  onDisableAllBuiltinSkills: () => void;
}) {
  // カタログから消えた id が残っていても選択数が全件を超えないよう、実在するスキルだけ数える
  const selectedCount = skills.filter((skill) => selectedIds.includes(skill.id)).length;
  // 一覧 API は共通 (user) と組み込みだけを返すので、組み込みを除いた側がそのまま共通スキル
  const commonSkills = fileSkills.status === "ready" ? groupFileSkills(fileSkills.skills).common : [];
  // undefined (未指定) と null (解除) はどちらも全可視で、明示リスト ([] を含む) だけが「選んだ名前」
  const explicit = Array.isArray(commonSkillNames);
  const usedCommonNames = explicit ? commonSkillNames : commonSkills.map((skill) => skill.name);
  const missingCommonNames = explicit
    ? commonSkillNames.filter((name) => !commonSkills.some((skill) => skill.name === name))
    : [];
  const usedCommonCount = commonSkills.filter((skill) => usedCommonNames.includes(skill.name)).length;
  // undefined (未指定) と null (解除) はどちらも全部 ON で、明示リスト ([] を含む) だけが「選んだ名前」
  const builtinExplicit = Array.isArray(builtinSkillNames);
  const usedBuiltinNames = builtinExplicit ? builtinSkillNames : builtinSkills.map((skill) => skill.name);
  const missingBuiltinNames = builtinExplicit
    ? builtinSkillNames.filter((name) => !builtinSkills.some((skill) => skill.name === name))
    : [];
  const usedBuiltinCount = builtinSkills.filter((skill) => usedBuiltinNames.includes(skill.name)).length;

  const commonSkillRow = (skill: FileSkillInfo) => (
    // min-w-0: 説明を truncate すると行の min-content が説明の全幅になり、一覧の行が箱より広がる
    <label
      key={skill.path}
      className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg bg-raised px-2.5 py-1.5"
    >
      <input
        type="checkbox"
        checked={usedCommonNames.includes(skill.name)}
        onChange={(e) => onToggleCommonSkill(skill.name, e.currentTarget.checked)}
        className="mt-0.5 accent-focus"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-xs text-ink">{skill.name}</span>
          {/* モデルが自分からは起動しないというスキル側の性質。外すチェックとは別物なので語を分ける */}
          {skill.disableModelInvocation ? (
            <span className="shrink-0 text-2xs leading-4 text-ink-ghost">自動起動なし</span>
          ) : null}
        </span>
        <small className="block truncate text-2xs text-ink-muted" title={skill.description || ""}>
          {skill.description || ""}
        </small>
      </span>
    </label>
  );

  return (
    <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-2.5 py-2">
      <div className="flex items-baseline gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
        <span>スキル</span>
        <span className="font-normal">
          割り当て中 {selectedCount} / 全 {skills.length}
        </span>
      </div>
      {skills.length === 0 ? (
        <div className="text-1xs text-ink-faint">スキルがありません。「スキル」ページから作成できます。</div>
      ) : (
        <div className="max-h-72 scrollbar-thin overflow-x-hidden overflow-y-auto">
          <div className="grid gap-1">
            {skills.map((skill) => (
              // min-w-0: 説明を truncate すると行の min-content が説明の全幅になり、一覧の行が箱より広がる
              <label
                key={skill.id}
                className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg bg-raised px-2.5 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(skill.id)}
                  onChange={(e) => onToggle(skill.id, e.currentTarget.checked)}
                  className="mt-0.5 accent-focus"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-ink">{skill.name}</span>
                  {/* 説明の全文は「スキル」ページにあるので、ここは 1 行に切って title へ逃がす */}
                  <small className="block truncate text-2xs text-ink-muted" title={skill.description || ""}>
                    {skill.description || ""}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {fileSkills.status === "loading" ? (
        <p className="text-2xs leading-4 break-words text-ink-muted">{FILE_SKILL_LOADING_NOTE}</p>
      ) : null}
      {fileSkills.status === "error" ? (
        // 欄ごと消すと「このエージェントには共通スキルが無い」と読めるので、取得できていない理由を出す
        <p className="text-2xs leading-4 break-words text-warn">
          {FILE_SKILL_ERROR_PREFIX}: {fileSkills.message}
        </p>
      ) : null}
      {fileSkills.status === "ready" ? (
        <div className="grid gap-1 border-t border-line pt-2">
          <div className="flex items-baseline justify-between gap-2 text-2xs font-semibold tracking-label text-ink-faint uppercase">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate">{FILE_SKILL_GROUP_LABEL}</span>
              <span className="shrink-0 font-normal">
                使用 {usedCommonCount} / 全 {commonSkills.length}
              </span>
            </span>
            {explicit ? (
              <button
                type="button"
                className="shrink-0 font-normal tracking-normal text-accent-text underline underline-offset-2"
                onClick={onShowAllCommonSkills}
              >
                {COMMON_SKILL_SHOW_ALL_LABEL}
              </button>
            ) : null}
          </div>
          {commonSkills.length === 0 ? (
            <p className="text-2xs leading-4 break-words text-ink-faint">{FILE_SKILL_EMPTY_NOTE}</p>
          ) : (
            <div className="max-h-72 scrollbar-thin overflow-x-hidden overflow-y-auto">
              <div className="grid gap-1">{commonSkills.map(commonSkillRow)}</div>
            </div>
          )}
          {missingCommonNames.length > 0 ? (
            <p className="text-2xs leading-4 break-words text-ink-faint">
              {commonSkillMissingNote(missingCommonNames)}
            </p>
          ) : null}
          <p className="text-2xs leading-4 break-words text-ink-faint">{COMMON_SKILL_SECTION_NOTE}</p>
          {explicit ? (
            <p className="text-2xs leading-4 break-words text-ink-faint">{COMMON_SKILL_EXPLICIT_NOTE}</p>
          ) : null}
        </div>
      ) : null}
      {builtinSkills.length > 0 ? (
        // 共通と同じくチェックで外す。既定は全部 ON で、明示リストにした後は同梱物が増えても自動では入れない
        <div className="grid gap-1 border-t border-line pt-2">
          <div className="flex items-baseline justify-between gap-2 text-2xs font-semibold tracking-label text-ink-faint uppercase">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate">{BUILTIN_SECTION_LABEL}</span>
              <span className="shrink-0 font-normal">
                使用 {usedBuiltinCount} / 全 {builtinSkills.length}
              </span>
            </span>
            <span className="flex shrink-0 items-baseline gap-2.5 font-normal tracking-normal">
              {/* すべて OFF のときは外す対象が無いので出さない */}
              {usedBuiltinCount > 0 ? (
                <button
                  type="button"
                  className="text-accent-text underline underline-offset-2"
                  onClick={onDisableAllBuiltinSkills}
                >
                  {BUILTIN_SKILL_DISABLE_ALL_LABEL}
                </button>
              ) : null}
              {builtinExplicit ? (
                <button
                  type="button"
                  className="text-accent-text underline underline-offset-2"
                  onClick={onShowAllBuiltinSkills}
                >
                  {BUILTIN_SKILL_SHOW_ALL_LABEL}
                </button>
              ) : null}
            </span>
          </div>
          <div className="max-h-72 scrollbar-thin overflow-x-hidden overflow-y-auto">
            <div className="grid gap-1">
              {builtinSkills.map((skill) => (
                <label
                  key={skill.name}
                  className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg bg-raised px-2.5 py-1.5"
                >
                  <input
                    type="checkbox"
                    checked={usedBuiltinNames.includes(skill.name)}
                    onChange={(e) => onToggleBuiltinSkill(skill.name, e.currentTarget.checked)}
                    className="mt-0.5 accent-focus"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-ink">{skill.name}</span>
                    <small className="block truncate text-2xs text-ink-muted" title={skill.description || ""}>
                      {skill.description || ""}
                    </small>
                    {/* ツールはスキルと別軸で外れない (serve など)。外した行だけに出す */}
                    {!usedBuiltinNames.includes(skill.name) && BUILTIN_SKILL_OFF_HINTS[skill.name] ? (
                      <small className="block text-2xs text-ink-faint">{BUILTIN_SKILL_OFF_HINTS[skill.name]}</small>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </div>
          {missingBuiltinNames.length > 0 ? (
            <p className="text-2xs leading-4 break-words text-ink-faint">
              {builtinSkillMissingNote(missingBuiltinNames)}
            </p>
          ) : null}
          <p className="text-2xs leading-4 break-words text-ink-faint">{BUILTIN_SECTION_NOTE}</p>
          {builtinExplicit ? (
            <p className="text-2xs leading-4 break-words text-ink-faint">{BUILTIN_SKILL_EXPLICIT_NOTE}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
