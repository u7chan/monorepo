import type { Context } from "hono";
import type { UpdateSharedContentExclusionsBody } from "../schema";
import type { SharedContentExclusions } from "../shared-content-exclusions";

/**
 * 共有の除外名。3 ルートとも GET と同じ形（実効値と `overridden` を含む）を返し、
 * 画面が保存 / 既定に戻すの直後に新しい一覧をそのまま反映できるようにする。
 */
export function createSharedContentExclusionsRoutes({
  sharedContentExclusions,
}: {
  sharedContentExclusions: SharedContentExclusions;
}) {
  return {
    get: (c: Context) => c.json(sharedContentExclusions.response()),

    update: (c: Context, body: UpdateSharedContentExclusionsBody) =>
      c.json(sharedContentExclusions.save(body.excludeNames)),

    reset: (c: Context) => c.json(sharedContentExclusions.reset()),
  };
}
