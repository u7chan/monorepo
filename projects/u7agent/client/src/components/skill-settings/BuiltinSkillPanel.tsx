import { BUILTIN_SKILL_OVERRIDE_NOTE, BUILTIN_SKILL_READONLY_NOTE } from "../../lib/fileSkills";
import type { FileSkillInfo } from "../../types";

/**
 * 組み込みスキルの本文ビュー。アプリに同梱されていて編集・削除できないため、編集フォームの代わりに
 * 何が同梱されているか (パス / 版 / 本文) と、上書き状態を出す (docs/api-catalog.md)。
 */
export function BuiltinSkillPanel({ skill, variant }: { skill: FileSkillInfo; variant: "page" | "sheet" }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3">
        <div className="mx-auto grid max-w-5xl content-start gap-2.5">
          {variant === "page" ? (
            <div>
              <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">SKILL</div>
              <h3 className="text-sm font-semibold text-ink-strong">組み込みスキル</h3>
            </div>
          ) : null}
          <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-2.5 py-2">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">名前</div>
            <div className="text-xs text-ink-strong">{skill.name}</div>
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">説明</div>
            <div className="text-xs text-ink-soft">{skill.description || "説明なし"}</div>
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">置き場</div>
            <code className="text-2xs break-all text-ink-soft">{skill.relativePath}</code>
            {skill.version ? (
              <>
                <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">版</div>
                <div className="text-xs text-ink-soft">{skill.version}</div>
              </>
            ) : null}
            {skill.overridden ? <p className="text-2xs leading-4 text-warn">{BUILTIN_SKILL_OVERRIDE_NOTE}</p> : null}
          </div>
          <p className="text-1xs leading-relaxed text-ink-muted">{BUILTIN_SKILL_READONLY_NOTE}</p>
          <pre className="scrollbar-thin overflow-x-hidden overflow-y-visible rounded-lg border border-line bg-soft px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-soft select-text">
            {skill.body ?? ""}
          </pre>
        </div>
      </div>
    </section>
  );
}
