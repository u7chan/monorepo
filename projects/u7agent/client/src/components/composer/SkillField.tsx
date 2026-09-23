import { cn } from "../../lib/cn";
import {
  SESSION_SKILL_BODY_NOTE,
  SESSION_SKILL_DISABLED_NOTE,
  SESSION_SKILL_SCOPE_LABEL,
  SESSION_SKILL_UNAVAILABLE_NOTE,
  groupSessionSkills,
  sessionSkillLocation,
  sessionSkillsNotice,
  sessionSkillWarning,
  skillCommandText,
} from "../../lib/sessionSkills";
import type { SessionSkillsState } from "../../hooks/useSessionSkills";
import { RefreshIcon, SkillListIcon } from "../icons";

/**
 * スキル一覧の開閉ボタン。Model / Effort と同じ行に置く (パネルは SkillPanel が入力欄の上へ出す)。
 * 新規チャットでも一覧を出せるため、取得先が判明していればセッションの有無に関わらず押せる。
 */
export function SkillToggle({
  open,
  compact,
  enabled,
  onToggle,
}: {
  open: boolean;
  compact: boolean;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="スキル一覧"
      title={enabled ? "スキル一覧（選択で /skill: を入力）" : SESSION_SKILL_UNAVAILABLE_NOTE}
      disabled={!enabled}
      className={cn(
        "grid shrink-0 cursor-pointer place-items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        compact ? "size-9" : "size-7",
        open
          ? "border-accent/50 bg-accent-wash text-accent-text"
          : "border-line bg-raised text-ink-faint hover:text-ink-soft",
      )}
    >
      <SkillListIcon />
    </button>
  );
}

/**
 * セッションで使えるスキルの一覧 (新規チャットでは作成前の選択で解決したプレビュー)。選択すると
 * 入力欄へ `/skill:<name> ` を挿入するだけで、本文の展開は送信時に BFF が行う (docs/api-sessions.md)。
 */
export function SkillPanel({
  state,
  rootCwd,
  compact,
  landscape,
  onSelect,
  onReload,
}: {
  state: SessionSkillsState;
  /** ワークスペース root の絶対パス (health.cwd)。場所の表示を root 相対にする */
  rootCwd: string;
  compact: boolean;
  landscape: boolean;
  onSelect: (name: string) => void;
  onReload: () => void;
}) {
  const groups = state.status === "ready" ? groupSessionSkills(state.skills) : [];
  const notice = sessionSkillsNotice(state);
  return (
    <section
      aria-label="スキル一覧"
      className={cn(
        "grid min-w-0 rounded-lg border border-line bg-soft text-2xs",
        compact ? "gap-1.5 px-2 py-1.5" : "gap-2 px-2.5 py-2",
        landscape ? "grid-cols-2" : "",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">スキル</span>
        {state.status === "ready" && state.projectSkills ? (
          <span className="min-w-0 truncate text-3xs text-ink-ghost">プロジェクトのスキルを含みます</span>
        ) : null}
        <button
          type="button"
          onClick={onReload}
          aria-label="スキル一覧を再読み込み"
          title="スキル一覧を再読み込み"
          className="ml-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded-full border border-line text-ink-faint transition-colors hover:border-accent/50 hover:text-accent-text"
        >
          <RefreshIcon />
        </button>
      </div>

      {notice ? <p className={notice.warn ? "text-warn" : "text-ink-faint"}>{notice.text}</p> : null}

      {groups.map((group) => (
        <div key={group.scope} className="grid min-w-0 gap-1">
          <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">
            {group.label}（{group.skills.length}）
          </span>
          <ul className="grid min-w-0 gap-1">
            {group.skills.map((skill) => {
              const warning = sessionSkillWarning(skill, rootCwd);
              return (
                <li key={`${skill.scope}:${skill.name}`} className="min-w-0">
                  <button
                    type="button"
                    // 同名は優先順位で一意に解決されるため、行の識別は名前で足りる
                    aria-label={`${skill.name}（${SESSION_SKILL_SCOPE_LABEL[skill.scope]}）を /skill: として入力`}
                    onClick={() => onSelect(skill.name)}
                    className={cn(
                      "grid w-full min-w-0 cursor-pointer gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors hover:border-accent/50 hover:bg-raised",
                      skill.shadowed ? "border-line/70 bg-transparent opacity-70" : "border-line bg-raised",
                    )}
                  >
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="min-w-0 truncate font-medium text-ink-strong">{skill.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-3xs text-ink-ghost">
                        {skillCommandText(skill.name).trim()}
                      </span>
                    </span>
                    {skill.description ? (
                      <span className="min-w-0 truncate text-3xs text-ink-soft">{skill.description}</span>
                    ) : null}
                    <span className="min-w-0 truncate font-mono text-3xs text-ink-ghost" title={skill.location}>
                      {sessionSkillLocation(skill, rootCwd)}
                    </span>
                    {warning ? <span className="text-3xs text-warn">{warning}</span> : null}
                    {skill.disableModelInvocation ? (
                      <span className="text-3xs text-ink-faint">{SESSION_SKILL_DISABLED_NOTE}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {state.status === "ready" && state.skills.length > 0 ? (
        <p className="text-3xs text-ink-ghost">{SESSION_SKILL_BODY_NOTE}</p>
      ) : null}
    </section>
  );
}
