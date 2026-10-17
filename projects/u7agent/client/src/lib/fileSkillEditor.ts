/**
 * 共通スキル (`.agents/skills`) の編集面の状態遷移。どの操作を許すか・下書きを残すか・対象を切り替えるかを
 * ここ 1 箇所へ閉じ、GUI の部品は結果を描画するだけにする (docs/ui-layout.md)。
 */
import type { SandboxSkillFileDetail } from "../types";

/** フォームが持つ値。name を変えられるのは新規作成のときだけ (既存の改名は扱わない) */
export interface FileSkillDraft {
  name: string;
  description: string;
  body: string;
}

export type FileSkillEditorState =
  /** 何も選んでいない */
  | { status: "none" }
  /** 編集内容を取得中。対象は 1 つだけ持つ (古い応答は適用しない) */
  | { status: "loading"; relativePath: string }
  /** 閲覧 (読み取り専用のファイルもここ。保存できない理由は detail.reason にある) */
  | { status: "view"; relativePath: string; detail: SandboxSkillFileDetail }
  /** 既存スキルの編集中。conflict は保存が 409 で止まった状態 (下書きは保持する) */
  | { status: "edit"; relativePath: string; detail: SandboxSkillFileDetail; draft: FileSkillDraft; conflict: boolean }
  /** 新規作成。閲覧ビューを持たない (パスはサーバーが決める) */
  | { status: "create"; draft: FileSkillDraft; notice: string | null }
  /** 取得に失敗した。対象を特定できるときだけ relativePath を持つ */
  | { status: "error"; relativePath?: string; message: string };

export type FileSkillEditorAction =
  /** 閲覧を開く (同じ対象の押し直しも含む。下書きは破棄する) */
  | { type: "open"; relativePath: string }
  /** relativePath は要求した対象。取得の途中で選択が変わった応答を適用しないための照合に使う */
  | { type: "loaded"; relativePath: string; detail: SandboxSkillFileDetail }
  | { type: "failed"; message: string }
  /** view → edit (draft を detail から作り直す) */
  | { type: "startEdit" }
  /** 新規作成のフォームへ */
  | { type: "startCreate" }
  | { type: "draft"; patch: Partial<FileSkillDraft> }
  /** 保存 / 作成が成功して、新しい内容を viewer へ戻す */
  | { type: "saved"; detail: SandboxSkillFileDetail }
  /** 保存が版の不一致で止まった (下書きを残したまま conflict を立てる) */
  | { type: "conflict" }
  /** 作成が同名などで止まった (フォームと draft は残す) */
  | { type: "createFailed"; message: string }
  /** 編集を破棄して閲覧へ戻る (取消。何も書き換えない) */
  | { type: "cancelEdit" }
  /** 選択を解除する */
  | { type: "close" };

const EMPTY_DRAFT: FileSkillDraft = { name: "", description: "", body: "" };

/** 渡した内容から新しい下書きを作る (name は既存では表示のみなので値だけ引き継ぐ) */
export function fileSkillDraftOf(detail: SandboxSkillFileDetail): FileSkillDraft {
  return { name: detail.name, description: detail.description, body: detail.body };
}

/** 新規作成の初期値。name だけ入力し、説明と本文は空から始める */
export function newFileSkillDraft(): FileSkillDraft {
  return { ...EMPTY_DRAFT };
}

/** 下書きが取得した内容から変わっているか (取消の確認に使う) */
export function fileSkillDraftDirty(draft: FileSkillDraft, detail: SandboxSkillFileDetail): boolean {
  return draft.description !== detail.description || draft.body !== detail.body;
}

/** 新規フォームが入力済みか (空のフォームを閉じるときに確認を出さない) */
export function fileSkillCreateDirty(draft: FileSkillDraft): boolean {
  return draft.name !== "" || draft.description !== "" || draft.body !== "";
}

/** 編集面が保存要求を出せる状態か (閲覧 / 取得中 / 失敗では保存しない) */
export function fileSkillSaveInput(
  state: FileSkillEditorState,
):
  | { kind: "save"; relativePath: string; fileVersion: string; draft: FileSkillDraft }
  | { kind: "create"; draft: FileSkillDraft }
  | null {
  if (state.status === "edit") {
    return {
      kind: "save",
      relativePath: state.relativePath,
      fileVersion: state.detail.fileVersion,
      draft: state.draft,
    };
  }
  if (state.status === "create") return { kind: "create", draft: state.draft };
  return null;
}

export function reduceFileSkillEditor(
  state: FileSkillEditorState,
  action: FileSkillEditorAction,
): FileSkillEditorState {
  switch (action.type) {
    case "open":
      // 対象を切り替えたら前の下書きは捨てる (古い本文が別の対象へ混ざらない)
      if (state.status === "view" && state.relativePath === action.relativePath) {
        return { status: "loading", relativePath: action.relativePath };
      }
      return { status: "loading", relativePath: action.relativePath };
    case "loaded":
      // 取得中の対象だけを反映する (取得の途中で選択が変わった応答は古い本文なので無視する)
      if (state.status !== "loading" || state.relativePath !== action.relativePath) return state;
      return { status: "view", relativePath: state.relativePath, detail: action.detail };
    case "failed":
      if (state.status !== "loading") return state;
      return { status: "error", relativePath: state.relativePath, message: action.message };
    case "startEdit":
      if (state.status !== "view") return state;
      return {
        status: "edit",
        relativePath: state.relativePath,
        detail: state.detail,
        draft: fileSkillDraftOf(state.detail),
        conflict: false,
      };
    case "startCreate":
      return { status: "create", draft: newFileSkillDraft(), notice: null };
    case "draft":
      if (state.status === "edit") return { ...state, draft: { ...state.draft, ...action.patch } };
      if (state.status === "create") return { ...state, draft: { ...state.draft, ...action.patch }, notice: null };
      return state;
    case "saved":
      return { status: "view", relativePath: action.detail.relativePath, detail: action.detail };
    case "conflict":
      // 下書きはそのまま残し、再読み込みを促す (強制上書きは作らない)
      if (state.status !== "edit") return state;
      return { ...state, conflict: true };
    case "createFailed":
      if (state.status !== "create") return state;
      return { ...state, notice: action.message };
    case "cancelEdit":
      if (state.status === "edit") return { status: "view", relativePath: state.relativePath, detail: state.detail };
      // 新規は閲覧ビューを持たないので選択を解除する (取消は何も書き換えない)
      if (state.status === "create") return { status: "none" };
      return state;
    case "close":
      return { status: "none" };
  }
}
