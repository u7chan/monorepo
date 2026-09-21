import type { AgentDef } from "../../types";

/**
 * ビルトインはサーバー所有で編集も削除もできない (インポートでも差し替わらない) ので、
 * 編集フォームの代わりに、何が固定されているかをここで説明する。
 */
export function BuiltinAgentPanel({ agent, variant }: { agent: AgentDef; variant: "page" | "sheet" }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3">
        <div className="mx-auto grid max-w-5xl content-start gap-2.5">
          {variant === "page" ? (
            <div>
              <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">AGENT</div>
              <h3 className="text-sm font-semibold text-ink-strong">ビルトインエージェント</h3>
            </div>
          ) : null}
          <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-2.5 py-2">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">名前</div>
            <div className="text-xs text-ink-strong">{agent.name}</div>
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">説明</div>
            <div className="text-xs text-ink-soft">{agent.description || "説明なし"}</div>
          </div>
          <p className="text-1xs leading-relaxed text-ink-muted">
            このエージェントはビルトインのため編集・削除できません。新しい会話の既定として常に 1 体用意され、モデルと
            Effort はアプリ既定に従います。
          </p>
        </div>
      </div>
    </section>
  );
}
