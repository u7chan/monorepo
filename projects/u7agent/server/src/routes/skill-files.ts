/**
 * 共通ファイルスキル (`<root>/.agents/skills`) の GUI 編集 API。一覧 (`GET /api/skills/files`) は
 * 既存の読み取り専用経路のまま (catalog のルート)、ここは編集内容・作成・保存・削除確認・削除を扱う。
 * パス・版・スキルとしての検証はサンドボックス側で完結させ、BFF は応答の形を検証してそのまま返す。
 */
import type { Context } from "hono";
import { sandboxFailure, sandboxNotConfigured } from "../http";
import {
  SandboxSkillCreateResultSchema,
  SandboxSkillDeletePreviewSchema,
  SandboxSkillFileDetailSchema,
  SandboxSkillSaveResultSchema,
  type CreateFileSkillBody,
  type SaveFileSkillBody,
} from "../schema";
import type { SandboxSkillFileClient } from "../sandbox/client";

export function createSkillFileRoutes({ sandbox }: { sandbox: SandboxSkillFileClient | null }) {
  return {
    /** 編集内容の取得。保存可否と理由もここで返す (読み取り専用の表示は一覧を使う) */
    detail: async (c: Context) => {
      if (!sandbox) return sandboxNotConfigured(c);
      const relativePath = c.req.query("relativePath") ?? "";
      if (!relativePath) return c.json({ error: "relativePath is required" }, 400);
      try {
        const parsed = SandboxSkillFileDetailSchema.safeParse(await sandbox.getSkillFile(relativePath));
        if (!parsed.success) return c.json({ error: "サンドボックスのスキル応答が不正です" }, 502);
        return c.json(parsed.data);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },

    /** 作成。新規パスはサンドボックスが組み立て、既存ディレクトリ / 同名は 409 を透過する */
    create: async (c: Context, body: CreateFileSkillBody) => {
      if (!sandbox) return sandboxNotConfigured(c);
      try {
        const parsed = SandboxSkillCreateResultSchema.safeParse(await sandbox.createSkillFile(body));
        if (!parsed.success) return c.json({ error: "サンドボックスのスキル応答が不正です" }, 502);
        return c.json(parsed.data, 201);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },

    /** 保存。name は受け付けず、fileVersion の一致を要求する (不一致は 409) */
    save: async (c: Context, body: SaveFileSkillBody) => {
      if (!sandbox) return sandboxNotConfigured(c);
      try {
        const parsed = SandboxSkillSaveResultSchema.safeParse(await sandbox.saveSkillFile(body));
        if (!parsed.success) return c.json({ error: "サンドボックスのスキル応答が不正です" }, 502);
        return c.json(parsed.data);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },

    /** 削除確認。何も変更せず、対象フォルダ・付随ファイル・treeVersion を返す */
    deletePreview: async (c: Context) => {
      if (!sandbox) return sandboxNotConfigured(c);
      const relativePath = c.req.query("relativePath") ?? "";
      if (!relativePath) return c.json({ error: "relativePath is required" }, 400);
      try {
        const parsed = SandboxSkillDeletePreviewSchema.safeParse(await sandbox.previewSkillDelete(relativePath));
        if (!parsed.success) return c.json({ error: "サンドボックスのスキル応答が不正です" }, 502);
        return c.json(parsed.data);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },

    /** 削除。body は使わずクエリだけで渡す (既存の DELETE と同じ流儀)。成功は本文なしの 204 */
    remove: async (c: Context) => {
      if (!sandbox) return sandboxNotConfigured(c);
      const relativePath = c.req.query("relativePath") ?? "";
      const treeVersion = c.req.query("treeVersion") ?? "";
      if (!relativePath || !treeVersion) return c.json({ error: "relativePath and treeVersion are required" }, 400);
      try {
        await sandbox.deleteSkillFolder(relativePath, treeVersion);
        return c.body(null, 204);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },
  } as const;
}
