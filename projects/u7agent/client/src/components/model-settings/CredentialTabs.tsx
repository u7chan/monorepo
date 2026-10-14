import { cn } from "../../lib/cn";
import type { CredentialTab, CredentialTabsView } from "../../lib/modelSettings";
import { MetaChip } from "./MetaChip";

/** 進行中 / 失敗の印の色。成功・中断は印を出さず、実効の側の「使用中」で示す */
const MARK_CLASS: Record<"running" | "failed", string> = {
  running: "bg-accent-text",
  failed: "bg-warn",
};

export type CredentialTabsProps = {
  view: CredentialTabsView;
  active: CredentialTab;
  /** タブ行の読み上げ。何の 2 経路かを provider 名で示す */
  providerName: string;
  onSelect: (tab: CredentialTab) => void;
};

/**
 * プロバイダー詳細の認証方法のタブ行。既存の `SettingsTabs` (URL が正) とは別に、この画面の
 * ローカル状態で切り替える。`role` / `aria-label` / `aria-selected` は同じ水準に揃え、
 * `aria-controls` と矢印キーは入れない (入れ子の `role="tablist"` を浅く保つ)。
 */
export function CredentialTabs({ view, active, providerName, onSelect }: CredentialTabsProps) {
  const items: readonly {
    tab: CredentialTab;
    label: string;
    ariaLabel: string;
    inUse: boolean;
    mark: "running" | "failed" | null;
  }[] = [
    { tab: "api_key", label: "APIキー", ariaLabel: view.apiKeyAriaLabel, inUse: view.apiKeyInUse, mark: null },
    {
      tab: "sign_in",
      label: "サインイン",
      ariaLabel: view.signInAriaLabel,
      inUse: view.oauthInUse,
      mark: view.signInMark,
    },
  ];
  return (
    <div role="tablist" aria-label={`${providerName} の認証方法`} className="flex min-w-0 gap-1 border-b border-line">
      {items.map((item) => (
        <button
          key={item.tab}
          type="button"
          role="tab"
          aria-selected={item.tab === active}
          aria-label={item.ariaLabel}
          onClick={() => onSelect(item.tab)}
          className={cn("tab-item flex items-center gap-1.5", item.tab === active && "tab-item-active")}
        >
          {item.label}
          {item.inUse ? <MetaChip tone="ok">使用中</MetaChip> : null}
          {item.mark ? (
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", MARK_CLASS[item.mark])} />
          ) : null}
        </button>
      ))}
    </div>
  );
}
