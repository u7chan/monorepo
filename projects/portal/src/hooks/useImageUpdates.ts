// 稼働中のイメージより新しいビルドが GHCR に届いているかの取得。
// 一覧の更新に合わせて取り直すが、タグはサーバー側でキャッシュされるため
// GHCR を毎回叩くことはない。

import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonBody, readStatusError, requestJson } from "../lib/apiClient";
import type { ImageUpdate } from "../types/container";

export type ImageUpdateMap = ReadonlyMap<string, ImageUpdate>;

function isImageUpdate(value: unknown): value is ImageUpdate {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const update = value as Record<string, unknown>;
  return (
    typeof update.containerId === "string" &&
    typeof update.latestTag === "string" &&
    (update.createdAt === undefined || typeof update.createdAt === "string")
  );
}

export function parseImageUpdates(body: unknown): ImageUpdateMap {
  const updates =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).updates
      : undefined;
  if (!Array.isArray(updates)) {
    return new Map();
  }

  const map = new Map<string, ImageUpdate>();
  for (const update of updates) {
    if (isImageUpdate(update)) {
      map.set(update.containerId, update);
    }
  }
  return map;
}

export function useImageUpdates(refreshInterval = 30000): ImageUpdateMap {
  const [updates, setUpdates] = useState<ImageUpdateMap>(() => new Map());
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = requestId.current + 1;
    requestId.current = id;

    try {
      const body = await requestJson(
        "/api/image-updates",
        (status) => `HTTP error! status: ${status}`,
        { readError: readStatusError, parseOk: readJsonBody },
      );

      // ポーリングが重なると応答の順序が入れ替わる。最後に始めたリクエストの
      // 結果だけを採用し、古い応答で先に消えた New を復活させない。
      if (id === requestId.current) {
        setUpdates(parseImageUpdates(body));
      }
    } catch (error) {
      // 新着の印は補助情報。取れないときは前回の表示を保ち、カードの表示は止めない。
      if (id === requestId.current) {
        console.warn("Failed to fetch image updates:", error);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();

    if (refreshInterval > 0) {
      const interval = setInterval(() => void refresh(), refreshInterval);
      return () => clearInterval(interval);
    }
  }, [refresh, refreshInterval]);

  return updates;
}
