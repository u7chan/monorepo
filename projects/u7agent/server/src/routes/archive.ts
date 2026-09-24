import type { Context } from "hono";
import type { ArchiveSettings } from "../archive-settings";
import type { UpdateArchiveSettingsBody } from "../schema";

/**
 * アーカイブの除外名。3 ルートとも GET と同じ形（実効値と `overridden` を含む）を返し、
 * 画面が保存 / 既定に戻すの直後に新しい一覧をそのまま反映できるようにする。
 */
export function createArchiveRoutes({ archiveSettings }: { archiveSettings: ArchiveSettings }) {
  return {
    get: (c: Context) => c.json(archiveSettings.response()),

    update: (c: Context, body: UpdateArchiveSettingsBody) => c.json(archiveSettings.save(body.excludeNames)),

    reset: (c: Context) => c.json(archiveSettings.reset()),
  };
}
