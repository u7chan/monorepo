/**
 * 生成物の種類の印。キャプションとターンのバッジで同じ見た目にするため、寸法と色まで 1 か所に持つ
 * (置いた側の文字色を継承させると、caption の text-ink-faint とバッジの枠とで色が食い違う)。
 */
export function ImageKindIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3 shrink-0 text-accent-text"
    >
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" />
      <circle cx="5.65" cy="6.4" r="1" />
      <path d="M3 11.9 6.35 8.6c.3-.3.78-.3 1.08 0L11 12.1" />
    </svg>
  );
}

export function SpeechKindIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3 shrink-0 text-accent-text"
    >
      <path d="M3.25 6.25h2L8.5 3.5v9l-3.25-2.75h-2z" />
      <path d="M11 6.2c.75.9.75 2.7 0 3.6" />
    </svg>
  );
}
