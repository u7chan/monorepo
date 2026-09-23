import type { ReactNode } from "react";
import type { FileKind } from "../lib/fileKind";

/** 実行中インジケータのドット (中心 8,8 / 半径 4.9 に 45 度ずつ。回転は styles/index.css) */
const SPINNER_DOTS: [number, number][] = [
  [8, 3.1],
  [11.47, 4.53],
  [12.9, 8],
  [11.47, 11.47],
  [8, 12.9],
  [4.53, 11.47],
  [3.1, 8],
  [4.53, 4.53],
];

/** 先頭のドットほど濃くして尾を引かせる (回転方向と揃えるため index の昇順 = 時計回り) */
export function RunSpinnerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="run-spinner size-3 shrink-0 text-ink-soft">
      {SPINNER_DOTS.map(([cx, cy], index) => (
        <circle key={index} cx={cx} cy={cy} r="1.25" fill="currentColor" opacity={1 - index * 0.09} />
      ))}
    </svg>
  );
}

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
      className="size-4 shrink-0"
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
      className="size-4 shrink-0"
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

/** 行のリネームボタンの鉛筆 (削除のゴミ箱と同じ寸法にそろえる) */
export function PencilIcon() {
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
      <path d="M11.25 2.75l2 2-7.5 7.5-2.6.6.6-2.6z" />
      <path d="M9.75 4.25l2 2" />
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
 * 外周 1 本は 6 枚歯の輪郭 (中心 (8, 8) / 歯先 r 6.7 / 歯底 r 5)。8 枚歯は 16px では線が密になり歯車に見えない。
 * 中心の穴は r 2。これ未満だと 16px (DPR 1) で穴が線に埋もれて点に見える。
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
      className="size-4 shrink-0"
    >
      <path d="M9.71 3.3 9.51 1.47 6.49 1.47 6.29 3.3 4.79 4.17 3.1 3.43 1.59 6.04 3.08 7.13 3.08 8.87 1.59 9.96 3.1 12.57 4.79 11.83 6.29 12.7 6.49 14.53 9.51 14.53 9.71 12.7 11.21 11.83 12.9 12.57 14.41 9.96 12.92 8.87 12.92 7.13 14.41 6.04 12.9 3.43 11.21 4.17Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** エージェント (設定ナビ)。エージェントごとの違いは文字で示すので、行の印はこの 1 種類で足りる */
export function SparkleIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      <path d="M8 2.25 9.55 6.45 13.75 8 9.55 9.55 8 13.75 6.45 9.55 2.25 8 6.45 6.45Z" />
    </svg>
  );
}

/** スキル (設定ナビ) */
export function BoltIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      <path d="M9.4 2.5 4.25 8.75h3.1L6.7 13.5l5.05-6.25h-3.1z" />
    </svg>
  );
}

/** チャットのスキル一覧 (入力補助)。行の印は「一覧」で示す (スキルの種類は文字で出る) */
export function SkillListIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      <path d="M5.75 4.25h7.5" />
      <path d="M5.75 8h7.5" />
      <path d="M5.75 11.75h7.5" />
      <path d="M3 4.25h.01" />
      <path d="M3 8h.01" />
      <path d="M3 11.75h.01" />
    </svg>
  );
}

/** 外観 (設定ナビ)。明暗の半円でテーマ切替を表す (この画面の内容はテーマの選択だけ) */
export function ThemeIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4 shrink-0"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path fill="currentColor" stroke="none" d="M8 2.5a5.5 5.5 0 0 1 0 11z" />
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

/**
 * フォルダ (ツリーの行と各所の見出し)。開いているときは手前のパネルを傾けて薄く塗る。
 * 輪郭のままだと展開の印が chevron の回転だけになり、行の左端で開閉が読み取れない。
 */
