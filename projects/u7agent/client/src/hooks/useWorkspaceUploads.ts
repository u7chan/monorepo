import { useCallback, useEffect, useRef, useState } from "react";
import { uploadWorkspaceFile } from "../api";
import { planUploads, runTaskPool, UPLOAD_CONCURRENCY } from "../lib/fileUpload";

export type WorkspaceUploadStatus = "queued" | "uploading" | "done" | "error";

export type WorkspaceUploadTask = {
  id: string;
  name: string;
  size: number;
  status: WorkspaceUploadStatus;
  /** 同名があったときに連番で保存された実際の名前 (done) */
  savedName?: string;
  renamed?: boolean;
  /** 失敗 / 拒否の理由 */
  error?: string;
};

export type WorkspaceUploads = {
  tasks: WorkspaceUploadTask[];
  /** 待機中または送信中がある */
  busy: boolean;
  start: (files: readonly File[]) => void;
  /** 決着済みの行だけ消す (送信中は残す) */
  dismiss: () => void;
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 設定 → ファイル のドラッグ＆ドロップの実行キュー。同時数 (`UPLOAD_CONCURRENCY`) と件数 / サイズの検査は
 * `lib/fileUpload.ts` が正で、ここは状態遷移と API 呼び出しだけを持つ。一覧の再取得は 1 回のドロップ
 * （待機中に別のドロップが足された分も含む）がすべて決着してから 1 回だけ呼び、アップロードごとの再取得で
 * ツリーをちらつかせない。
 */
export function useWorkspaceUploads(options: {
  /** 保存先の root 相対 (\"\" はワークスペース root) */
  dir: string;
  /** 1 バッチの決着後、成功が 1 件以上あるときだけ呼ぶ */
  onUploaded: () => void;
}): WorkspaceUploads {
  const [tasks, setTasks] = useState<WorkspaceUploadTask[]>([]);
  const dirRef = useRef(options.dir);
  dirRef.current = options.dir;
  const onUploadedRef = useRef(options.onUploaded);
  onUploadedRef.current = options.onUploaded;
  const pendingRef = useRef(new Map<string, { file: File; dir: string }>());
  const queueRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const activePoolRef = useRef(false);
  const uploadedRef = useRef(false);
  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const drainRef = useRef<() => void>(() => {});

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const updateTask = useCallback((id: string, patch: Partial<WorkspaceUploadTask>) => {
    if (!mountedRef.current) return;
    setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, ...patch } : task)));
  }, []);

  const processTask = useCallback(
    async (id: string) => {
      const pending = pendingRef.current.get(id);
      if (!pending) return;
      updateTask(id, { status: "uploading" });
      const signal = controllerRef.current?.signal;
      try {
        const uploaded = await uploadWorkspaceFile(pending.dir, pending.file, signal);
        pendingRef.current.delete(id);
        uploadedRef.current = true;
        updateTask(id, {
          status: "done",
          savedName: uploaded.name,
          renamed: uploaded.renamed,
        });
      } catch (error) {
        pendingRef.current.delete(id);
        // unmount / ページ離脱による中断は失敗として見せない
        if (signal?.aborted) return;
        updateTask(id, { status: "error", error: messageFor(error) });
      }
    },
    [updateTask],
  );

  const drain = useCallback(() => {
    if (activePoolRef.current) return;
    activePoolRef.current = true;
    const batch = queueRef.current.splice(0);
    void runTaskPool(batch, UPLOAD_CONCURRENCY, processTask).finally(() => {
      activePoolRef.current = false;
      // 待機中に足された分は、同じ 1 本の pool に続けて渡す (同時数を超えない)
      if (queueRef.current.length > 0) {
        drainRef.current();
        return;
      }
      const uploaded = uploadedRef.current;
      uploadedRef.current = false;
      if (uploaded && mountedRef.current) onUploadedRef.current();
    });
  }, [processTask]);
  useEffect(() => {
    drainRef.current = drain;
  }, [drain]);

  const start = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    if (controllerRef.current === null || controllerRef.current.signal.aborted) {
      controllerRef.current = new AbortController();
    }
    const dir = dirRef.current;
    const plan = planUploads(files);
    const added: WorkspaceUploadTask[] = [];
    for (const file of plan.accepted) {
      const id = String((seqRef.current += 1));
      pendingRef.current.set(id, { file, dir });
      queueRef.current.push(id);
      added.push({ id, name: file.name, size: file.size, status: "queued" });
    }
    for (const { file, reason } of plan.rejected) {
      added.push({
        id: String((seqRef.current += 1)),
        name: file.name,
        size: file.size,
        status: "error",
        error: reason,
      });
    }
    if (added.length === 0) return;
    // 前回の成功は今回の結果に混ぜない (一覧の再取得で見えている)。失敗は直すまで残す
    setTasks((prev) => [
      ...prev.filter((task) => task.status === "queued" || task.status === "uploading" || task.status === "error"),
      ...added,
    ]);
    drainRef.current();
  }, []);

  const dismiss = useCallback(() => {
    setTasks((prev) => prev.filter((task) => task.status === "queued" || task.status === "uploading"));
  }, []);

  const busy = tasks.some((task) => task.status === "queued" || task.status === "uploading");
  return { tasks, busy, start, dismiss };
}
