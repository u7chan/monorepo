import type { Context } from "hono";
import { assetKindOf, normalizeCwd, normalizeFilePath, type AssetKind } from "./assets";
import type { ConnectionRecord, Store } from "./db";
import { AdminError, UpstreamError } from "./errors";
import type { UpstreamClient } from "./upstream";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_CWD_TTL_MS = 60_000;

export type FilesService = {
  handle: (c: Context, connection: ConnectionRecord, keyId: string, runId: string) => Promise<Response>;
};

/**
 * 実行で参照された生成物を、接続先セッションの cwd 配下に限って返す。
 * 上流の raw / download は root 相対なので、cwd を前置した path で stat してから取得する。
 */
export function createFilesService(options: {
  store: Store;
  upstream: UpstreamClient;
  now: () => number;
  maxBytes?: number;
  maxConcurrent?: number;
  cwdTtlMs?: number;
}): FilesService {
  const { store, upstream, now } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const cwdTtlMs = options.cwdTtlMs ?? DEFAULT_CWD_TTL_MS;
  const cwdCache = new Map<string, { cwd: string; at: number }>();
  const active = new Map<string, number>();

  async function cwdFor(connection: ConnectionRecord): Promise<string> {
    const cached = cwdCache.get(connection.id);

    if (cached && now() - cached.at < cwdTtlMs) {
      return cached.cwd;
    }

    const session = await upstream.readSession(connection);
    const cwd = normalizeCwd(session.cwd);

    // root 自身を cwd にしている接続先は、ワークスペース全体を晒すため対象外にする。
    if (cwd === null) {
      throw new AdminError(403, "file_scope_unavailable");
    }

    cwdCache.set(connection.id, { cwd, at: now() });

    return cwd;
  }

  async function statFile(connection: ConnectionRecord, rootRelative: string, signal: AbortSignal) {
    const stat = await upstream.statFile(connection, rootRelative, signal);

    if (stat.status === 200) {
      if (typeof stat.path !== "string") {
        throw new UpstreamError(502, "upstream_invalid");
      }

      return stat.path;
    }

    if (stat.status === 400) {
      throw new AdminError(400, "invalid_path");
    }

    if (stat.status === 404) {
      throw new AdminError(404, "file_not_found");
    }

    if (stat.status === 502 || stat.status === 503) {
      throw new UpstreamError(502, "upstream_unavailable");
    }

    throw new UpstreamError(502, "upstream_invalid");
  }

  function acquire(connectionId: string): void {
    const count = active.get(connectionId) ?? 0;

    if (count >= maxConcurrent) {
      throw new AdminError(429, "too_many_downloads");
    }

    active.set(connectionId, count + 1);
  }

  function release(connectionId: string): void {
    const count = active.get(connectionId) ?? 0;

    if (count <= 1) {
      active.delete(connectionId);
      return;
    }

    active.set(connectionId, count - 1);
  }

  function downloadResponse(response: Response, kind: AssetKind, statPath: string, releaseSlot: () => void): Response {
    const status = response.status;
    const partial = kind === "image" || kind === "audio";

    if (partial && status === 416) {
      const contentRange = response.headers.get("content-range");
      const acceptRanges = response.headers.get("accept-ranges");
      void response.body?.cancel().catch(() => {});
      releaseSlot();

      const headers = new Headers({
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });

      if (contentRange) headers.set("Content-Range", contentRange);
      if (acceptRanges) headers.set("Accept-Ranges", acceptRanges);

      const body = JSON.stringify({ error: "range_not_satisfiable" });
      headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));

      return new Response(body, { status: 416, headers });
    }

    if (!(status === 200 || (partial && status === 206))) {
      void response.body?.cancel().catch(() => {});
      releaseSlot();
      throw upstreamFailure(status);
    }

    const body = response.body;

    if (!body) {
      releaseSlot();
      throw new UpstreamError(502, "upstream_invalid");
    }

    const declared = declaredSize(response, status);

    if (declared !== null && declared > maxBytes) {
      void body.cancel().catch(() => {});
      releaseSlot();
      throw new AdminError(413, "file_too_large");
    }

    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": contentDisposition(statPath),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });

    copyHeader(response, headers, "content-length");

    if (partial) {
      copyHeader(response, headers, "accept-ranges");

      if (status === 206) {
        copyHeader(response, headers, "content-range");
      }
    }

    return new Response(countedStream(body, maxBytes, releaseSlot), { status, headers });
  }

  return {
    async handle(c, connection, keyId, runId) {
      const run = store.getRun(runId);

      if (!run || run.keyId !== keyId || run.connectionId !== connection.id) {
        throw new AdminError(404, "run_not_found");
      }

      const paths = c.req.queries("path");

      if (paths === undefined) {
        if (run.status !== "completed") {
          throw new AdminError(409, "run_not_completed");
        }

        return c.json({ files: store.getRunAssets(runId) });
      }

      if (paths.length !== 1) {
        throw new AdminError(400, "invalid_path");
      }

      const relative = normalizeFilePath(paths[0] ?? "");

      if (relative === null) {
        throw new AdminError(400, "invalid_path");
      }

      const cwd = await cwdFor(connection);
      const rootRelative = `${cwd}/${relative}`;
      const statPath = await statFile(connection, rootRelative, c.req.raw.signal);

      // cwd の直下だけを許可する。`projects/foo-evil` を `projects/foo` と誤認しない。
      if (!statPath.startsWith(`${cwd}/`)) {
        throw new AdminError(400, "invalid_path");
      }

      const kind = assetKindOf(statPath);

      if (kind === null) {
        throw new AdminError(415, "not_downloadable");
      }

      const range = kind === "image" || kind === "audio" ? (c.req.header("range") ?? null) : null;

      acquire(connection.id);

      let released = false;
      const releaseSlot = () => {
        if (released) return;

        released = true;
        release(connection.id);
      };

      try {
        const response =
          kind === "image" || kind === "audio"
            ? await upstream.fetchRaw(connection, statPath, range, c.req.raw.signal)
            : await upstream.fetchDownload(connection, statPath, c.req.raw.signal);

        return downloadResponse(response, kind, statPath, releaseSlot);
      } catch (error) {
        releaseSlot();
        throw error;
      }
    },
  };
}

