import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { isFileDrag, UPLOAD_LIMIT_NOTE } from "../../lib/fileUpload";
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
 * 設定 → ファイル のドラッグ＆ドロップ面。PC のブラウザーでファイルを掴んでいる間だけ、
 * 面全体に破線のドロップゾーンを重ねる。タッチ端末には drag イベントが無いため、モバイル向けの
 * 操作は持たない (docs/file-upload.md)。社内の「行を入力欄へ参照」ドラッグは `Files` を含まないので通さない。
 */
export function FileDropZone({ onFiles, hint, children, className }: FileDropZoneProps) {
  const [active, setActive] = useState(false);
  // dragenter は子要素をまたぐたびに入る。enter / leave を数えて、面の外へ出たときだけ閉じる
  const depthRef = useRef(0);
  const reset = useCallback(() => {
    depthRef.current = 0;
    setActive(false);
  }, []);

  // 面の外でドロップした / ドラッグを取り消したときも、オーバーレイを残さない
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") reset();
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, reset]);

  const hasFiles = (event: DragEvent<HTMLDivElement>) => isFileDrag(Array.from(event.dataTransfer.types));

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depthRef.current += 1;
    setActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = () => {
    // types が空になるブラウザーでも閉じられるよう、leave では Files の判定をやり直さない
    // (対象外のドラッグでは depth が 0 のままで、何も起きない)
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (!hasFiles(event) && files.length === 0) return;
    event.preventDefault();
    reset();
    if (files.length > 0) onFiles(files);
  };

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
