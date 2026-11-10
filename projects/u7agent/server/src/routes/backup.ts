/**
 * 設定 → バックアップ (`/settings/backup`) の API。外側 ZIP の生 body は `bodyGuard` より前に受け、
 * サイズを監視しながら private な一時ディレクトリへ落としてから service へ渡す (docs/backup.md)。
 */
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { BACKUP_MAX_BYTES } from "../backup/format";
import type { BackupService } from "../backup/service";
import { messageFor, sandboxFailureStatus, statusCodeOf } from "../http";

/** 生 body の読み取り中の上限制御。`content-length` が無い / 嘘でも実際のバイト数で止める */
function sizeLimit(): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > BACKUP_MAX_BYTES) {
        callback(
          Object.assign(new Error(`Backup archive is too large (max ${BACKUP_MAX_BYTES} bytes)`), { statusCode: 413 }),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function failure(c: Context, error: unknown) {
  const status = statusCodeOf(error) ?? sandboxFailureStatus(error);
  const code = (error as { code?: unknown }).code;
  // DB の 503 は app.ts の onError に渡し、変更系の `state: "not_stored"` を 1 箇所で付ける
  if (status === 503 && code === undefined) throw error;
  const plan = (error as { plan?: unknown }).plan;
  return c.json(
    {
      error: messageFor(error),
      ...(typeof code === "string" ? { code } : {}),
      ...(plan === undefined ? {} : { plan }),
    },
    status as ContentfulStatusCode,
  );
}

export function createBackupRoutes({ backup }: { backup: BackupService }) {
  return {
    /** 書き出す対象の件数と見積り。dry-run import はしない軽い見積り */
    exportCheck: async (c: Context) => {
      try {
        return c.json(await backup.exportCheck(c.req.queries("targets")));
      } catch (error) {
        return failure(c, error);
      }
    },

    /** バックアップ ZIP。保存名は日付 (UTC) で決める */
    exportZip: async (c: Context) => {
      try {
        const { body, fileName } = await backup.exportZip(c.req.queries("targets"));
        return c.body(body, 200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
      } catch (error) {
        return failure(c, error);
      }
    },

    /**
     * 復元。raw の ZIP を受けるため `bodyGuard` より前に登録する。`dryRun=true` は何も変更しない。
     * 受信は private dir へ spool し、成功・失敗・abort のいずれでも消す。
     */
    restore: async (c: Context) => {
      const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > BACKUP_MAX_BYTES) {
        return c.json({ error: `Backup archive is too large (max ${BACKUP_MAX_BYTES} bytes)` }, 413);
      }
      if (!c.req.raw.body) return c.json({ error: "Request body is required" }, 400);
      const dir = await mkdtemp(join(tmpdir(), "u7agent-backup-"));
      const path = join(dir, "backup.zip");
      try {
        await chmod(dir, 0o700);
        await pipeline(
          Readable.fromWeb(c.req.raw.body as Parameters<typeof Readable.fromWeb>[0]),
          sizeLimit(),
          createWriteStream(path, { mode: 0o600 }),
          { signal: c.req.raw.signal },
        );
        const dryRun = c.req.queries("dryRun")?.includes("true") ?? false;
        const result = await backup.restore({ path, dir, targets: c.req.queries("targets"), dryRun });
        return c.json(result);
      } catch (error) {
        return failure(c, error);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    /** 定義の全削除。ユーザー定義エージェント / 自作プロンプト / 共通スキルだけを消す */
    reset: async (c: Context) => {
      try {
        return c.json(await backup.reset());
      } catch (error) {
        return failure(c, error);
      }
    },
  } as const;
}
