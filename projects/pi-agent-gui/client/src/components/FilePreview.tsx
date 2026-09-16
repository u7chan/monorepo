import { useEffect, useState } from "react";
import { getFilePreview } from "../api";

export function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [result, setResult] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    void getFilePreview(path, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setResult(value);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [path]);
  return (
    // min-h-40 は flex 行の最低高さ。低い viewport ではツリー側が縮んでここへ譲る (プレビュー本文が 0 になるのを防ぐ)
    <section aria-label="ファイルプレビュー" className="flex min-h-40 min-w-0 flex-1 flex-col border-t border-line">
      <div className="flex items-center gap-3 px-4 py-2">
        <code className="min-w-0 flex-1 truncate text-xs text-ink" title={path}>
          {path}
        </code>
        <button type="button" className="btn-quiet" onClick={onClose}>
          閉じる
        </button>
      </div>
      {result.error ? (
        <p role="alert" className="px-4 py-2 text-xs text-danger-text">
          {result.error}
        </p>
      ) : result.text === undefined ? (
        <p role="status" className="px-4 py-2 text-xs text-ink-muted">
          読み込み中…
        </p>
      ) : (
        <pre tabIndex={0} className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 py-3 font-mono text-xs text-ink">
          {result.text || "（空のファイル）"}
        </pre>
      )}
    </section>
  );
}
