import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { isFileDrag } from "../lib/fileUpload";

/** ドロップ面へそのまま広げる props。`div` にも `button` にも付く */
export type FileDropHandlers = {
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

export type FileDropTargetOptions = {
  /** OS から運ばれたファイルだけを受け取る */
  onFiles: (files: File[]) => void;
  /** 受け付けない間はハイライトもドロップもしない */
  disabled?: boolean;
};

/**
 * ファイルのドラッグを受け付ける面の状態。`dragenter` は子要素をまたぐたびに入るので
 * enter / leave を数え、面の外へ出たときだけ閉じる。面の外での drop / Escape / blur でも閉じる
 * （docs/file-upload.md）。対象は `Files` を含むドラッグだけで、行を入力欄へ運ぶ社内の参照は通さない。
 */
export function useFileDropTarget({ onFiles, disabled = false }: FileDropTargetOptions): {
  active: boolean;
  handlers: FileDropHandlers;
} {
  const [active, setActive] = useState(false);
  const depthRef = useRef(0);
  const reset = useCallback(() => {
    depthRef.current = 0;
    setActive(false);
  }, []);

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

  const hasFiles = (event: DragEvent<HTMLElement>) => isFileDrag(Array.from(event.dataTransfer.types));

  const handlers: FileDropHandlers = {
    onDragEnter: (event) => {
      if (disabled || !hasFiles(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      setActive(true);
    },
    onDragOver: (event) => {
      if (disabled || !hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      // types が空になるブラウザーでも閉じられるよう、leave では Files の判定をやり直さない
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setActive(false);
    },
    onDrop: (event) => {
      const files = Array.from(event.dataTransfer.files);
      if (!hasFiles(event) && files.length === 0) return;
      // 受け付けない間も既定の動作は止める。止めないと画像を開いて画面ごと離れる
      event.preventDefault();
      reset();
      if (disabled || files.length === 0) return;
      onFiles(files);
    },
  };

  return { active, handlers };
}
