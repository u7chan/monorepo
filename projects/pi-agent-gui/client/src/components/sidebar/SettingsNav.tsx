import { SETTINGS_SECTIONS, type SettingsSection, type SidebarMode } from "../../lib/settingsNav";
import { ArrowLeftIcon, ChevronIcon } from "../icons";

export function SettingsNav({
  activeSettingsSection,
  onSelectMode,
  onOpenSettingsSection,
}: {
  activeSettingsSection: SettingsSection;
  onSelectMode: (mode: SidebarMode) => void;
  onOpenSettingsSection: (section: SettingsSection) => void;
}) {
  return (
    <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-2 overflow-y-auto pr-0.5">
      <button
        type="button"
        onClick={() => onSelectMode("nav")}
        className="flex min-h-10 w-full items-center gap-1.5 rounded-lg border border-line px-3 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:bg-hover hover:text-accent-text"
      >
        <ArrowLeftIcon />
        アプリに戻る
      </button>
      <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-ink-faint">設定</div>
      {SETTINGS_SECTIONS.map((item) => {
        const active = item.section === activeSettingsSection;
        return (
          <button
            key={item.section}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onOpenSettingsSection(item.section)}
            className={[
              "flex min-h-10 w-full items-center gap-2 rounded-lg border px-3 text-xs transition-colors",
              active
                ? "border-accent/35 bg-accent-wash text-accent-text"
                : "border-line bg-soft text-ink hover:border-accent/50 hover:bg-hover hover:text-accent-text",
            ].join(" ")}
          >
            <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
            <span className="text-ink-faint">
              <ChevronIcon />
            </span>
          </button>
        );
      })}
    </div>
  );
}
