import type { GenerationInfo } from "../lib/generationInfo";

function ImageKindIcon() {
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

function SpeechKindIcon() {
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

/** 生成物の直下のキャプション。段落の中にも置けるよう span で描く (出さない条件は docs/image-generation.md#生成物のキャプション) */
export function GenerationCaption({ info }: { info: GenerationInfo }) {
  const path = info.path;
  return (
    <span className="mt-1 flex items-center gap-1.5 font-mono text-2xs text-ink-faint">
      {info.kind === "image" ? <ImageKindIcon /> : <SpeechKindIcon />}
      <span title={info.model} className="min-w-0 truncate text-accent-text">
        {info.model}
      </span>
      {info.voice === undefined ? null : (
        <span title={`ボイス ${info.voice}`} className="min-w-0 truncate">
          ボイス {info.voice}
        </span>
      )}
      {path === undefined ? null : (
        <span title={path} className="min-w-0 truncate">
          {path}
        </span>
      )}
    </span>
  );
}