function upstreamFailure(status: number): AdminError | UpstreamError {
  if (status === 400) return new AdminError(400, "invalid_path");
  if (status === 404) return new AdminError(404, "file_not_found");
  if (status === 413) return new AdminError(413, "file_too_large");
  if (status === 502 || status === 503) return new UpstreamError(502, "upstream_unavailable");

  return new UpstreamError(502, "upstream_invalid");
}

function declaredSize(response: Response, status: number): number | null {
  if (status === 206) {
    const match = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");

    if (match?.[1]) {
      return Number(match[1]);
    }
  }

  const length = response.headers.get("content-length");

  return length !== null && /^\d+$/.test(length) ? Number(length) : null;
}

function copyHeader(from: Response, to: Headers, name: string): void {
  const value = from.headers.get(name);

  if (value !== null) {
    to.set(name, value);
  }
}

function contentDisposition(path: string): string {
  const name = path.split("/").pop() || "file";
  const ascii = name.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_");

  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`;
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 上流の本文をそのまま流し、上限を超えたら切断する。ヘッダー送出後の超過は status を変えられないため、
 * クライアントには途中までの応答として見える。
 */
function countedStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  releaseSlot: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  let done = false;

  const finish = () => {
    if (done) return;

    done = true;
    releaseSlot();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();

        if (result.done || !result.value) {
          finish();
          controller.close();
          return;
        }

        received += result.value.byteLength;

        if (received > maxBytes) {
          finish();
          void reader.cancel().catch(() => {});
          controller.error(new Error("file_too_large"));
          return;
        }

        controller.enqueue(result.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },

    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}
