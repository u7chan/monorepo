import type { FileSkillsState } from "../../hooks/useFileSkills";
import {
  BUILTIN_SKILL_OVERRIDE_NOTE,
  FILE_SKILL_EMPTY_NOTE,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_GROUP_LABEL,
  FILE_SKILL_LOADING_NOTE,
  groupFileSkills,
} from "../../lib/fileSkills";
import { TOOL_CATALOG_UNAVAILABLE_NOTE, TOOL_GROUP_LABELS, groupTools, unavailableToolNote } from "../../lib/tools";
import type { AgentDef, BuiltinSkillInfo, ToolCatalogEntry } from "../../types";
import { InvocationModeRow } from "./InvocationModeRow";
import { BUILTIN_SECTION_LABEL } from "./SkillSelector";
import { SkillGroup, SkillRow } from "./SkillRow";

/** 見出しの右に出す断り。スイッチを出さない理由をここで伝える */
export const BUILTIN_PANEL_SKILLS_READONLY_LABEL = "このエージェントでは変更できません";
/**
 * 読み取り専用のスキル節の注記。ビルトインは許可リストを持たない (未指定 = 全部 ON) ので、
 * 外す導線の代わりに規則と置き場を説明する。
 */
export const BUILTIN_PANEL_SKILLS_NOTE =
  "ビルトインは外す設定を持たないため、共通スキルと組み込みスキルは常にすべて使用されます。共通スキルはワークスペース直下の .agents/skills にあり、増減してもこの画面を開き直せば反映されます。プロジェクトのスキル（会話の作業ディレクトリ配下の .agents/skills）は会話ごとに決まり、この画面には出ません。";
/** ツール節の断り。ビルトインは `toolNames` を持たないので、ここでもスイッチは出さない */
export const BUILTIN_PANEL_TOOLS_READONLY_LABEL = "このエージェントでは外せません";
/** ビルトインは自然文では発火しない (定義側も false)。行の OFF と合わせて理由をここで伝える */
export const BUILTIN_PANEL_INVOCATION_FIXED_NOTE = "ビルトインは常に OFF です（自然文では発火しません）。";

/**
 * ビルトインはサーバー所有で編集も削除もできないので、
 * 編集フォームの代わりに、何が固定されているかをここで説明する。
 * 面の作り (見出し + 罫線 + パネル) は編集フォームと同じにし、操作だけを出さない。
 */
