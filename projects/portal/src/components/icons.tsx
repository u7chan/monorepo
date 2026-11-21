// 共通アイコン。24px グリッド・線幅 1.75 に揃え、隣の文字と太さが釣り合うようにする。
// 意味は必ず隣のラベルか aria-label が持つため、すべて装飾 (aria-hidden) として描く。

import type { ReactNode } from "react";

interface IconProps {
  className?: string;
}

function Icon({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-5"}
    >
      {children}
    </svg>
  );
}

export function LockIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </Icon>
  );
}

export function ArrowUpRightIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M7.5 16.5 16.5 7.5" />
      <path d="M9 7.5h7.5V15" />
    </Icon>
  );
}

export function SlidersIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M4 7h8M18 7h2" />
      <circle cx="15" cy="7" r="2.25" />
      <path d="M4 12h2M12 12h8" />
      <circle cx="9" cy="12" r="2.25" />
      <path d="M4 17h8M18 17h2" />
      <circle cx="15" cy="17" r="2.25" />
    </Icon>
  );
}

export function GridIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.75" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.75" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.75" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.75" />
    </Icon>
  );
}

export function ListIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M9.5 7H20M9.5 12H20M9.5 17H20" />
      <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" strokeWidth="2.5" />
    </Icon>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" />
    </Icon>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className ?? "size-4"}
    >
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className ?? "size-4"}
    >
      <rect x="6" y="6" width="12" height="12" rx="2.75" />
    </svg>
  );
}

export function DeployIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 16V5" />
      <path d="m7.5 9.5 4.5-4.5 4.5 4.5" />
      <path d="M5 19.5h14" />
    </Icon>
  );
}

export function ChevronUpDownIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m8 9.5 4-4 4 4" />
      <path d="m8 14.5 4 4 4-4" />
    </Icon>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m7 7 10 10M17 7 7 17" />
    </Icon>
  );
}

export function WarningIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 4.5 3.5 19h17L12 4.5Z" />
      <path d="M12 10v4.5M12 17.25h.01" />
    </Icon>
  );
}

export function TrayIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M4 13.5 6.5 6h11l2.5 7.5V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4.5Z" />
      <path d="M4 13.5h4a1.5 1.5 0 0 1 1.5 1.5 2.5 2.5 0 0 0 5 0 1.5 1.5 0 0 1 1.5-1.5h4" />
    </Icon>
  );
}
