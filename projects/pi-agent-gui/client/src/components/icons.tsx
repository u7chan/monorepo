/** モバイルのコンパクト UI 用アイコン (ChatArea と違い、複数コンポーネントで共有する) */

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

/** Model / Effort の設定トグル */
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

/** ファイルツリーのディレクトリ */
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

/** ファイルツリーのファイル */
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
