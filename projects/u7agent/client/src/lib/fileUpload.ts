/**
 * 設定 → ファイル と作業環境（作業フォルダ）のドラッグ＆ドロップ。受け付ける件数・サイズと、
 * 同時に送る本数を 1 箇所で決める。DOM に依存しない純関数だけを置き、画面と hook はここが返す値を使う。
 */

/** 1 回のドロップで受け付ける件数。チャットの添付（MAX_ATTACHMENTS）と同じ 10 件に揃える */
export const UPLOAD_MAX_FILES = 10;
/** 1 ファイルの上限。サンドボックスの `SANDBOX_MAX_UPLOAD_BYTES` と同じ 100 MiB */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const UPLOAD_MAX_LABEL = "100 MiB";
/** 同時に送る本数。回線・サンドボックスの書き込み・一覧の再取得を飽和させない値 */
export const UPLOAD_CONCURRENCY = 3;

export const UPLOAD_LIMIT_NOTE = `最大 ${UPLOAD_MAX_FILES} 件・1 ファイル ${UPLOAD_MAX_LABEL} まで`;

export type UploadCandidate = {
  /** 保存名の検証に使う。ブラウザーの File もこの 2 つだけで判定できる */
  name: string;
  size: number;
};

export type UploadPlan<T extends UploadCandidate> = {
  accepted: T[];
  rejected: Array<{ file: T; reason: string }>;
};

export type UploadTaskStatus = "queued" | "uploading" | "done" | "error";

/**
 * 次のドロップを既存の結果へ足す。キューが動いている間は完了済みも残し（同じバッチの結果を
 * 追加ドロップで消さない）、全件決着後の独立したバッチでは前回成功だけを捨てて失敗を残す。
 */
export function mergeUploadTasks<T extends { status: UploadTaskStatus }>(prev: readonly T[], added: readonly T[]): T[] {
  const continuing = prev.some((task) => task.status === "queued" || task.status === "uploading");
  return [...prev.filter((task) => continuing || task.status === "error"), ...added];
}

/**
 * ドロップされたファイルを、受け付け分と理由つきの拒否分に分ける。大きすぎるファイルは
 * 件数の枠を消費しない（10 件の枠は「保存を試すファイル」に使い、超過分はまとめて理由を出す）。
 */
export function planUploads<T extends UploadCandidate>(files: readonly T[]): UploadPlan<T> {
  const accepted: T[] = [];
  const rejected: UploadPlan<T>["rejected"] = [];
  for (const file of files) {
    if (file.size > UPLOAD_MAX_BYTES) {
      rejected.push({ file, reason: `${UPLOAD_MAX_LABEL} を超えるファイルはアップロードできません` });
      continue;
    }
    if (accepted.length >= UPLOAD_MAX_FILES) {
      rejected.push({ file, reason: `一度にアップロードできるのは最大 ${UPLOAD_MAX_FILES} 件までです` });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejected };
}

/**
 * ドラッグ中の dataTransfer.types が、OS から運ばれたファイルを含むか。ツリーの行を入力欄へ
 * ドラッグする社内の参照（独自 MIME）と区別するために、`Files` の有無だけを見る。
 */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

/**
 * 同時実行数を守って worker を回す。worker が失敗しても残りを続け、全件の決着後に解決する
 * （1 件の拒否で後続を落とさない）。新しい項目はこの関数の外のキューが持ち、呼び出し側が
 * 1 本の pool だけを走らせることで、複数回のドロップでも同時数を超えない。
 */
export async function runTaskPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const running = new Set<Promise<void>>();
  const limit = Math.max(1, Math.floor(concurrency));
  const fill = () => {
    while (running.size < limit && queue.length > 0) {
      const item = queue.shift() as T;
      // worker の同期 throw / reject で pool を止めない (呼び出し側は件数分の結果を tasks に残す)
      const task = Promise.resolve()
        .then(() => worker(item))
        .catch(() => undefined)
        .finally(() => running.delete(task));
      running.add(task);
    }
  };
  fill();
  while (running.size > 0) {
    await Promise.race(running);
    fill();
  }
}
