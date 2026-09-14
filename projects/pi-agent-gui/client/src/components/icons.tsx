export function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="size-4"
    >
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="size-3.5"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function ArrowLeftIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d="M12.5 8H3.75" />
      <path d="M7.25 3.75 3 8l4.25 4.25" />
    </svg>
  );
}

export function ImportIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d="M8 2.5v6.25" />
      <path d="M5.5 6.25 8 8.75l2.5-2.5" />
      <path d="M2.75 10v2.25c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V10" />
    </svg>
  );
}

export function ExportIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d="M8 8.75V2.5" />
      <path d="M5.5 5 8 2.5 10.5 5" />
      <path d="M2.75 10v2.25c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V10" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.28.67 4.48 1.83L14 5.33" />
      <path d="M14 2v3.33h-3.33" />
    </svg>
  );
}

/** 項目の追加 (文字の「＋」はベースラインが揃わないため図形で描く) */
export function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="size-3.5 shrink-0"
    >
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d="M2.75 4.5h10.5" />
      <path d="M6.5 4.5V3.25c0-.41.34-.75.75-.75h1.5c.41 0 .75.34.75.75V4.5" />
      <path d="M4.25 4.5l.62 8.04c.04.51.47.9.98.9h4.3c.51 0 .94-.39.98-.9L11.75 4.5" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d="M3.5 8.5 6.75 11.5 12.5 4.75" />
    </svg>
  );
}

export function SlidersIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M2.75 4.75h10.5M2.75 11.25h10.5" />
      <circle cx="6" cy="4.75" r="1.6" />
      <circle cx="10.5" cy="11.25" r="1.6" />
    </svg>
  );
}

/**
 * 設定 (歯車の絵文字はフォント差で字形と大きさが変わるため図形で描く)
 *
 * 外周 1 本は 6 枚歯の輪郭 (中心 (8, 8) / 歯先 r 6.7 / 歯底 r 5)。8 枚歯は 14px では線が密になり歯車に見えない。
 * 中心の穴は r 2。これ未満だと 14px (DPR 1) で穴が線に埋もれて点に見える。
 */
export function GearIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
    >
      <path d="M9.71 3.3 9.51 1.47 6.49 1.47 6.29 3.3 4.79 4.17 3.1 3.43 1.59 6.04 3.08 7.13 3.08 8.87 1.59 9.96 3.1 12.57 4.79 11.83 6.29 12.7 6.49 14.53 9.51 14.53 9.71 12.7 11.21 11.83 12.9 12.57 14.41 9.96 12.92 8.87 12.92 7.13 14.41 6.04 12.9 3.43 11.21 4.17Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** ツリーの展開 (開いているときは親側で回転させる) */
export function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="M6.25 4.25L10 8l-3.75 3.75" />
    </svg>
  );
}

/** 折りたたみ (details/summary) の開閉。開いた状態の回転は CSS (.tool-disclosure) が持つ */
export function DisclosureChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="tool-disclosure size-3 shrink-0"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      <path d="M2.5 5.5c0-.6.4-1 1-1h2.35c.29 0 .56.12.75.34l.78.92h4.12c.6 0 1 .4 1 1v4.24c0 .6-.4 1-1 1h-8c-.6 0-1-.4-1-1z" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      <path d="M4.25 2.75h4.9l2.6 2.6v7.9h-7.5z" />
      <path d="M9.15 2.75v2.6h2.6" />
    </svg>
  );
}
