/**
 * クリックしたファイル参照を開くかの判定。字面の採否 (`fileRef.ts`) と違い、こちらは開く経路の責務で、
 * サンドボックスへ実在を確認してから面を開く。確認と面を開く処理は注入で受ける (markdown 層へ API を持ち込まない)。
 */
import type { FileRefTarget } from "./fileRef";
import { fileTreeFetchPath } from "./fileTree";

/** 存在確認の結果。開くのは `exists` だけ */
export type FileRefCheck = "exists" | FileRefFailure;
/** 開かない理由。不存在と、拒否・確認不能を区別する */
export type FileRefFailure = "missing" | "refused" | "unavailable";

/**
 * 確認 API の失敗 status を分類する。404 だけを不存在とし、400 (不正入力・root 外・通常ファイル以外) を
 * 実在の確認として扱わない。502 / 503 / 通信失敗 (status 0) は確認不能で、**不存在とは混同しない**。
 */
export function classifyFileRefFailure(status: number): FileRefFailure {
  if (status === 404) return "missing";
  if (status === 400) return "refused";
  return "unavailable";
}

const FAILURE_MESSAGES: Record<FileRefFailure, string> = {
  missing: "ファイルが見つかりません",
  refused: "このパスは開けません",
  unavailable: "ファイルを確認できませんでした。もう一度お試しください",
};

/** クリックした箇所へ出す失敗理由。面に合った文言にする (共通スキルなどの別の面へ誘導しない) */
export function fileRefFailureMessage(failure: FileRefFailure): string {
  return FAILURE_MESSAGES[failure];
}

/**
 * 参照の座標を確認 API の path (ワークスペース root 相対) へ写す。スキル面の root はワークスペース
 * root 相対なので、面の座標をそのまま連結できる。
 */
export function fileRefCheckPath(target: FileRefTarget, cwd: string): string {
  return target.kind === "skill" ? `${target.root}/${target.path}` : fileTreeFetchPath(cwd, target.path);
}

/** クリック時に控えるセッション選択。switchSeq は切替のたびに進み、同じ ID へ戻っても戻らない */
export type FileRefSelection = { sessionId: string; switchSeq: number };

/** クリック 1 回の結果。`discarded` は後続のクリックやセッション切替で捨てた結果 (呼び出し元は何も出さない) */
export type FileRefOpenOutcome = { kind: "opened" } | { kind: "failed"; message: string } | { kind: "discarded" };

/**
 * クリックごとに世代を進め、**最後のクリックの結果だけを適用する** opener を作る。確認は面の切替・要求の
 * 登録より前に完了させ、実在を確認できたときだけ `open` を呼ぶ。確認中に選択中セッションが切り替わった
 * 結果も失効させる (要求は開いた時点の選択中セッションへ登録するため、遅い結果が新しいセッションへ混ざらない)。
 * 判定は切替世代で行う: 開始時と完了時の ID を比べると、切替をまたいで同じ ID へ戻ったときに失効が
 * 巻き戻る。opener は App の存続期間で 1 つに固定する前提で、作り直すと世代が戻る。
 */
export function createFileRefOpener(deps: {
  check: (target: FileRefTarget) => Promise<FileRefCheck>;
  /** 実在を確認できた参照だけを開く (面のモード切替 / パネル / 要求の登録) */
  open: (target: FileRefTarget) => void;
  /** 現在のセッション選択。クリック時に控え、確認の完了時に切替世代の一致を要求する */
  selection: () => FileRefSelection;
}): { open: (target: FileRefTarget) => Promise<FileRefOpenOutcome> } {
  let generation = 0;
  return {
    async open(target: FileRefTarget): Promise<FileRefOpenOutcome> {
      const click = (generation += 1);
      const selection = deps.selection();
      const check = await deps.check(target).catch((): FileRefCheck => "unavailable");
      // 後続のクリックと、確認中のセッション切替で結果を捨てる (切替世代は不可逆に進む)
      if (click !== generation || selection.switchSeq !== deps.selection().switchSeq) return { kind: "discarded" };
      // セッション未確定の要求は登録できないので開かない
      if (selection.sessionId === "") return { kind: "discarded" };
      if (check !== "exists") return { kind: "failed", message: fileRefFailureMessage(check) };
      deps.open(target);
      return { kind: "opened" };
    },
  };
}