export function FolderIcon({ open = false }: { open?: boolean }) {
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
      {open ? (
        <>
          <path d="M2.5 11.6V5.5c0-.6.4-1 1-1h2.35c.29 0 .56.12.75.34l.78.92h4.12c.6 0 1 .4 1 1v1.14" />
          <path
            d="M5.15 8.15Q5.4 7.95 5.75 7.95h6.1q.6 0 .65.65l-.7 2.95q-.1.5-.65.5H3.5q-.55 0-.4-.55L4.6 8.6q.15-.45.55-.45Z"
            fill="currentColor"
            fillOpacity="0.2"
          />
        </>
      ) : (
        <path d="M2.5 5.5c0-.6.4-1 1-1h2.35c.29 0 .56.12.75.34l.78.92h4.12c.6 0 1 .4 1 1v4.24c0 .6-.4 1-1 1h-8c-.6 0-1-.4-1-1z" />
      )}
    </svg>
  );
}

/**
 * ファイル種別 (FileKind) の模様。書類の輪郭の中に置くため、16px で潰れない太さと大きさに留める。
 * 括弧類は「角・丸・山」で書き分け、曲線で描くと 16px では塊になるため角を丸めた直線で表す。
 */
const FILE_MARKS: Record<FileKind, ReactNode> = {
  code: (
    <>
      <path d="M7.15 7.25 6.1 9.2l1.05 1.95" />
      <path d="M8.85 7.25 9.9 9.2 8.85 11.15" />
    </>
  ),
  markup: (
    <>
      <path d="M6.4 9.3l1.75-1.75c.2-.2.46-.3.74-.3h.86c.28 0 .5.22.5.5v.86c0 .28-.11.54-.3.74L8.2 11.1c-.4.4-1.05.4-1.45 0l-.35-.35c-.4-.4-.4-1.05 0-1.45z" />
      <circle cx="9.1" cy="8.6" r=".35" />
    </>
  ),
  data: (
    <>
      <path d="M7.4 6.9c-.35 0-.55.25-.55.6v1.05c0 .35-.25.65-.6.65.35 0 .6.3.6.65v1.05c0 .35.2.6.55.6" />
      <path d="M8.6 6.9c.35 0 .55.25.55.6v1.05c0 .35.25.65.6.65-.35 0-.6.3-.6.65v1.05c0 .35-.2.6-.55.6" />
    </>
  ),
  style: <path d="M7 7.3v4M9 7.3v4M6.15 8.35h3.7M6.15 10.25h3.7" />,
  image: (
    <>
      <circle cx="7" cy="8.2" r=".55" />
      <path d="M5.8 11.3l1.9-1.9c.2-.2.52-.2.72 0l1.55 1.55" />
    </>
  ),
  shell: (
    <>
      <path d="M6.35 7.4 7.6 9.3 6.35 11.2" />
      <path d="M8.45 11.2h2.4" />
    </>
  ),
  lock: (
    <>
      <rect x="6.2" y="8.55" width="3.6" height="2.9" rx=".5" />
      <path d="M7.1 8.55v-.85a.9.9 0 0 1 1.8 0v.85" />
    </>
  ),
  text: <path d="M6.15 7.3h3.7M6.15 9.3h3.7M6.15 11.3h2.4" />,
};

/** ツリーのファイル行。模様の種類は `fileKind` が拡張子から決める */
export function FileIcon({ kind = "text" }: { kind?: FileKind }) {
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
      <g strokeWidth="1.2">{FILE_MARKS[kind]}</g>
    </svg>
  );
}

/** バックアップ (蓋付きの箱)。線を増やしすぎず、16px で蓋と本体の 2 面に見える太さに留める */
export function ArchiveIcon() {
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
      <path d="M3 3.25h10c.41 0 .75.34.75.75v1c0 .41-.34.75-.75.75H3c-.41 0-.75-.34-.75-.75V4c0-.41.34-.75.75-.75Z" />
      <path d="M3.5 6.5v5.75c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V6.5" />
      <path d="M6.75 9.25h2.5" />
    </svg>
  );
}
