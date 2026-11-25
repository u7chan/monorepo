import type { GenerationInfo } from "../lib/generationInfo";
import { ImageKindIcon, SpeechKindIcon } from "./generationKindIcons";

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
