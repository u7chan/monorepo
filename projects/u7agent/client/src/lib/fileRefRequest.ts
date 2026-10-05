/**
 * 「ファイル参照からプレビューを開く」要求。未消費は 1 件だけ持ち、最新優先で置き換える。
 * 寿命は選択中セッションの滞在期間に限るため、破棄は選択が変わる経路 (useSessions) が呼ぶ。
 * 面は自分宛ての種別 (作業フォルダ / スキル) の要求だけを適用する。
 */
import type { FileRefTarget } from "./fileRef";

export type FileRefRequest = {
  /** 単調増加で再利用しない。適用済みの印と ack の照合に使う */
  seq: number;
  /** 要求を作ったときの選択中セッション。現在の選択と一致するときだけ子へ渡す */
  sessionId: string;
  /** 面の種別。作業フォルダ面とスキル面が同じ要求を取り合わないための印 */
  kind: FileRefTarget["kind"];
  /** スキル面の root (ワークスペース root 相対)。作業フォルダ面の要求は持たない */
  root?: string;
  /** 面の root 相対のパス */
  path: string;
};

/** 面のモード。作業フォルダ面 (既定) とスキル面 (root 固定) の 2 つ */
export type FilesMode = { kind: "work" } | { kind: "skill"; root: string };

/** 面を既定 (作業フォルダ) へ戻す値。閉じる導線 / セッション切替 / 画面の移動で使う */
export const DEFAULT_FILES_MODE: FilesMode = { kind: "work" };

export function createFileRefRequests() {
  let seq = 0;
  let pending: FileRefRequest | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    /** useSyncExternalStore の購読 */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** useSyncExternalStore の snapshot。未消費が無い間は同じ null を返す */
    snapshot(): FileRefRequest | null {
      return pending;
    },
    /** 未消費の要求を置き換える (最新優先)。セッションが未確定の要求は捨てる */
    request(sessionId: string, target: FileRefTarget): void {
      if (sessionId === "") return;
      const next = (seq += 1);
      pending =
        target.kind === "skill"
          ? { seq: next, sessionId, kind: "skill", root: target.root, path: target.path }
          : { seq: next, sessionId, kind: "work", path: target.path };
      notify();
    },
    /** 適用済みの seq を返す。現在の要求と一致するときだけ消す (古い ack で新しい要求を消さない) */
    ack(appliedSeq: number): void {
      if (pending === null || pending.seq !== appliedSeq) return;
      pending = null;
      notify();
    },
    /** 選択の変更で破棄する (同じセッションに戻っても復活させない) */
    clear(): void {
      if (pending === null) return;
      pending = null;
      notify();
    },
  };
}

/** 選択中セッションの要求だけを子へ渡す (同一プロジェクトの別セッションは cwd が同じでも別扱い) */
export function fileRefRequestForSession(pending: FileRefRequest | null, sessionId: string): FileRefRequest | null {
  return pending !== null && pending.sessionId === sessionId ? pending : null;
}

/** 面に宛てた要求だけを渡す。逆向きの参照は面のモードが先に切り替わるため、相手側は消費しない */
export function fileRefRequestForKind(
  pending: FileRefRequest | null,
  kind: FileRefRequest["kind"],
): FileRefRequest | null {
  return pending !== null && pending.kind === kind ? pending : null;
}

/** 要求の種別から面のモードを決める (モードを切り替えてから、対応する面が要求を消費する) */
export function filesModeForTarget(target: FileRefTarget): FilesMode {
  return target.kind === "skill" ? { kind: "skill", root: target.root } : DEFAULT_FILES_MODE;
}

/**
 * 面のモードを既定へ戻す契機。root (cwd) だけでは同一プロジェクトのセッション切替 / 新規チャットを
 * 拾えないため、選択中セッションの識別子も見る。チャット以外への移動と compact ⇄ desktop の切替も
 * 面が消える (mount が入れ替わる) 契機なので、ここで既定へ戻す。
 */
export type FilesModeScope = { compact: boolean; view: string; sessionId: string };

export function filesModeScopeChanged(prev: FilesModeScope, next: FilesModeScope): boolean {
  return prev.compact !== next.compact || prev.view !== next.view || prev.sessionId !== next.sessionId;
}
