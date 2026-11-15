import type { ReactNode } from "react";
import { useFileDropTarget } from "../../hooks/useFileDropTarget";
import { cn } from "../../lib/cn";
import { UPLOAD_LIMIT_NOTE } from "../../lib/fileUpload";
import { UploadIcon } from "../icons";

export type FileDropZoneProps = {
  /** ドロップされたファイル (OS から運ばれたものだけ) を受け取る */
  onFiles: (files: File[]) => void;
  /** オーバーレイに出す保存先などの補足 */
  hint: string;
  children: ReactNode;
  /** 外装のレイアウト (グリッド / 高さ) は呼び出し側が持つ */
  className?: string;
};

/**
 * 設定 → ファイル と作業環境（作業フォルダ）のドラッグ＆ドロップ面。PC のブラウザーでファイルを掴んでいる間だけ、
 * 面全体に破線のドロップゾーンを重ねる。タッチ端末には drag イベントが無いため、モバイル向けの
 * 操作は持たない (docs/file-upload.md)。社内の「行を入力欄へ参照」ドラッグは `Files` を含まないので通さない。
 */
export function FileDropZone({ onFiles, hint, children, className }: FileDropZoneProps) {
  const { active, handlers } = useFileDropTarget({ onFiles });

  return (
    <div className={cn("relative", className)} {...handlers}>
      {children}
      {active ? (
        // ポインターを透過させ、下のツリーへドロップさせたままオーバーレイだけを見せる
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-base/80 p-4">
          <div className="grid max-w-sm justify-items-center gap-1.5 rounded-2xl border-2 border-dashed border-accent/70 bg-raised/95 px-6 py-8 text-center shadow-panel">
            <UploadIcon />
            <p className="text-sm font-semibold text-ink-strong">ここにドロップしてアップロード</p>
            <p className="text-2xs text-ink-muted">{hint}</p>
            <p className="text-2xs text-ink-ghost">{UPLOAD_LIMIT_NOTE}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
