import type { ReactNode } from "react";
import { SETTINGS_SECTIONS, type SettingsSection, type SidebarMode } from "../../lib/settingsNav";
import { MenuItem } from "../MenuItem";
import { ArrowLeftIcon, BoltIcon, FolderIcon, GaugeIcon, SparkleIcon, ThemeIcon } from "../icons";

/** セクションの印。文字だけでは並びの違いが読み取りにくいので行の左に置く */
const SECTION_ICONS: Record<SettingsSection, ReactNode> = {
  agents: <SparkleIcon />,
  skills: <BoltIcon />,
  files: <FolderIcon />,
  appearance: <ThemeIcon />,
  runtime: <GaugeIcon />,
};

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
    // 行間は gap-1 に一本化し、見出しだけ padding で上を広く取る (実効で上 24 / 下 10)
    <div className="grid min-h-0 flex-1 scrollbar-thin content-start gap-1 overflow-y-auto pr-0.5">
      <MenuItem variant="nav" icon={<ArrowLeftIcon />} label="アプリに戻る" onClick={() => onSelectMode("nav")} />
      <div className="px-2 pt-5 pb-1.5 text-2xs font-semibold tracking-widest text-ink-faint uppercase">設定</div>
      {SETTINGS_SECTIONS.map((item) => (
        <MenuItem
          key={item.section}
          variant="nav"
          icon={SECTION_ICONS[item.section]}
          label={item.label}
          selected={item.section === activeSettingsSection}
          current="page"
          onClick={() => onOpenSettingsSection(item.section)}
        />
      ))}
    </div>
  );
}