export function BuiltinAgentPanel({
  agent,
  builtinSkills,
  tools,
  fileSkills,
}: {
  agent: AgentDef;
  /** アプリ同梱の組み込みスキル。カタログ応答に載るので、サンドボックス未設定でも出せる */
  builtinSkills: BuiltinSkillInfo[];
  /** アプリが公開しているツールの一覧。実効の可否つき (空は取得できていない) */
  tools: ToolCatalogEntry[];
  /** 共通スキル (`.agents/skills`) の取得状態。取得できるまでは組み込みだけを出す */
  fileSkills: FileSkillsState;
}) {
  // 一覧 API は共通 (user) と組み込みだけを返すので、組み込みを除いた側がそのまま共通スキル
  const commonSkills = fileSkills.status === "ready" ? groupFileSkills(fileSkills.skills).common : [];
  // 同名の共通スキルに負けた組み込みは SDK へ渡らない (server/src/file-skills.ts の overridden)。
  // 上書きは一覧を取れたときだけ分かるので、未取得の間は registry の全件を使用中として出す
  const overriddenBuiltins = new Set(
    fileSkills.status === "ready"
      ? groupFileSkills(fileSkills.skills)
          .builtin.filter((skill) => skill.overridden)
          .map((skill) => skill.name)
      : [],
  );
  const usedBuiltinCount = builtinSkills.filter((skill) => !overriddenBuiltins.has(skill.name)).length;
  // ビルトインは常に OFF。値が無い旧 API でも ON に倒さない (サーバー側も id で false に固定する)
  const allowNaturalInvocation = agent.allowNaturalInvocation === true;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3">
        <div className="@container">
          <div className="mx-auto grid max-w-3xl content-start gap-3">
            <section className="grid gap-2">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">プロフィール</h3>
              <dl className="grid gap-2 @2xl:grid-cols-2">
                <div className="grid gap-1">
                  <dt className="text-2xs text-ink-faint">名前</dt>
                  <dd className="text-xs break-words text-ink-strong">{agent.name}</dd>
                </div>
                <div className="grid gap-1">
                  <dt className="text-2xs text-ink-faint">説明</dt>
                  <dd className="text-xs break-words text-ink-soft">{agent.description || "説明なし"}</dd>
                </div>
              </dl>
            </section>
            <hr className="border-line" />
            <section className="grid gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">スキル</h3>
                <span className="shrink-0 text-2xs text-ink-faint">{BUILTIN_PANEL_SKILLS_READONLY_LABEL}</span>
              </div>
              <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2">
                <InvocationModeRow allowNaturalInvocation={allowNaturalInvocation} readOnly />
                <p className="text-2xs leading-4 break-words text-ink-faint">{BUILTIN_PANEL_INVOCATION_FIXED_NOTE}</p>
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
                  <SkillGroup
                    label={FILE_SKILL_GROUP_LABEL}
                    countText={`使用 ${commonSkills.length} / 全 ${commonSkills.length}`}
                  >
                    {commonSkills.length === 0 ? (
                      <p className="px-2.5 text-2xs leading-4 break-words text-ink-faint">{FILE_SKILL_EMPTY_NOTE}</p>
                    ) : (
                      commonSkills.map((skill) => (
                        <SkillRow
                          key={skill.path}
                          name={skill.name}
                          description={skill.description || ""}
                          // モデルが自分からは起動しないというスキル側の性質。外す設定が無いので状態だけを出す
                          badge={skill.disableModelInvocation ? "自動起動なし" : undefined}
                        />
                      ))
                    )}
                  </SkillGroup>
                ) : null}
                {builtinSkills.length > 0 ? (
                  <SkillGroup
                    divider={fileSkills.status === "ready"}
                    label={BUILTIN_SECTION_LABEL}
                    countText={`使用 ${usedBuiltinCount} / 全 ${builtinSkills.length}`}
                  >
                    {builtinSkills.map((skill) => (
                      <SkillRow
                        key={skill.name}
                        name={skill.name}
                        description={skill.description || ""}
                        badge={`v${skill.version}`}
                        hint={overriddenBuiltins.has(skill.name) ? BUILTIN_SKILL_OVERRIDE_NOTE : undefined}
                      />
                    ))}
                  </SkillGroup>
                ) : null}
                <p className="border-t border-line pt-2 text-2xs leading-4 break-words text-ink-faint">
                  {BUILTIN_PANEL_SKILLS_NOTE}
                </p>
              </div>
            </section>
            <hr className="border-line" />
            <section className="grid gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">ツール</h3>
                <span className="shrink-0 text-2xs text-ink-faint">{BUILTIN_PANEL_TOOLS_READONLY_LABEL}</span>
              </div>
              <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2">
                {tools.length === 0 ? (
                  <p className="text-2xs leading-4 break-words text-warn">{TOOL_CATALOG_UNAVAILABLE_NOTE}</p>
                ) : (
                  groupTools(tools).map((entry, index) => (
                    <SkillGroup
                      key={entry.group}
                      divider={index > 0}
                      label={TOOL_GROUP_LABELS[entry.group]}
                      countText={`使用 ${entry.tools.length} / 全 ${entry.tools.length}`}
                    >
                      {entry.tools.map((tool) => (
                        <SkillRow
                          key={tool.name}
                          name={tool.name}
                          description={tool.description}
                          monoName
                          // アプリ側で無効なものは使用の有無に関係なく使えないので、理由を行に出す
                          hint={unavailableToolNote(tool.reason)}
                        />
                      ))}
                    </SkillGroup>
                  ))
                )}
              </div>
            </section>
            <p className="text-1xs leading-relaxed text-ink-muted">
              このエージェントはビルトインのため編集・削除できません。新しい会話の既定として常に 1 体用意され、モデルと
              Effort はアプリ既定に従います。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
