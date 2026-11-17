/**
 * 同梱のプリセットアイコン。`icon` には `preset:<id>` を保存し、表示先はこの一覧で解決する。
 * 画像は 256×256 WebP を `client/public/agent-icons/` に置く (`docs/api-catalog.md#エージェント定義のアイコン`)。
 */
export const AGENT_PRESETS = [
  { id: "bot-mint", label: "ミント", src: "/agent-icons/bot-mint.webp" },
  { id: "bot-sakura", label: "サクラ", src: "/agent-icons/bot-sakura.webp" },
  { id: "bot-amber", label: "アンバー", src: "/agent-icons/bot-amber.webp" },
  { id: "bot-aqua", label: "アクア", src: "/agent-icons/bot-aqua.webp" },
  { id: "bot-lavender", label: "ラベンダー", src: "/agent-icons/bot-lavender.webp" },
  { id: "bot-coral", label: "コーラル", src: "/agent-icons/bot-coral.webp" },
  { id: "bot-silver", label: "シルバー", src: "/agent-icons/bot-silver.webp" },
  { id: "bot-chocolate", label: "チョコ", src: "/agent-icons/bot-chocolate.webp" },
] as const;

export type AgentPreset = (typeof AGENT_PRESETS)[number];

/**
 * `preset:<id>` から同梱アイコンを引く。未対応の id は undefined を返し、表示側は星へ落とす
 * (サーバーは id の形だけを見るため、古いバックアップの未知 id もここで吸収する)。
 */
export function agentPresetOf(icon: string | undefined): AgentPreset | undefined {
  if (!icon?.startsWith("preset:")) return undefined;
  const id = icon.slice("preset:".length);
  return AGENT_PRESETS.find((preset) => preset.id === id);
}

/** 保存する `preset:<id>` を作る。選択 UI と表示解決で同じ値を使う */
export function agentPresetValue(preset: AgentPreset): string {
  return `preset:${preset.id}`;
}
