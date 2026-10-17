import { useCallback, useEffect, useReducer, useState } from "react";
import {
  createFileSkill,
  deleteFileSkill,
  getFileSkillDeletePreview,
  getFileSkillDetail,
  getFileSkills,
  saveFileSkill,
} from "../api";
import {
  fileSkillCreateDirty,
  fileSkillDraftDirty,
  fileSkillSaveInput,
  reduceFileSkillEditor,
  type FileSkillDraft,
  type FileSkillEditorState,
} from "../lib/fileSkillEditor";
import type { FileSkillInfo, SandboxSkillDeletePreview } from "../types";
import { createRequestGate } from "./requestGate";

/** 読み取り専用の一覧なので、状態は「読み込み中 / 取得済み / 失敗」の 3 つだけ持つ */
export type FileSkillsState =
  | { status: "loading" }
  | { status: "ready"; skills: FileSkillInfo[] }
  | { status: "error"; message: string };

/** 保存 / 作成 / 削除の結果。競合 (409) は conflict で区別し、UI が下書きを残す判断に使う */
export type FileSkillResult = { ok: true; relativePath: string } | { ok: false; message: string; conflict: boolean };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConflict(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 409;
}

/**
 * 共通スキル (`.agents/skills`) の一覧・編集内容・下書きをまとめて持つ。取得は種類ごとの requestGate で
 * 世代管理し、遅い応答が別の対象へ混ざらないようにする。保存後は一覧を取り直し、編集内容も取り直す。
 */
export function useFileSkills(): {
  state: FileSkillsState;
  reload: () => void;
  editor: FileSkillEditorState;
  openDetail: (relativePath: string) => void;
  startEdit: () => void;
  startCreate: () => void;
  setDraft: (patch: Partial<FileSkillDraft>) => void;
  cancelEdit: () => void;
  save: () => Promise<FileSkillResult>;
  /** 取消の確認に使う。編集 / 新規の下書きが取得した内容から変わっているか */
  dirty: (editor: FileSkillEditorState) => boolean;
  previewDelete: (relativePath: string) => Promise<SandboxSkillDeletePreview>;
  remove: (relativePath: string, treeVersion: string) => Promise<FileSkillResult>;
} {
  const [state, setState] = useState<FileSkillsState>({ status: "loading" });
  const [beginFileSkillsRequest] = useState(createRequestGate);
  const [beginDetailRequest] = useState(createRequestGate);
  const [editor, dispatch] = useReducer(reduceFileSkillEditor, { status: "none" } as FileSkillEditorState);

  const load = useCallback(async () => {
    const canApply = beginFileSkillsRequest();
    setState({ status: "loading" });
    try {
      const { skills } = await getFileSkills();
      if (canApply()) setState({ status: "ready", skills });
    } catch (error) {
      if (canApply()) setState({ status: "error", message: errorText(error) });
    }
  }, [beginFileSkillsRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  /** 編集内容を取り直す。適用するのは最後の要求の応答だけ (対象を切り替えたら古い応答は捨てる) */
  const loadDetail = useCallback(
    async (relativePath: string) => {
      const canApply = beginDetailRequest();
      dispatch({ type: "open", relativePath });
      try {
        const detail = await getFileSkillDetail(relativePath);
        if (canApply()) dispatch({ type: "loaded", relativePath, detail });
      } catch (error) {
        if (canApply()) dispatch({ type: "failed", message: errorText(error) });
      }
    },
    [beginDetailRequest],
  );

  const openDetail = useCallback(
    (relativePath: string) => {
      void loadDetail(relativePath);
    },
    [loadDetail],
  );

  const save = useCallback(async (): Promise<FileSkillResult> => {
    const input = fileSkillSaveInput(editor);
    if (!input) return { ok: false, message: "保存できる対象がありません", conflict: false };
    if (input.kind === "save") {
      const draft = input.draft;
      try {
        const result = await saveFileSkill({
          relativePath: input.relativePath,
          fileVersion: input.fileVersion,
          description: draft.description,
          body: draft.body,
        });
        await load();
        // 保存後の内容 (新しい fileVersion) を取り直して閲覧へ戻す。取得に失敗しても保存は成功している
        try {
          const detail = await getFileSkillDetail(result.relativePath);
          dispatch({ type: "saved", detail });
        } catch {
          dispatch({ type: "open", relativePath: result.relativePath });
          await loadDetail(result.relativePath);
        }
        return { ok: true, relativePath: result.relativePath };
      } catch (error) {
        if (isConflict(error)) dispatch({ type: "conflict" });
        return { ok: false, message: errorText(error), conflict: isConflict(error) };
      }
    }
    try {
      const created = await createFileSkill({
        name: input.draft.name,
        description: input.draft.description,
        body: input.draft.body,
      });
      await load();
      await loadDetail(created.relativePath);
      return { ok: true, relativePath: created.relativePath };
    } catch (error) {
      dispatch({ type: "createFailed", message: errorText(error) });
      return { ok: false, message: errorText(error), conflict: isConflict(error) };
    }
  }, [editor, load, loadDetail]);

  const dirty = useCallback((editorState: FileSkillEditorState): boolean => {
    if (editorState.status === "edit") return fileSkillDraftDirty(editorState.draft, editorState.detail);
    if (editorState.status === "create") return fileSkillCreateDirty(editorState.draft);
    return false;
  }, []);

  const previewDelete = useCallback((relativePath: string) => getFileSkillDeletePreview(relativePath), []);

  const remove = useCallback(
    async (relativePath: string, treeVersion: string): Promise<FileSkillResult> => {
      try {
        await deleteFileSkill(relativePath, treeVersion);
        await load();
        dispatch({ type: "close" });
        return { ok: true, relativePath };
      } catch (error) {
        return { ok: false, message: errorText(error), conflict: isConflict(error) };
      }
    },
    [load],
  );

  return {
    state,
    reload,
    editor,
    openDetail,
    startEdit: () => dispatch({ type: "startEdit" }),
    startCreate: () => dispatch({ type: "startCreate" }),
    setDraft: (patch) => dispatch({ type: "draft", patch }),
    cancelEdit: () => dispatch({ type: "cancelEdit" }),
    save,
    dirty,
    previewDelete,
    remove,
  };
}
