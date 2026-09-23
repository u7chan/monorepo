import { useEffect, useState } from "react";
import { getFilePreview } from "../../api";
import {
  BUILTIN_SKILL_OVERRIDE_NOTE,
  BUILTIN_SKILL_READONLY_NOTE,
  FILE_SKILL_BODY_ERROR_PREFIX,
  FILE_SKILL_BODY_LOADING_NOTE,
  FILE_SKILL_PANEL_HEADING,
  FILE_SKILL_READONLY_NOTE,
} from "../../lib/fileSkills";
import type { FileSkillInfo } from "../../types";

/** 本文の状態。組み込みは一覧の応答に本文が載るため、読み込みを挟まず ready で始まる */
type BodyState = { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 読み取り専用スキル (共通 / プロジェクト / 組み込み) の本文ビュー。編集フォームの代わりに、
 * 何が使われるか (名前 / 説明 / 置き場 / スコープ / 版) と本文を出す。組み込みは一覧の `body` をそのまま使い、
 * ファイルスキルは本文を持たない一覧なので、選択のたびにファイルプレビューから取り直す
 * (docs/api-catalog.md。反映タイミングは本文の取得時点)。
 */
export function ReadOnlySkillPanel({ skill, variant }: { skill: FileSkillInfo; variant: "page" | "sheet" }) {
  const [body, setBody] = useState<BodyState>(() =>
    skill.body === undefined ? { status: "loading" } : { status: "ready", text: skill.body },
  );

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

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3">
        <div className="mx-auto grid max-w-5xl content-start gap-2.5">
          {variant === "page" ? (
            <div>
              <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">SKILL</div>
              <h3 className="text-sm font-semibold text-ink-strong">{FILE_SKILL_PANEL_HEADING[skill.scope]}</h3>
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
          <p className="text-1xs leading-relaxed text-ink-muted">
            {skill.scope === "builtin" ? BUILTIN_SKILL_READONLY_NOTE : FILE_SKILL_READONLY_NOTE}
          </p>
          {body.status === "loading" ? (
            <p className="text-2xs leading-4 text-ink-muted">{FILE_SKILL_BODY_LOADING_NOTE}</p>
          ) : null}
          {body.status === "error" ? (
            <p className="text-2xs leading-4 break-words text-warn">
              {FILE_SKILL_BODY_ERROR_PREFIX}: {body.message}
            </p>
          ) : null}
          {body.status === "ready" ? (
            <pre className="scrollbar-thin overflow-x-hidden overflow-y-visible rounded-lg border border-line bg-soft px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-soft select-text">
              {body.text}
            </pre>
          ) : null}
        </div>
      </div>
    </section>
  );
}
